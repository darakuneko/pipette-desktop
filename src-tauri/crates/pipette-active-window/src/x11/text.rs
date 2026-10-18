// SPDX-License-Identifier: GPL-2.0-or-later
//! The window title and application name in the property bytes, read as the
//! Linux part of `@paymoapp/active-window` reads them: the title with
//! `XGetWMName` (raw bytes for STRING, `Xutf8TextPropertyToTextList` for the
//! rest), the application with `XGetClassHint`. Both reach JavaScript through
//! `Napi::String::New`, which decodes UTF-8 with U+FFFD for each invalid
//! sequence, as [`String::from_utf8_lossy`] does.

/// The type of a `WM_NAME` property, as far as the title depends on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TitleEncoding {
    String,
    Utf8String,
    CompoundText,
    Other,
}

/// The title from a `WM_NAME` property of `format` holding `value`.
///
/// STRING is taken as raw bytes up to the first NUL (so Latin-1 text becomes
/// U+FFFD). UTF8_STRING and COMPOUND_TEXT go through Xlib's conversion,
/// whose first list item ends at the first NUL; a type Xlib cannot convert
/// gives no title. Xlib converts only format 8, and a STRING of another
/// format is no title here either.
pub(crate) fn title(encoding: TitleEncoding, format: u8, value: &[u8]) -> String {
    if format != 8 {
        return String::new();
    }
    let value = until_nul(value);
    match encoding {
        TitleEncoding::String | TitleEncoding::Utf8String => String::from_utf8_lossy(value).into_owned(),
        TitleEncoding::CompoundText => compound_text(value).unwrap_or_default(),
        TitleEncoding::Other => String::new(),
    }
}

/// The application: the class (the second string) of a `WM_CLASS` of type
/// STRING and format 8, as `XGetClassHint` splits it. The instance ends at
/// the first NUL and the class runs from after it to the next NUL or the
/// end; with no NUL at all the class is empty.
pub(crate) fn application(value: &[u8]) -> String {
    match value.iter().position(|&b| b == 0) {
        Some(end) => String::from_utf8_lossy(until_nul(&value[end + 1..])).into_owned(),
        None => String::new(),
    }
}

fn until_nul(value: &[u8]) -> &[u8] {
    value.iter().position(|&b| b == 0).map_or(value, |end| &value[..end])
}

/// COMPOUND_TEXT in its initial state: ASCII on the left half, the right
/// half of ISO 8859-1 on the right, the C0 controls as they are. The escape
/// sequences that designate those two sets again are accepted; any other
/// escape sequence or C1 control switches to a set this does not convert,
/// and the text is `None` (no title).
fn compound_text(value: &[u8]) -> Option<String> {
    const DESIGNATE_ASCII: &[u8] = b"\x1b(B";
    const DESIGNATE_LATIN1_RIGHT: &[u8] = b"\x1b-A";
    let mut text = String::with_capacity(value.len());
    let mut rest = value;
    while let Some((&byte, tail)) = rest.split_first() {
        if byte == 0x1b {
            if rest.starts_with(DESIGNATE_ASCII) || rest.starts_with(DESIGNATE_LATIN1_RIGHT) {
                rest = &rest[3..];
                continue;
            }
            return None;
        }
        match byte {
            0x80..=0x9f => return None,
            _ => text.push(char::from(byte)),
        }
        rest = tail;
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    use TitleEncoding::{CompoundText, Other, String as Str, Utf8String};

    #[test]
    fn string_titles_are_raw_bytes_up_to_the_first_nul() {
        assert_eq!(title(Str, 8, b"Terminal"), "Terminal");
        assert_eq!(title(Str, 8, b"Caf\xe9"), "Caf\u{fffd}");
        assert_eq!(title(Str, 8, "Café".as_bytes()), "Café");
        assert_eq!(title(Str, 8, b"before\0after"), "before");
        assert_eq!(title(Str, 8, b""), "");
        assert_eq!(title(Str, 8, b"tab\there\x01"), "tab\there\x01");
    }

    #[test]
    fn utf8_titles_replace_each_invalid_sequence() {
        assert_eq!(title(Utf8String, 8, "日本語 😀".as_bytes()), "日本語 😀");
        assert_eq!(title(Utf8String, 8, b"A\xffB\xc3"), "A\u{fffd}B\u{fffd}");
        assert_eq!(title(Utf8String, 8, b"\xed\xa0\x80"), "\u{fffd}\u{fffd}\u{fffd}");
        assert_eq!(title(Utf8String, 8, b"before\0after"), "before");
    }

    #[test]
    fn compound_text_is_converted_in_its_initial_state_only() {
        assert_eq!(title(CompoundText, 8, b"Compound"), "Compound");
        assert_eq!(title(CompoundText, 8, b"Caf\xe9"), "Café");
        assert_eq!(title(CompoundText, 8, b"a\x1b(Bb\x1b-A\xe9"), "abé");
        assert_eq!(title(CompoundText, 8, b"x\x1b$(B\x30\x22"), "");
        assert_eq!(title(CompoundText, 8, b"x\x9by"), "");
        assert_eq!(title(CompoundText, 8, b"ab\0\x1b$(B"), "ab");
    }

    #[test]
    fn other_types_and_formats_have_no_title() {
        assert_eq!(title(Other, 8, b"Other"), "");
        for encoding in [Str, Utf8String, CompoundText] {
            assert_eq!(title(encoding, 16, b"T\0i\0"), "");
            assert_eq!(title(encoding, 32, b"T\0\0\0"), "");
        }
    }

    #[test]
    fn the_application_is_the_second_string_of_wm_class() {
        assert_eq!(application(b"code\0Code\0"), "Code");
        assert_eq!(application(b"inst\0Class"), "Class");
        assert_eq!(application(b"\0Class\0"), "Class");
        assert_eq!(application(b"a\0B\0c\0"), "B");
        assert_eq!(application(b"only\0"), "");
        assert_eq!(application(b"only"), "");
        assert_eq!(application(b""), "");
        assert_eq!(application(b"inst\0Caf\xe9\0"), "Caf\u{fffd}");
        assert_eq!(application("inst\0日本\0".as_bytes()), "日本");
    }
}
