// SPDX-License-Identifier: GPL-2.0-or-later
//! The file commands against scripted dialogs and temp directories. The
//! expected titles, default names, filters and results are those of
//! src/main/file-io.ts.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tempfile::TempDir;

use super::*;

/// Dialogs that answer from `answers` in order (cancelling once they run
/// out) and record every request.
struct Scripted {
    dialogs: Dialogs,
    requests: Arc<Mutex<Vec<DialogRequest>>>,
}

fn scripted(answers: impl IntoIterator<Item = Option<PathBuf>>) -> Scripted {
    let answers = Mutex::new(answers.into_iter().collect::<VecDeque<_>>());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&requests);
    let dialogs = Dialogs::new(move |request| {
        record.lock().unwrap().push(request);
        answers.lock().unwrap().pop_front().flatten()
    });
    Scripted { dialogs, requests }
}

impl Scripted {
    fn requests(&self) -> Vec<DialogRequest> {
        self.requests.lock().unwrap().clone()
    }
}

fn filters(list: &[(&str, &[&str])]) -> Vec<FileFilter> {
    list.iter().map(|(name, extensions)| FileFilter::new(name, extensions)).collect()
}

fn save(title: &str, default_name: &str, filter: Filter) -> DialogRequest {
    DialogRequest {
        kind: DialogKind::SaveFile { default_name: default_name.to_owned() },
        title: title.to_owned(),
        filters: filters(&[filter, ("All Files", &["*"])]),
    }
}

fn saved(path: &Path) -> FileSaveResult {
    FileSaveResult { success: true, file_path: Some(path_text(path)), error: None }
}

type Filter = (&'static str, &'static [&'static str]);

/// A save or an export: its dialog with a name, and its default name
/// without one.
struct Export {
    member: &'static str,
    run: fn(&Dialogs, &str, Option<&str>) -> FileSaveResult,
    title: &'static str,
    named: &'static str,
    unnamed: &'static str,
    filter: Filter,
}

const EXPORTS: &[Export] = &[
    Export {
        member: "saveLayout",
        run: save_layout,
        title: "Export Layout",
        named: "My Board.vil",
        unnamed: "keyboard.vil",
        filter: ("Vial Layout", &["vil"]),
    },
    Export {
        member: "exportKeymapC",
        run: export_keymap_c,
        title: "Export keymap.c",
        named: "My Board_keymap.c",
        unnamed: "keymap.c",
        filter: ("C Source", &["c"]),
    },
    Export {
        member: "exportCsv",
        run: export_csv,
        title: "Export CSV",
        named: "My Board.csv",
        unnamed: "typing-test-history.csv",
        filter: ("CSV", &["csv"]),
    },
    Export {
        member: "exportJson",
        run: export_json,
        title: "Export JSON",
        named: "My Board.json",
        unnamed: "export.json",
        filter: ("JSON", &["json"]),
    },
];

#[test]
fn saves_and_exports_show_their_dialog_and_write_the_content() {
    for &Export { member, run, title, named, unnamed, filter } in EXPORTS {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("out");
        let dialogs = scripted([Some(path.clone()), None, None]);

        assert_eq!(run(&dialogs.dialogs, "content ✓", Some("My Board")), saved(&path), "{member}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "content ✓", "{member}");
        // An empty name is no name.
        run(&dialogs.dialogs, "", Some(""));
        run(&dialogs.dialogs, "", None);

        assert_eq!(
            dialogs.requests(),
            [save(title, named, filter), save(title, unnamed, filter), save(title, unnamed, filter)],
            "{member}"
        );
    }
}

#[test]
fn the_pdf_export_writes_the_decoded_bytes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("keymap.pdf");
    let dialogs = scripted([Some(path.clone()), None]);

    assert_eq!(export_pdf(&dialogs.dialogs, "JVBERi0=", Some("My Board")), saved(&path));
    assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-");
    export_pdf(&dialogs.dialogs, "", None);

    let filter: Filter = ("PDF Document", &["pdf"]);
    assert_eq!(
        dialogs.requests(),
        [save("Export Keymap PDF", "My Board.pdf", filter), save("Export Keymap PDF", "keymap.pdf", filter)]
    );
}

#[test]
fn the_default_name_is_the_cleaned_device_name() {
    let dialogs = scripted([]);
    save_layout(&dialogs.dialogs, "{}", Some(" a/b:c? ..."));
    let [request] = dialogs.requests().try_into().unwrap();
    assert_eq!(request.kind, DialogKind::SaveFile { default_name: "a_b_c_.vil".to_owned() });
}

#[test]
fn a_save_overwrites_the_chosen_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("keyboard.vil");
    std::fs::write(&path, "an older and longer layout").unwrap();
    let dialogs = scripted([Some(path.clone())]);

    assert_eq!(save_layout(&dialogs.dialogs, "{}", None), saved(&path));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
}

#[test]
fn a_cancelled_save_writes_nothing() {
    let dialogs = scripted([None]);
    assert_eq!(save_layout(&dialogs.dialogs, "{}", None), FileSaveResult::failed("cancelled"));
}

#[test]
fn a_failed_write_answers_its_error() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("missing").join("keyboard.vil");
    let dialogs = scripted([Some(path)]);

    let result = save_layout(&dialogs.dialogs, "{}", None);
    assert!(!result.success);
    assert_eq!(result.file_path, None);
    assert!(result.error.is_some_and(|error| !error.is_empty() && error != "cancelled"));
}

