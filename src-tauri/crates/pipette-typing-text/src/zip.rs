// SPDX-License-Identifier: GPL-2.0-or-later
//! The `.txt` entry of an Aozora Bunko zip: `unzipSync` of fflate 0.8 (the
//! Electron main process's unzipper) followed by `pickTextEntry` of
//! src/main/aozora/aozora-import.ts.
//!
//! The container is read as fflate reads it, so the same archives open and
//! fail: the end record is searched backwards through up to 65,537 bytes
//! after it (the comment), the zip64 record replaces the entry count and offset, the
//! sizes come from the central directory (zip64 extra field when they are
//! 0xFFFFFFFF), the local header only gives the name and extra lengths, a
//! read past the end of the data reads zeros, and CRCs are not checked.
//! Every entry is unpacked, so one broken entry fails the whole archive, and
//! a stored (0) or DEFLATE (8) method is required of each.
//!
//! The container is read here by hand rather than with a zip crate, which
//! would open and reject different archives (local headers, CRCs, zip64
//! rules); miniz_oxide only unpacks the DEFLATE data.
//!
//! Where it differs from fflate:
//! - DEFLATE data is unpacked by miniz_oxide. A corrupt stream fails with
//!   [`ZipError::Inflate`] instead of fflate's own messages (`invalid block
//!   type`, `unexpected EOF`, …), and a stored block whose length check
//!   fails is rejected (fflate does not check it). Output past the declared
//!   size is cut off unchecked, where fflate keeps decoding (and throws on
//!   a stored block that overruns).
//! - Entries adding up past [`MAX_UNPACKED_BYTES`] (stored by length,
//!   DEFLATE by declared size) fail with [`ZipError::TooLarge`]; fflate
//!   allocates them all (or throws a RangeError on a huge one). Only one
//!   entry is unpacked at a time and only the chosen one is kept, so
//!   central directory entries that all point at one large local record
//!   cannot multiply the memory.

use std::collections::HashMap;

use miniz_oxide::inflate::{TINFLStatus, decompress_to_vec_with_limit};

const END_SIGNATURE: u32 = 0x0605_4b50;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const ZIP64_END_SIGNATURE: u32 = 0x0606_4b50;
const END_RECORD_LEN: usize = 22;
/// fflate gives up the end record search this far from the end.
const END_SEARCH_LIMIT: usize = 65_558;
const UTF8_NAME_FLAG: u32 = 0x800;
const NO_SIZE: u32 = 0xffff_ffff;
const ZIP64_EXTRA_ID: u32 = 1;
const STORED: u32 = 0;
const DEFLATE: u32 = 8;

/// The most the entries of one archive may hold in total: the stored ones
/// by their length, the DEFLATE ones by their declared size. Aozora texts
/// are a few MB, and the decode and the cleaning take several times that.
pub const MAX_UNPACKED_BYTES: usize = 64 << 20;

/// Why a zip did not open. The messages are fflate's, except for
/// [`ZipError::Inflate`] and [`ZipError::TooLarge`] (see the module docs).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ZipError {
    #[error("invalid zip data")]
    Invalid,
    #[error("unknown compression type {0}")]
    UnknownCompression(u32),
    #[error("invalid deflate data")]
    Inflate,
    #[error("unpacked entries larger than {MAX_UNPACKED_BYTES} bytes")]
    TooLarge,
}

/// The archive bytes, read the way fflate's `b2` / `b4` read a Uint8Array:
/// a position outside the data reads 0. Positions are i128 so offsets from
/// 64-bit fields plus lengths never overflow.
struct Data<'a>(&'a [u8]);

