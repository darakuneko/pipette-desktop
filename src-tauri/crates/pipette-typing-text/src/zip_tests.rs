// SPDX-License-Identifier: GPL-2.0-or-later
//! The zip reading of fflate's `unzipSync` and the entry choice of
//! `pickTextEntry` (src/main/aozora/aozora-import.ts), on archives built
//! here byte by byte.

use super::*;

/// One entry of a test archive.
#[derive(Clone)]
struct Entry {
    name: Vec<u8>,
    flags: u16,
    method: u16,
    /// The bytes stored in the archive (already compressed for DEFLATE).
    data: Vec<u8>,
    size: u32,
    /// Sizes written as 0xFFFFFFFF with a zip64 extra field.
    zip64_sizes: bool,
}

fn stored(name: &str, data: &[u8]) -> Entry {
    Entry {
        name: name.as_bytes().to_vec(),
        flags: 0,
        method: 0,
        data: data.to_vec(),
        size: data.len() as u32,
        zip64_sizes: false,
    }
}

fn deflated(name: &str, data: &[u8]) -> Entry {
    Entry {
        method: 8,
        data: miniz_oxide::deflate::compress_to_vec(data, 6),
        size: data.len() as u32,
        ..stored(name, b"")
    }
}

fn u16le(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// A zip of `entries` with `comment`; with `zip64`, a zip64 end record and
/// locator before the end record.
fn build(entries: &[Entry], comment: &[u8], zip64: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offsets = Vec::new();
    for entry in entries {
        offsets.push(out.len() as u32);
        u32le(&mut out, 0x0403_4b50);
        u16le(&mut out, 20);
        u16le(&mut out, entry.flags);
        u16le(&mut out, entry.method);
        out.extend_from_slice(&[0; 8]);
        u32le(&mut out, entry.data.len() as u32);
        u32le(&mut out, entry.size);
        u16le(&mut out, entry.name.len() as u16);
        u16le(&mut out, 0);
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&entry.data);
    }
    let directory = out.len() as u32;
    for (entry, offset) in entries.iter().zip(offsets) {
        let mut extra = Vec::new();
        if entry.zip64_sizes {
            u16le(&mut extra, 1);
            u16le(&mut extra, 16);
            extra.extend_from_slice(&u64::from(entry.size).to_le_bytes());
            extra.extend_from_slice(&(entry.data.len() as u64).to_le_bytes());
        }
        let (compressed, size) =
            if entry.zip64_sizes { (u32::MAX, u32::MAX) } else { (entry.data.len() as u32, entry.size) };
        u32le(&mut out, 0x0201_4b50);
        u16le(&mut out, 20);
        u16le(&mut out, 20);
        u16le(&mut out, entry.flags);
        u16le(&mut out, entry.method);
        out.extend_from_slice(&[0; 8]);
        u32le(&mut out, compressed);
        u32le(&mut out, size);
        u16le(&mut out, entry.name.len() as u16);
        u16le(&mut out, extra.len() as u16);
        // Comment length, disk, internal and external attributes.
        out.extend_from_slice(&[0; 10]);
        u32le(&mut out, offset);
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&extra);
    }
    let directory_len = out.len() as u32 - directory;
    if zip64 {
        let record = out.len() as u64;
        u32le(&mut out, 0x0606_4b50);
        out.extend_from_slice(&44u64.to_le_bytes());
        out.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u64).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u64).to_le_bytes());
        out.extend_from_slice(&u64::from(directory_len).to_le_bytes());
        out.extend_from_slice(&u64::from(directory).to_le_bytes());
        u32le(&mut out, 0x0706_4b50);
        u32le(&mut out, 0);
        out.extend_from_slice(&record.to_le_bytes());
        u32le(&mut out, 1);
    }
    u32le(&mut out, 0x0605_4b50);
    out.extend_from_slice(&[0; 4]);
    let count = if zip64 { u16::MAX } else { entries.len() as u16 };
    u16le(&mut out, count);
    u16le(&mut out, count);
    u32le(&mut out, directory_len);
    u32le(&mut out, if zip64 { u32::MAX } else { directory });
    u16le(&mut out, comment.len() as u16);
    out.extend_from_slice(comment);
    out
}

fn pick(entries: &[Entry]) -> Result<Option<Vec<u8>>, ZipError> {
    largest_text_entry(&build(entries, b"", false))
}

#[test]
fn picks_the_largest_txt_entry_and_the_first_of_equal_size() {
    let entries = [stored("a.txt", b"12"), stored("b.txt", b"123"), stored("c.txt", b"abc")];
    assert_eq!(pick(&entries), Ok(Some(b"123".to_vec())));
}

#[test]
fn skips_other_files_and_macosx_and_matches_txt_in_any_case() {
    let entries = [
        stored("image.png", b"0123456789"),
        stored("__MACOSX/work.txt", b"0123456789"),
        stored("dir/", b""),
        stored("WORK.TxT", b"text"),
    ];
    assert_eq!(pick(&entries), Ok(Some(b"text".to_vec())));
    assert_eq!(pick(&entries[..3]), Ok(None));
}

