// SPDX-License-Identifier: GPL-2.0-or-later
//! How the Windows lookup of the active window names an application, as
//! `@paymoapp/active-window` names it: the `FileDescription` of the
//! executable's version resource in the first language of its
//! `\VarFileInfo\Translation` (U.S. English and code page 1252 when there is
//! none), or the executable's file name when that is empty. Text is UTF-16
//! code units, as Windows gives it. Only the calls into the system live in
//! windows_active_window.rs; everything here runs on every system.

/// The language and code page the binding asks for when the version
/// resource lists none: U.S. English (0x0409), Windows-1252 (0x04E4).
pub(crate) const DEFAULT_TRANSLATION: (u16, u16) = (0x0409, 0x04e4);

/// The executable of every UWP app's frame window; the app itself runs in a
/// child window's process.
const UWP_FRAME_HOST: &str = "ApplicationFrameHost.exe";

/// What `path` names after its last backslash, all of it when it has none.
pub(crate) fn basename(path: &[u16]) -> &[u16] {
    let backslash = u16::from(b'\\');
    path.iter().rposition(|&unit| unit == backslash).map_or(path, |last| &path[last + 1..])
}

/// Whether `path` is the UWP frame host (the file name compared exactly, as
/// the binding does).
pub(crate) fn is_uwp_frame_host(path: &[u16]) -> bool {
    basename(path).iter().copied().eq(UWP_FRAME_HOST.encode_utf16())
}

/// The application's name: `description` unless it is empty, then the
/// executable's file name (with its `.exe`).
pub(crate) fn application_name(description: Vec<u16>, path: &[u16]) -> Vec<u16> {
    if description.is_empty() { basename(path).to_vec() } else { description }
}

/// The `\VarFileInfo\Translation` sub-block, NUL-terminated for
/// `VerQueryValueW`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn translation_query() -> Vec<u16> {
    nul_terminated("\\VarFileInfo\\Translation")
}

/// The first language and code page of a `Translation` value (pairs of
/// little-endian words), or [`DEFAULT_TRANSLATION`] when it has none.
pub(crate) fn translation(value: Option<&[u8]>) -> (u16, u16) {
    match value {
        Some([lang_lo, lang_hi, page_lo, page_hi, ..]) => {
            (u16::from_le_bytes([*lang_lo, *lang_hi]), u16::from_le_bytes([*page_lo, *page_hi]))
        }
        _ => DEFAULT_TRANSLATION,
    }
}

/// The `FileDescription` sub-block in `lang` and `code_page`, the digits in
/// upper case, NUL-terminated for `VerQueryValueW`.
pub(crate) fn file_description_query((lang, code_page): (u16, u16)) -> Vec<u16> {
    nul_terminated(&format!("\\StringFileInfo\\{lang:04X}{code_page:04X}\\FileDescription"))
}

fn nul_terminated(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// The `len` bytes at `address` when they lie inside `block`. The values
/// `VerQueryValueW` finds point into the block it searched; this turns one
/// into a slice of it without trusting the pointer.
pub(crate) fn within(block: &[u8], address: usize, len: usize) -> Option<&[u8]> {
    let start = address.checked_sub(block.as_ptr() as usize)?;
    block.get(start..start.checked_add(len)?)
}

/// A string value of a version resource, `bytes` holding its little-endian
/// UTF-16 units, up to its first NUL.
pub(crate) fn string_value(bytes: &[u8]) -> Vec<u16> {
    bytes
        .chunks_exact(2)
        .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
        .take_while(|&unit| unit != 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn the_basename_is_what_follows_the_last_backslash() {
        assert_eq!(basename(&units("C:\\Program Files\\App\\app.exe")), units("app.exe"));
        assert_eq!(basename(&units("app.exe")), units("app.exe"));
        assert_eq!(basename(&units("C:\\dir\\")), units(""));
        assert_eq!(basename(&units("C:/dir/app.exe")), units("C:/dir/app.exe"));
        assert_eq!(basename(&[]), units(""));
    }

    #[test]
    fn only_the_frame_host_itself_is_a_uwp_frame() {
        assert!(is_uwp_frame_host(&units("C:\\Windows\\System32\\ApplicationFrameHost.exe")));
        assert!(is_uwp_frame_host(&units("ApplicationFrameHost.exe")));
        assert!(!is_uwp_frame_host(&units("C:\\Windows\\System32\\applicationframehost.exe")));
        assert!(!is_uwp_frame_host(&units("C:\\Windows\\System32\\ApplicationFrameHost.exe.bak")));
        assert!(!is_uwp_frame_host(&[]));
    }

    #[test]
    fn an_empty_description_falls_back_to_the_file_name() {
        let path = units("C:\\Tools\\tool.exe");
        assert_eq!(application_name(units("Tool"), &path), units("Tool"));
        assert_eq!(application_name(units(" "), &path), units(" "));
        assert_eq!(application_name(Vec::new(), &path), units("tool.exe"));
        assert_eq!(application_name(Vec::new(), &[]), units(""));
    }

    #[test]
    fn the_first_translation_is_used_or_the_default() {
        assert_eq!(translation(Some(&[0x11, 0x04, 0xb0, 0x04, 0x09, 0x04, 0xe4, 0x04])), (0x0411, 0x04b0));
        assert_eq!(translation(Some(&[0x09, 0x04, 0xb0, 0x04])), (0x0409, 0x04b0));
        assert_eq!(translation(Some(&[0x09, 0x04])), DEFAULT_TRANSLATION);
        assert_eq!(translation(Some(&[])), DEFAULT_TRANSLATION);
        assert_eq!(translation(None), DEFAULT_TRANSLATION);
    }

    #[test]
    fn the_queries_are_nul_terminated_with_upper_case_digits() {
        assert_eq!(translation_query(), units("\\VarFileInfo\\Translation\0"));
        assert_eq!(
            file_description_query((0x0409, 0x04e4)),
            units("\\StringFileInfo\\040904E4\\FileDescription\0")
        );
        assert_eq!(
            file_description_query((0x0c0a, 0x04b0)),
            units("\\StringFileInfo\\0C0A04B0\\FileDescription\0")
        );
        assert_eq!(
            file_description_query((0x0, 0xabcd)),
            units("\\StringFileInfo\\0000ABCD\\FileDescription\0")
        );
    }

    #[test]
    fn a_value_is_read_only_inside_its_block() {
        let block = [1u8, 2, 3, 4, 5, 6];
        let start = block.as_ptr() as usize;
        assert_eq!(within(&block, start, 6), Some(&block[..]));
        assert_eq!(within(&block, start + 2, 3), Some(&block[2..5]));
        assert_eq!(within(&block, start + 6, 0), Some(&block[6..]));
        assert_eq!(within(&block, start + 4, 3), None);
        assert_eq!(within(&block, start.wrapping_sub(1), 2), None);
        assert_eq!(within(&block, start + 1, usize::MAX), None);
    }

    #[test]
    fn a_string_value_ends_at_its_first_nul() {
        assert_eq!(string_value(&[b'A', 0, b'B', 0, 0, 0, b'C', 0]), units("AB"));
        assert_eq!(string_value(&[0x42, 0x30, 0x6a, 0x30]), units("\u{3042}\u{306a}"));
        assert_eq!(string_value(&[b'A', 0, b'B']), units("A"));
        assert_eq!(string_value(&[0, 0, b'A', 0]), units(""));
        assert_eq!(string_value(&[]), units(""));
    }
}