impl Data<'_> {
    fn len(&self) -> i128 {
        self.0.len() as i128
    }

    fn byte(&self, at: i128) -> u32 {
        usize::try_from(at).ok().and_then(|at| self.0.get(at)).map_or(0, |&b| u32::from(b))
    }

    fn b2(&self, at: i128) -> u32 {
        self.byte(at) | (self.byte(at + 1) << 8)
    }

    fn b4(&self, at: i128) -> u32 {
        self.b2(at) | (self.b2(at + 2) << 16)
    }

    fn b8(&self, at: i128) -> i128 {
        i128::from(self.b4(at)) | (i128::from(self.b4(at + 4)) << 32)
    }

    /// `subarray(start, end)`, both clamped to the data.
    fn slice(&self, start: i128, end: i128) -> &[u8] {
        let clamp = |at: i128| at.clamp(0, self.len()) as usize;
        let (start, end) = (clamp(start), clamp(end));
        self.0.get(start..end).unwrap_or_default()
    }

    /// The end of central directory record: the last signature at most
    /// [`END_SEARCH_LIMIT`] bytes from the end.
    fn end_record(&self) -> Result<i128, ZipError> {
        let len = self.0.len();
        if len < END_RECORD_LEN {
            return Err(ZipError::Invalid);
        }
        let mut at = len - END_RECORD_LEN;
        loop {
            if self.b4(at as i128) == END_SIGNATURE {
                return Ok(at as i128);
            }
            if at == 0 || len - at > END_SEARCH_LIMIT {
                return Err(ZipError::Invalid);
            }
            at -= 1;
        }
    }

    /// The compressed size, size and local header offset of a central
    /// directory entry, from its zip64 extra field (`extra`..`extra_end`)
    /// where the 32-bit field is 0xFFFFFFFF in a zip64 archive.
    fn sizes(
        &self,
        mut extra: i128,
        extra_end: i128,
        zip64: bool,
        fields: [u32; 3],
    ) -> Result<[i128; 3], ZipError> {
        let [compressed, size, offset] = fields.map(|field| field == NO_SIZE);
        if !zip64 || !(compressed || size || offset) {
            return Ok(fields.map(i128::from));
        }
        while extra + 4 < extra_end {
            if self.b2(extra) == ZIP64_EXTRA_ID {
                let value = |present: bool, index: i128, field: u32| {
                    if present { self.b8(extra + 4 + 8 * index) } else { i128::from(field) }
                };
                let (n_compressed, n_size) = (i128::from(compressed), i128::from(size));
                return Ok([
                    value(compressed, n_size, fields[0]),
                    value(size, 0, fields[1]),
                    value(offset, n_size + n_compressed, fields[2]),
                ]);
            }
            extra += 4 + i128::from(self.b2(extra + 2));
        }
        Err(ZipError::Invalid)
    }
}

/// `inflateSync(data, { out: new Uint8Array(size) })`: the unpacked bytes,
/// at most `size` of them. Empty data gives `size` zeros, as fflate returns
/// its output buffer untouched.
fn inflate(data: &[u8], size: usize) -> Result<Vec<u8>, ZipError> {
    if data.is_empty() {
        return Ok(vec![0; size]);
    }
    match decompress_to_vec_with_limit(data, size) {
        Ok(out) => Ok(out),
        Err(err) if err.status == TINFLStatus::HasMoreOutput => Ok(err.output),
        Err(_) => Err(ZipError::Inflate),
    }
}

