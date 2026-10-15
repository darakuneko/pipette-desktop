// SPDX-License-Identifier: GPL-2.0-or-later
//! Keyboard definition decompression for the vialAPI shim's getDefinition,
//! with the same formats, limits and results as the Electron main process
//! (src/main/lzma.ts): XZ when the input starts with the XZ magic bytes,
//! LZMA-alone otherwise; `None` for empty, oversized or corrupt input. One
//! difference: lzma-js returns garbage for a truncated LZMA-alone stream,
//! which is `None` here.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use xz4rust::{XzDecoder, XzReader};

use crate::command_error::CommandError;

/// Largest compressed definition accepted (`MAX_COMPRESSED_SIZE` in
/// src/main/lzma.ts).
const MAX_COMPRESSED_SIZE: usize = 1024 * 1024;

/// Largest decompressed definition accepted (`MAX_DECOMPRESSED_SIZE` in
/// src/main/lzma.ts).
const MAX_DECOMPRESSED_SIZE: usize = 10 * 1024 * 1024;

/// Largest XZ dictionary accepted: 64 MiB, the dictionary of xz's highest
/// preset (-9). The dictionary is allocated at the size the stream header
/// declares, so this bounds the allocation of a hostile header; only the
/// part the output reaches is ever written.
const MAX_XZ_DICT_SIZE: usize = 64 * 1024 * 1024;

const XZ_MAGIC: [u8; 6] = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

/// The definition JSON text, or `None` when the input is empty, larger than
/// `MAX_COMPRESSED_SIZE`, corrupt, or decompresses to more than
/// `MAX_DECOMPRESSED_SIZE`.
fn decompress(data: &[u8]) -> Option<String> {
    if data.is_empty() || data.len() > MAX_COMPRESSED_SIZE {
        return None;
    }
    if data.starts_with(&XZ_MAGIC) { decompress_xz(data) } else { decompress_lzma(data) }
}

/// Invalid UTF-8 is replaced with U+FFFD, as `Buffer.toString('utf-8')` does.
fn decompress_xz(data: &[u8]) -> Option<String> {
    let decoder = XzDecoder::in_heap_with_alloc_dict_size(0, MAX_XZ_DICT_SIZE);
    let buffer_size = std::num::NonZeroUsize::new(8192)?;
    let reader =
        XzReader::new_with_buffer_size_and_decoder(io::Cursor::new(data.to_vec()), buffer_size, decoder);
    // One byte past the limit tells an output of exactly the limit from a
    // larger one without decoding the rest.
    let mut output = Vec::new();
    reader.take(MAX_DECOMPRESSED_SIZE as u64 + 1).read_to_end(&mut output).ok()?;
    if output.len() > MAX_DECOMPRESSED_SIZE {
        return None;
    }
    Some(String::from_utf8_lossy(&output).into_owned())
}

/// The limit applies to the UTF-8 length of the text after invalid bytes
/// are replaced, as in src/main/lzma.ts. A replacement is never shorter
/// than the bytes it replaces, so raw output past the limit can be dropped
/// while decoding.
fn decompress_lzma(data: &[u8]) -> Option<String> {
    let options = lzma_rs::decompress::Options {
        // Bounds the dictionary buffer, which otherwise grows to the size
        // the header declares.
        memlimit: Some(MAX_DECOMPRESSED_SIZE),
        ..Default::default()
    };
    let mut output = LimitedWriter { buf: Vec::new(), limit: MAX_DECOMPRESSED_SIZE };
    lzma_rs::lzma_decompress_with_options(&mut &data[..], &mut output, &options).ok()?;
    let text = String::from_utf8_lossy(&output.buf).into_owned();
    (text.len() <= MAX_DECOMPRESSED_SIZE).then_some(text)
}

/// A `Vec` sink that fails once more than `limit` bytes are written.
struct LimitedWriter {
    buf: Vec<u8>,
    limit: usize,
}

impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.buf.len() + bytes.len() > self.limit {
            return Err(io::Error::other("decompressed definition exceeds the limit"));
        }
        self.buf.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The `compressed` argument of `DecompressDefinition` in
