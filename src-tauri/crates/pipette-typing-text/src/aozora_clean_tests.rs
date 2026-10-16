// SPDX-License-Identifier: GPL-2.0-or-later
//! The cases of src/main/aozora/__tests__/aozora-clean.test.ts.

use super::*;
use crate::units::utf16;

fn run(step: impl Fn(&[u16]) -> Vec<u16>, input: &str) -> String {
    String::from_utf16_lossy(&step(&utf16(input)))
}

fn clean(input: &str) -> String {
    String::from_utf16_lossy(&clean_aozora_text(&utf16(input)).unwrap_or_default())
}

#[test]
fn remove_header_drops_the_title_block_without_a_legend() {
    assert_eq!(run(remove_header, "タイトル\n著者\n\n本文一行目"), "\n本文一行目");
}

#[test]
fn remove_header_drops_the_title_block_and_the_legend() {
    let rule = "-".repeat(66);
    let input = [
        "タイトル",
        "著者名",
        "",
        &rule,
        "【テキスト中に現れる記号について】",
        "（凡例の中身）",
        &rule,
        "本文",
    ]
    .join("\n");
    assert_eq!(run(remove_header, &input), "\n本文");
}

#[test]
fn remove_header_removes_a_legend_opening_within_the_top_30_lines() {
    let rule = "-".repeat(66);
    let mut lines = vec!["タイトル".to_owned(), "著者名".to_owned(), String::new()];
    lines.extend((0..20).map(|n| format!("前書き{n}行目")));
    lines.extend([rule.clone(), "【テキスト中に現れる記号について】".to_owned(), rule, "本文".to_owned()]);
    let result = run(remove_header, &lines.join("\n"));
    assert!(!result.contains("【テキスト中に現れる記号について】"));
    assert!(result.contains("本文"));
}

#[test]
fn remove_header_keeps_a_dashed_rule_pair_deep_in_the_body() {
    let rule = "-".repeat(66);
    let mut lines = vec!["タイトル".to_owned(), "著者名".to_owned(), String::new()];
    lines.extend((0..40).map(|n| format!("本文{n}行目")));
    lines.extend([rule.clone(), "場面転換".to_owned(), rule, "続きの本文".to_owned()]);
    let result = run(remove_header, &lines.join("\n"));
    assert!(result.contains("場面転換"));
    assert!(result.contains("続きの本文"));
    assert!(result.contains("本文0行目"));
}

#[test]
fn remove_header_scan_window_counts_from_the_top_of_the_file() {
    let rule = "-".repeat(30);
    // Title block of 2 lines + blank: the body line at index 27 is file line 29.
    let mut lines = vec!["T".to_owned(), "A".to_owned()];
    lines.extend((0..27).map(|_| String::new()));
    lines.extend([rule.clone(), "legend".to_owned(), rule.clone(), "body".to_owned()]);
    assert_eq!(run(remove_header, &lines.join("\n")), format!("{}body", "\n".repeat(27)));
    lines.insert(2, String::new());
    assert!(run(remove_header, &lines.join("\n")).contains("legend"));
    // 29 dashes are not a rule.
    assert_eq!(
        run(remove_header, &format!("T\n\n{0}\nx\n{0}\ny", "-".repeat(29))),
        format!("\n{0}\nx\n{0}\ny", "-".repeat(29))
    );
}

#[test]
fn remove_footer_cuts_at_the_colophon() {
    assert_eq!(run(remove_footer, "本文\n底本：「作品集」出版社\n発行日など"), "本文\n");
    assert_eq!(run(remove_footer, "本文\n　底本:出典社\n以下略"), "本文\n");
    let input = "本文のみ、底本情報なし";
    assert_eq!(run(remove_footer, input), input);
}

#[test]
fn remove_footer_cuts_at_the_end_of_body_marker() {
    assert_eq!(run(remove_footer, "本文\n続き［＃本文終わり］\n入力者付記など"), "本文\n");
}

#[test]
fn remove_footer_cuts_at_whichever_marker_comes_first() {
    assert_eq!(run(remove_footer, "本文\n続き［＃本文終わり］\n底本：「作品集」出版社"), "本文\n");
    assert_eq!(run(remove_footer, "本文\n底本：「作品集」出版社\n続き［＃本文終わり］"), "本文\n");
}

#[test]
fn remove_footer_line_starts_include_u2028_but_not_a_mid_line_colophon() {
    assert_eq!(run(remove_footer, "本文\u{2028}底本：x"), "本文\u{2028}");
    assert_eq!(run(remove_footer, "本文 底本：x"), "本文 底本：x");
}