/// The entry name as fflate decodes it: UTF-8 (`TextDecoder`, which drops
/// a leading BOM) with the language encoding flag, Latin-1 without.
fn entry_name(bytes: &[u8], flags: u32) -> String {
    if flags & UTF8_NAME_FLAG == 0 {
        return bytes.iter().map(|&b| char::from(b)).collect();
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// `pickTextEntry`'s filter: a path ending in `.txt` (any case) outside
/// `__MACOSX`.
fn is_text_entry(name: &str) -> bool {
    let lower_end = name.len() >= 4 && name.as_bytes()[name.len() - 4..].eq_ignore_ascii_case(b".txt");
    lower_end && !name.contains("__MACOSX")
}

/// Where the bytes of an entry are, so only the chosen one is copied or
/// unpacked a second time.
enum Source<'a> {
    Stored(&'a [u8]),
    /// The DEFLATE data and the declared size.
    Deflate(&'a [u8], usize),
}

struct TextEntry<'a> {
    /// The length fflate's entry has.
    len: usize,
    source: Source<'a>,
}

/// Takes `bytes` from what the archive may still unpack.
fn charge(budget: &mut usize, bytes: usize) -> Result<(), ZipError> {
    *budget = budget.checked_sub(bytes).ok_or(ZipError::TooLarge)?;
    Ok(())
}

/// The data of the largest `.txt` entry (the first one of that size, in
/// the order of the object fflate returns: a repeated name keeps its first
/// place and takes the last data), or `None` when there is none.
pub fn largest_text_entry(zip: &[u8]) -> Result<Option<Vec<u8>>, ZipError> {
    let data = Data(zip);
    let end = data.end_record()?;
    let mut count = data.b2(end + 8);
    if count == 0 {
        return Ok(None);
    }
    let mut offset = i128::from(data.b4(end + 16));
    let mut zip64 = data.b4(end - 20) == ZIP64_LOCATOR_SIGNATURE;
    if zip64 {
        let record = i128::from(data.b4(end - 12));
        zip64 = data.b4(record) == ZIP64_END_SIGNATURE;
        if zip64 {
            count = data.b4(record + 32);
            offset = i128::from(data.b4(record + 48));
        }
    }

    // The `.txt` entries in fflate's object order, and where each name is.
    let mut texts: Vec<TextEntry<'_>> = Vec::new();
    let mut places: HashMap<String, usize> = HashMap::new();
    let mut budget = MAX_UNPACKED_BYTES;
    for _ in 0..count {
        // Past the end every field reads 0: what is left are empty stored
        // entries named "", which can neither fail nor be a `.txt`.
        if offset >= data.len() {
            break;
        }
        let name_len = i128::from(data.b2(offset + 28));
        let extra_len = i128::from(data.b2(offset + 30));
        let name_start = offset + 46;
        let name = entry_name(data.slice(name_start, name_start + name_len), data.b2(offset + 8));
        let extra = name_start + name_len;
        let fields = [data.b4(offset + 20), data.b4(offset + 24), data.b4(offset + 42)];
        let [compressed, size, local] = data.sizes(extra, extra + extra_len, zip64, fields)?;
        let method = data.b2(offset + 10);
        offset = extra + extra_len + i128::from(data.b2(offset + 32));

        let start = local + 30 + i128::from(data.b2(local + 26)) + i128::from(data.b2(local + 28));
        let raw = data.slice(start, start + compressed);
        let entry = match method {
            STORED => {
                charge(&mut budget, raw.len())?;
                TextEntry { len: raw.len(), source: Source::Stored(raw) }
            }
            DEFLATE => {
                let size = usize::try_from(size).map_err(|_| ZipError::TooLarge)?;
                charge(&mut budget, size)?;
                // Unpacked here to fail as fflate does on a broken entry;
                // only the length is kept.
                let len = inflate(raw, size)?.len();
                TextEntry { len, source: Source::Deflate(raw, size) }
            }
            other => return Err(ZipError::UnknownCompression(other)),
        };
        if !is_text_entry(&name) {
            continue;
        }
        match places.get(&name) {
            Some(&place) => texts[place] = entry,
            None => {
                places.insert(name, texts.len());
                texts.push(entry);
            }
        }
    }

    let mut best: Option<&TextEntry<'_>> = None;
    for entry in &texts {
        if best.is_none_or(|best| entry.len > best.len) {
            best = Some(entry);
        }
    }
    best.map(|entry| match entry.source {
        Source::Stored(raw) => Ok(raw.to_vec()),
        Source::Deflate(raw, size) => inflate(raw, size),
    })
    .transpose()
}

#[cfg(test)]
#[path = "zip_tests.rs"]
mod tests;