/// src/preload/protocol-members.ts: the raw bytes as an array of numbers.
#[derive(Debug, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
pub struct CompressedDefinition(Vec<u8>);

/// What `DecompressDefinition` in src/preload/protocol-members.ts resolves
/// to: the definition JSON text, or null when `decompress` gives up.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[cfg_attr(test, derive(Deserialize))]
#[ts(export)]
pub struct DecompressedDefinition(Option<String>);

/// Runs on a blocking-task thread: a definition near the output limit takes
/// long enough to stall the UI thread a synchronous command would run on.
#[tauri::command]
pub async fn decompress_definition(
    data: CompressedDefinition,
) -> Result<DecompressedDefinition, CommandError> {
    Ok(tauri::async_runtime::spawn_blocking(move || DecompressedDefinition(decompress(&data.0))).await?)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use sha2::{Digest, Sha256};

    use super::*;

    /// One input with the result of the LZMA_DECOMPRESS handler in
    /// src/main/lzma.ts, recorded by
    /// scripts/definition-fixtures/record-definition-fixtures.test.ts.
    #[derive(Deserialize)]
    struct Case {
        name: String,
        input: String,
        expected: Option<Expected>,
    }

    #[derive(Debug, PartialEq, Eq, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        utf8_length: usize,
        sha256: String,
    }

    /// Inputs the Electron handler decodes to a text this module rejects.
    /// lzma-js keeps decoding past the end of a truncated LZMA-alone stream
    /// and returns as many bytes as the header announces, most of them
    /// garbage; here a truncated stream is an error.
    const NONE_WHERE_ELECTRON_RETURNS_GARBAGE: &[&str] = &["lzma-alone-truncated"];

    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/definition")
    }

    fn summary(text: &str) -> Expected {
        Expected { utf8_length: text.len(), sha256: hex::encode(Sha256::digest(text.as_bytes())) }
    }

    #[test]
    fn matches_the_electron_main_process_on_the_recorded_inputs() {
        let manifest = std::fs::read_to_string(fixture_dir().join("cases.json")).unwrap();
        let cases: Vec<Case> = serde_json::from_str(&manifest).unwrap();
        assert!(cases.iter().any(|c| c.name.starts_with("xz-") && c.expected.is_some()));
        assert!(cases.iter().any(|c| c.name.starts_with("lzma-alone-") && c.expected.is_some()));
        for case in cases {
            let input = std::fs::read(fixture_dir().join(&case.input)).unwrap();
            let actual = decompress(&input);
            if NONE_WHERE_ELECTRON_RETURNS_GARBAGE.contains(&case.name.as_str()) {
                assert!(case.expected.is_some(), "{}: Electron no longer returns a text", case.name);
                assert_eq!(actual, None, "{}", case.name);
                continue;
            }
            assert_eq!(actual.as_deref().map(summary), case.expected, "{}", case.name);
        }
    }

    #[test]
    fn rejects_empty_and_oversized_input_before_decoding() {
        assert_eq!(decompress(&[]), None);
        let mut oversized = XZ_MAGIC.to_vec();
        oversized.resize(MAX_COMPRESSED_SIZE + 1, 0);
        assert_eq!(decompress(&oversized), None);
    }

    #[test]
    fn limited_writer_accepts_exactly_the_limit() {
        let mut out = LimitedWriter { buf: Vec::new(), limit: 4 };
        out.write_all(b"abcd").unwrap();
        assert!(out.write_all(b"e").is_err());
        assert_eq!(out.buf, b"abcd");
    }

    #[test]
    fn crosses_the_ipc_boundary_as_a_byte_array_and_text_or_null() {
        let data: CompressedDefinition = serde_json::from_value(serde_json::json!([0x5d, 0, 255])).unwrap();
        assert_eq!(data, CompressedDefinition(vec![0x5d, 0, 255]));
        assert!(serde_json::from_value::<CompressedDefinition>(serde_json::json!([256])).is_err());
        assert_eq!(serde_json::to_value(DecompressedDefinition(None)).unwrap(), serde_json::Value::Null);
        assert_eq!(serde_json::to_value(DecompressedDefinition(Some("{}".into()))).unwrap(), "{}");
    }
}
