// SPDX-License-Identifier: GPL-2.0-or-later
//! The words and lines of an imported Typing Test text, as
//! `parseFileImportText` and `normalizeFileImportText` in
//! src/shared/types/typing-test-text-store.ts read them. The renderer plays
//! the stored text back with the TypeScript parser, so both must split a
//! text the same way.

use pipette_entry_store::is_js_whitespace;

use crate::units::{CR, LF, SPACE};

/// Max stored words per imported text (`TYPING_TEST_TEXT_MAX_WORDS`).
pub const MAX_WORDS: usize = 5000;

/// The words of a text with its line structure.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedFileImportText<'a> {
    /// The words in order, across all lines.
    pub words: Vec<&'a [u16]>,
    /// The indexes of the words a newline follows. Never the last word.
    pub line_breaks: Vec<usize>,
    /// The leading whitespace of each kept line, in line order.
    pub indents: Vec<&'a [u16]>,
}

/// The text to store for an import, with its counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedFileImportText {
    pub text: Vec<u16>,
    pub word_count: usize,
    pub line_count: usize,
}

/// The lines of `text` split at `\r\n`, `\r` and `\n`, as
/// `text.replace(/\r\n?/g, '\n').split('\n')` gives them: the rule of
/// `normalize_newlines` (units.rs), applied here without copying the text.
fn lines(text: &[u16]) -> Vec<&[u16]> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < text.len() {
        match text[i] {
            LF => {
                lines.push(&text[start..i]);
                start = i + 1;
            }
            CR => {
                lines.push(&text[start..i]);
                if text.get(i + 1) == Some(&LF) {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    lines.push(&text[start..]);
    lines
}

/// `parseFileImportText`: whitespace runs (JavaScript's `\s`) separate the
/// words of a line, lines without words are dropped, and the words stop at
/// `max_words` (a line cut short gets no break).
pub fn parse_file_import_text(text: &[u16], max_words: usize) -> ParsedFileImportText<'_> {
    let mut parsed = ParsedFileImportText::default();
    for line in lines(text) {
        let mut line_words =
            line.split(|&unit| is_js_whitespace(unit)).filter(|word| !word.is_empty()).peekable();
        if line_words.peek().is_none() {
            continue;
        }
        if parsed.words.len() >= max_words {
            break;
        }
        let indent = line.iter().position(|&unit| !is_js_whitespace(unit)).unwrap_or(line.len());
        parsed.indents.push(&line[..indent]);
        for word in line_words {
            if parsed.words.len() >= max_words {
                break;
            }
            parsed.words.push(word);
        }
        if parsed.words.len() < max_words {
            parsed.line_breaks.push(parsed.words.len() - 1);
        }
    }
    // The last line's break would point at the final word, which no newline
    // follows.
    if parsed.line_breaks.last().is_some_and(|&last| last + 1 == parsed.words.len()) {
        parsed.line_breaks.pop();
    }
    parsed
}

/// `normalizeFileImportText`: the words joined by one space within a line
/// and a newline at each break, each line starting with its indentation, so
/// the stored text parses back to the same words and breaks.
pub fn normalize_file_import_text(raw: &[u16], max_words: usize) -> NormalizedFileImportText {
    let parsed = parse_file_import_text(raw, max_words);
    // `line_breaks` is strictly ascending.
    let is_break = |index: usize| parsed.line_breaks.binary_search(&index).is_ok();
    let mut text = Vec::new();
    let mut line_index = 0;
    for (i, word) in parsed.words.iter().enumerate() {
        if i == 0 || is_break(i - 1) {
            if let Some(indent) = parsed.indents.get(line_index) {
                text.extend_from_slice(indent);
            }
            line_index += 1;
        }
        text.extend_from_slice(word);
        if i + 1 < parsed.words.len() {
            text.push(if is_break(i) { LF } else { SPACE });
        }
    }
    NormalizedFileImportText { text, word_count: parsed.words.len(), line_count: parsed.indents.len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::utf16;

    fn strings(slices: &[&[u16]]) -> Vec<String> {
        slices.iter().map(|units| String::from_utf16_lossy(units)).collect()
    }

    fn parse(text: &str) -> (Vec<String>, Vec<usize>, Vec<String>) {
        let units = utf16(text);
        let parsed = parse_file_import_text(&units, MAX_WORDS);
        (strings(&parsed.words), parsed.line_breaks, strings(&parsed.indents))
    }

    fn normalize(text: &str) -> (String, usize, usize) {
        let normalized = normalize_file_import_text(&utf16(text), MAX_WORDS);
        (String::from_utf16_lossy(&normalized.text), normalized.word_count, normalized.line_count)
    }

    #[test]
    fn collapses_intra_line_whitespace_and_keeps_single_line_as_no_breaks() {
        assert_eq!(
            parse("  the  quick\t fox "),
            (vec!["the".into(), "quick".into(), "fox".into()], vec![], vec!["  ".into()])
        );
    }

    #[test]
    fn treats_newline_as_a_line_break_distinct_from_space() {
        let words = vec!["the".into(), "quick".into(), "brown".into(), "fox".into()];
        assert_eq!(parse("the quick\nbrown fox"), (words, vec![1], vec![String::new(), String::new()]));
    }

    #[test]
    fn normalizes_crlf_and_cr_and_drops_empty_lines() {
        let words = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(parse("a\r\n\r\nb\rc"), (words, vec![0, 1], vec![String::new(); 3]));
    }

    #[test]
    fn caps_at_the_word_limit() {
        let many = vec!["w"; MAX_WORDS + 10].join(" ");
        assert_eq!(parse(&many).0.len(), MAX_WORDS);
    }

    #[test]
    fn a_line_cut_short_by_the_cap_gets_no_break() {
        let units = utf16("a b\nc d e\nf");
        let parsed = parse_file_import_text(&units, 4);
        assert_eq!(strings(&parsed.words), ["a", "b", "c", "d"]);
        assert_eq!(parsed.line_breaks, [1]);
        assert_eq!(parsed.indents.len(), 2);
        assert_eq!(parse_file_import_text(&units, 0), ParsedFileImportText::default());
    }

    #[test]
    fn canonicalizes_with_single_spaces_in_a_line_and_newline_at_breaks() {
        assert_eq!(normalize("the  quick\nbrown   fox"), ("the quick\nbrown fox".into(), 4, 2));
    }

    #[test]
    fn preserves_leading_indentation_per_line() {
        assert_eq!(normalize("def f() {\n  val x = 1\n}"), ("def f() {\n  val x = 1\n}".into(), 8, 3));
    }

    #[test]
    fn round_trips_through_parse() {
        let normalized = normalize_file_import_text(&utf16("a b\nc\n\nd e f"), MAX_WORDS);
        let original = utf16("a b\nc\n\nd e f");
        assert_eq!(
            parse_file_import_text(&normalized.text, MAX_WORDS),
            parse_file_import_text(&original, MAX_WORDS)
        );
    }

    #[test]
    fn counts_non_empty_lines() {
        assert_eq!(normalize("a b\nc\n\nd e f").2, 3);
    }

    #[test]
    fn a_single_line_no_space_text_has_one_word_and_one_line() {
        assert_eq!(normalize("こんにちは"), ("こんにちは".into(), 1, 1));
    }

    #[test]
    fn whitespace_is_javascripts_backslash_s() {
        // U+3000 and U+FEFF separate words; U+0085 and U+200B do not.
        assert_eq!(normalize("a\u{3000}b\u{feff}c\u{85}d\u{200b}e"), ("a b c\u{85}d\u{200b}e".into(), 3, 1));
        // U+2028 is whitespace within a line, not a line break.
        assert_eq!(normalize("a\u{2028}b"), ("a b".into(), 2, 1));
    }
}