#[test]
fn a_repeated_name_keeps_its_first_place_and_takes_the_last_data() {
    let entries = [stored("a.txt", b"xx"), stored("b.txt", b"yy"), stored("a.txt", b"zz")];
    assert_eq!(pick(&entries), Ok(Some(b"zz".to_vec())));
}

#[test]
fn names_decode_as_latin1_or_utf8_by_the_flag() {
    let latin1 = Entry { name: b"\xe9.txt".to_vec(), ..stored("", b"latin1") };
    let utf8 = Entry { name: "é.txt".as_bytes().to_vec(), flags: 0x800, ..stored("", b"utf-8") };
    let bom = Entry { name: b"\xef\xbb\xbf\xc3\xa9.txt".to_vec(), flags: 0x800, ..stored("", b"bom") };
    // All three are named "é.txt": the first place, the last data.
    assert_eq!(pick(&[latin1.clone(), utf8.clone(), bom]), Ok(Some(b"bom".to_vec())));
    // "é.txt" keeps the place before "x.txt", so it wins the tie.
    let plain = stored("x.txt", b"12345");
    assert_eq!(pick(&[latin1, plain, utf8]), Ok(Some(b"utf-8".to_vec())));
}

#[test]
fn unpacks_deflate_entries() {
    let text = "あいうえお".repeat(100);
    assert_eq!(pick(&[deflated("work.txt", text.as_bytes())]), Ok(Some(text.into_bytes())));
}

#[test]
fn deflate_output_is_cut_at_the_declared_size_and_empty_data_gives_zeros() {
    let short = Entry { size: 3, ..deflated("a.txt", b"abcdef") };
    assert_eq!(pick(&[short]), Ok(Some(b"abc".to_vec())));
    let long = Entry { size: 10, ..deflated("a.txt", b"abcdef") };
    assert_eq!(pick(&[long]), Ok(Some(b"abcdef".to_vec())));
    let empty = Entry { method: 8, data: Vec::new(), size: 4, ..stored("a.txt", b"") };
    assert_eq!(pick(&[empty]), Ok(Some(vec![0; 4])));
}

#[test]
fn fails_on_a_broken_entry_even_when_it_is_not_a_txt() {
    let broken = Entry { method: 8, data: vec![0xff; 8], size: 8, ..stored("image.png", b"") };
    assert_eq!(pick(&[stored("a.txt", b"a"), broken]), Err(ZipError::Inflate));
    let truncated = deflated("a.txt", &[7; 1000]);
    let truncated = Entry { data: truncated.data[..truncated.data.len() / 2].to_vec(), ..truncated };
    assert_eq!(pick(&[truncated]), Err(ZipError::Inflate));
    let unknown = Entry { method: 12, ..stored("a.bin", b"x") };
    assert_eq!(pick(&[stored("a.txt", b"a"), unknown]), Err(ZipError::UnknownCompression(12)));
}

#[test]
fn rejects_data_without_an_end_record() {
    assert_eq!(largest_text_entry(b""), Err(ZipError::Invalid));
    assert_eq!(largest_text_entry(&[0; 21]), Err(ZipError::Invalid));
    assert_eq!(largest_text_entry(&[0; 100]), Err(ZipError::Invalid));
    let zip = build(&[stored("a.txt", b"a")], b"", false);
    assert_eq!(largest_text_entry(&zip[..zip.len() - 1]), Err(ZipError::Invalid));
}

#[test]
fn an_archive_without_entries_has_no_text() {
    assert_eq!(pick(&[]), Ok(None));
}

#[test]
fn finds_the_end_record_before_up_to_65537_trailing_bytes() {
    let entries = [stored("a.txt", b"a")];
    let mut zip = build(&entries, &[b' '; 65_535], false);
    zip.extend_from_slice(&[b' '; 2]);
    assert_eq!(largest_text_entry(&zip), Ok(Some(b"a".to_vec())));
    zip.push(b' ');
    assert_eq!(largest_text_entry(&zip), Err(ZipError::Invalid));
}

#[test]
fn reads_zip64_records_and_sizes() {
    let entry = Entry { zip64_sizes: true, ..deflated("a.txt", b"zip64 text") };
    assert_eq!(
        largest_text_entry(&build(std::slice::from_ref(&entry), b"", true)),
        Ok(Some(b"zip64 text".to_vec()))
    );
    // Sizes of 0xFFFFFFFF without the zip64 extra field.
    let mut zip = build(&[entry], b"", true);
    let directory = zip.windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]).unwrap_or_default();
    zip[directory + 30] = 0;
    assert_eq!(largest_text_entry(&zip), Err(ZipError::Invalid));
}

#[test]
fn rejects_deflate_entries_declaring_too_much() {
    let entry = Entry { size: u32::MAX, ..deflated("a.txt", b"a") };
    assert_eq!(pick(&[entry]), Err(ZipError::TooLarge));
}