fn open(title: &str, filter: Filter) -> DialogRequest {
    DialogRequest {
        kind: DialogKind::OpenFile,
        title: title.to_owned(),
        filters: filters(&[filter, ("All Files", &["*"])]),
    }
}

fn opened(text: &str, path: &Path) -> FileOpenResult {
    FileOpenResult {
        success: true,
        data: Some(text.to_owned()),
        file_path: Some(path_text(path)),
        error: None,
    }
}

#[test]
fn load_layout_reads_the_chosen_file_as_text() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("keyboard.vil");
    std::fs::write(&path, r#"{"uid":"0x1"}"#).unwrap();
    let dialogs = scripted([Some(path.clone())]);

    assert_eq!(load_layout(&dialogs.dialogs, Some("Load"), None), opened(r#"{"uid":"0x1"}"#, &path));
    assert_eq!(dialogs.requests(), [open("Load", ("Vial Layout", &["vil"]))]);
}

#[test]
fn load_layout_filters_by_the_pages_extensions() {
    let dialogs = scripted([]);
    let strings = |list: &[&str]| Some(list.iter().map(|&ext| ext.to_owned()).collect::<Vec<_>>());

    load_layout(&dialogs.dialogs, None, strings(&["pipette"]));
    // As the layout picker passes them; not a .pipette filter by name.
    load_layout(&dialogs.dialogs, None, strings(&[".pipette", ".vil"]));
    for bad in [&[][..], &["a/b"], &["vil", ""], &["x".repeat(17).as_str()], &["vil"; 9]] {
        load_layout(&dialogs.dialogs, None, strings(bad));
    }

    let requests = dialogs.requests();
    assert_eq!(requests[0], open("Import Layout", ("Pipette Layout", &["pipette"])));
    assert_eq!(requests[1], open("Import Layout", ("Vial Layout", &[".pipette", ".vil"])));
    for request in &requests[2..] {
        assert_eq!(*request, open("Import Layout", ("Vial Layout", &["vil"])));
    }
}

#[test]
fn open_dialogs_keep_a_plausible_title_from_the_page_only() {
    let dialogs = scripted([]);
    let long = "x".repeat(MAX_TITLE_CHARS + 1);
    for title in [Some("Import a file"), Some(""), None, Some("a\u{0}b"), Some("a\nb"), Some(long.as_str())] {
        sideload_json(&dialogs.dialogs, title);
    }
    let titles: Vec<String> = dialogs.requests().into_iter().map(|request| request.title).collect();
    let fallback = "Load from JSON file";
    assert_eq!(titles, ["Import a file", "", fallback, fallback, fallback, fallback]);
    assert_eq!(
        dialogs.requests()[0],
        open("Import a file", ("JSON Files", &["json"])),
        "the sideload dialog lists JSON files"
    );
}

#[test]
fn an_open_dialog_reads_invalid_utf8_as_replacement_characters() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("broken.json");
    std::fs::write(&path, b"\xef\xbb\xbf{\"a\":\"\xff\xe3\x81\"}").unwrap();
    let dialogs = scripted([Some(path.clone())]);

    // The BOM stays, as with readFile(path, 'utf-8').
    assert_eq!(sideload_json(&dialogs.dialogs, None), opened("\u{feff}{\"a\":\"\u{fffd}\u{fffd}\"}", &path));
}

#[test]
fn a_cancelled_or_failed_open_answers_its_error() {
    let dir = TempDir::new().unwrap();
    let dialogs = scripted([None, Some(dir.path().join("missing.vil"))]);

    assert_eq!(load_layout(&dialogs.dialogs, None, None), FileOpenResult::failed("cancelled"));
    let result = load_layout(&dialogs.dialogs, None, None);
    assert!(!result.success && result.data.is_none() && result.file_path.is_none());
    assert!(result.error.is_some_and(|error| !error.is_empty() && error != "cancelled"));
}

fn folder() -> DialogRequest {
    DialogRequest { kind: DialogKind::OpenFolder, title: "Export CSV bundle".to_owned(), filters: Vec::new() }
}

#[test]
fn a_csv_bundle_is_written_into_the_chosen_directory() {
    let dir = TempDir::new().unwrap();
    let dialogs = scripted([Some(dir.path().to_path_buf())]);
    let files = json!([
        { "name": "wpm", "content": "a,b\n1,2\n" },
        { "name": "Keys.CSV", "content": "k\n" },
        { "name": "a/b:c", "content": "" },
    ]);

    let result = export_csv_bundle(&dialogs.dialogs, Some(&files));

    let names = ["wpm.csv", "Keys.CSV", "a_b_c.csv"];
    let paths: Vec<String> = names.iter().map(|name| path_text(&dir.path().join(name))).collect();
    assert_eq!(
        result,
        CsvBundleResult {
            success: true,
            dir_path: Some(path_text(dir.path())),
            files: Some(paths),
            error: None
        }
    );
    assert_eq!(std::fs::read_to_string(dir.path().join("wpm.csv")).unwrap(), "a,b\n1,2\n");
    assert_eq!(std::fs::read_to_string(dir.path().join("Keys.CSV")).unwrap(), "k\n");
    assert_eq!(dialogs.requests(), [folder()]);
}

#[test]
fn a_malformed_csv_bundle_answers_before_any_dialog() {
    let dialogs = scripted([]);
    for (files, error) in [
        (None, "no files"),
        (Some(json!(null)), "no files"),
        (Some(json!({})), "no files"),
        (Some(json!([])), "no files"),
        (Some(json!([{ "name": "a", "content": "" }, { "name": "b" }])), "invalid file entry"),
        (Some(json!([{ "name": 1, "content": "" }])), "invalid file entry"),
        (Some(json!(["a"])), "invalid file entry"),
    ] {
        assert_eq!(
            export_csv_bundle(&dialogs.dialogs, files.as_ref()),
            CsvBundleResult::failed(error),
            "{files:?}"
        );
    }
    assert!(dialogs.requests().is_empty());
}

#[test]
fn a_cancelled_csv_bundle_writes_nothing() {
    let dialogs = scripted([None]);
    let files = json!([{ "name": "a", "content": "" }]);
    assert_eq!(export_csv_bundle(&dialogs.dialogs, Some(&files)), CsvBundleResult::failed("cancelled"));
}

#[test]
fn a_failed_csv_write_answers_its_error_and_the_other_files_written() {
    let dir = TempDir::new().unwrap();
    // A directory where the second file would go.
    std::fs::create_dir(dir.path().join("b.csv")).unwrap();
    let dialogs = scripted([Some(dir.path().to_path_buf())]);
    let files = json!([
        { "name": "a", "content": "1" },
        { "name": "b", "content": "2" },
        { "name": "c", "content": "3" },
    ]);

    let result = export_csv_bundle(&dialogs.dialogs, Some(&files));

    assert!(!result.success && result.dir_path.is_none());
    let written = ["a.csv", "c.csv"].map(|name| path_text(&dir.path().join(name)));
    assert_eq!(result.files, Some(written.to_vec()));
    assert!(result.error.is_some_and(|error| !error.is_empty()));
    assert_eq!(std::fs::read_to_string(dir.path().join("c.csv")).unwrap(), "3");
}

#[test]
fn results_carry_only_the_fields_they_have() {
    assert_eq!(
        serde_json::to_value(FileSaveResult::failed("cancelled")).unwrap(),
        json!({ "success": false, "error": "cancelled" })
    );
    assert_eq!(
        serde_json::to_value(opened("{}", Path::new("/tmp/a.json"))).unwrap(),
        json!({ "success": true, "data": "{}", "filePath": "/tmp/a.json" })
    );
    assert_eq!(
        serde_json::to_value(CsvBundleResult::failed("no files")).unwrap(),
        json!({ "success": false, "error": "no files" })
    );
}

#[test]
fn base64_decodes_as_node_buffer_does() {
    // Buffer.from(input, 'base64') in Node.
    for (input, expected) in [
        ("YWJj", &b"abc"[..]),
        ("YWI=", b"ab"),
        ("YWI", b"ab"),
        ("YQ==YQ==", b"a"),
        ("Y W\nJj", b"abc"),
        ("-_8=", &[251, 255]),
        ("+/8=", &[251, 255]),
        ("YQ=x", b"a"),
        ("Y", b""),
        ("YW=Jj", b"a"),
        ("!!YWJj", b"abc"),
        ("YWJjZA", b"abcd"),
        ("YWJjZ", b"abc"),
        ("", b""),
        // The low byte of each UTF-16 code unit: U+0159 reads as `Y`, U+0100
        // as NUL, and U+1F600 as `=` and NUL.
        ("\u{159}Q==", b"a"),
        ("YW\u{100}Jj", b"abc"),
        ("Y\u{e9}WJj", b"abc"),
        ("\u{1f600}YWJj", b""),
    ] {
        assert_eq!(decode_base64_as_node(input), expected, "{input:?}");
    }
}