#[test]
fn resolve_warichu_wraps_the_note_in_parens() {
    let step = |text: &[u16]| resolve_warichu(text.to_vec());
    assert_eq!(run(step, "テキスト［＃割り注］注釈内容［＃割り注終わり］続き"), "テキスト（注釈内容）続き");
    assert_eq!(
        run(step, "テキスト［＃割り注］（既に括弧）［＃割り注終わり］続き"),
        "テキスト（既に括弧）続き"
    );
    assert_eq!(run(step, "a［＃割り注］b"), "a［＃割り注］b");
    assert_eq!(run(step, "［＃割り注］（［＃割り注終わり］"), "（（）");
}

#[test]
fn remove_ruby_drops_spans_and_the_ruby_start_marker() {
    assert_eq!(run(remove_ruby, "｜二十世紀《にじっせいき》の話"), "二十世紀の話");
    assert_eq!(run(remove_ruby, "僕《ぼく》は元気"), "僕は元気");
    assert_eq!(run(remove_ruby, "a《b｜c"), "a《bc");
}

#[test]
fn resolve_gaiji_substitutes_the_code_point() {
    let step = |text: &[u16]| resolve_gaiji(text).unwrap_or_default();
    assert_eq!(run(step, "※［＃「はしごだか」、U+9AD9、12-3］橋"), "髙橋");
    assert_eq!(run(step, "前※［＃「にんべん＋并」、第3水準1-14-8］後"), "前後");
    assert_eq!(run(step, "※［＃U+1F600］"), "😀");
    assert_eq!(run(step, "※［＃U+12, U+0041F］"), "\u{41f}");
}

#[test]
fn resolve_gaiji_keeps_a_lone_surrogate_and_rejects_past_u10ffff() {
    assert_eq!(resolve_gaiji(&utf16("※［＃U+D800］")), Ok(vec![0xd800]));
    assert_eq!(resolve_gaiji(&utf16("※［＃U+110000］")), Err(InvalidCodePoint(0x11_0000)));
}

#[test]
fn convert_repeat_marks_converts_the_voiced_mark_first() {
    let step = |text: &[u16]| {
        replace_all(&replace_all(text, &REPEAT_VOICED, &REPEAT_VOICED_TO), &REPEAT, &REPEAT_TO)
    };
    assert_eq!(run(step, "あ／″＼い／＼う"), "あ〴〵い〳〵う");
}

#[test]
fn remove_annotations_strips_nested_annotations() {
    let step = |text: &[u16]| remove_annotations(text.to_vec());
    assert_eq!(run(step, "A［＃foo［＃bar］baz］B"), "AB");
    assert_eq!(run(step, "「会話文だ。」と彼は言った。［＃改ページ］"), "「会話文だ。」と彼は言った。");
    assert_eq!(run(step, "入力［注記ではない］部分"), "入力［注記ではない］部分");
    assert_eq!(run(step, "［＃a［b］］"), "［＃a［b］］");
}

#[test]
fn trim_edges_drops_rule_lines_and_blank_edges() {
    assert_eq!(run(trim_edges, "\n\n-----\n本文\n＝＝＝＝\n続き\n\n"), "本文\n続き");
    assert_eq!(run(trim_edges, " \n\t\n"), "");
}

#[test]
fn cleans_a_realistic_sample_end_to_end() {
    let rule = "-".repeat(55);
    let input = [
        "タイトル",
        "著者名",
        "",
        &rule,
        "【テキスト中に現れる記号について】",
        "",
        "《》：ルビ",
        "（例）僕《ぼく》",
        "",
        "｜：ルビの付く文字列の始まりを特定する記号",
        "（例）｜二十世紀《にじっせいき》",
        "",
        "［＃］：入力者注　主に外字の説明や、傍点の位置の指定",
        "（例）※［＃「にんべん＋并」、第3水準1-14-8］",
        &rule,
        "　本文が始まる。僕《ぼく》は｜二十世紀《にじっせいき》の話をした。",
        "「会話文だ。」と彼は言った。［＃改ページ］",
        "それから※［＃「はしごだか」、U+9AD9、12-3］橋君と話した／＼。",
        "底本：「作品集　第一巻」出版社",
        "　　1950（昭和25）年5月10日発行",
        "※このファイルは青空文庫で作られました。",
    ]
    .join("\n");
    let expected = [
        "　本文が始まる。僕は二十世紀の話をした。",
        "「会話文だ。」と彼は言った。",
        "それから髙橋君と話した〳〵。",
    ]
    .join("\n");
    assert_eq!(clean(&input), expected);
}

#[test]
fn cleans_crlf_input_and_strips_replacement_characters() {
    assert_eq!(clean(&["タイトル", "著者", "", "本文《ふりがな》あり"].join("\r\n")), "本文あり");
    assert_eq!(clean("\nabc\u{fffd}def"), "abcdef");
}

#[test]
fn has_content_is_a_non_empty_trim() {
    assert!(!has_content(&utf16(" \u{3000}\u{feff}\n")));
    assert!(has_content(&utf16(" a ")));
}
