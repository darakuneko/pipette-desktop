// SPDX-License-Identifier: GPL-2.0-or-later
//! Whether the romaji input can type a text: `isKanaOnlyText` of
//! src/shared/kana-purity.ts with `toHiragana` of src/shared/kana-script.ts.

use pipette_entry_store::is_js_whitespace;

use crate::units::bmp;

/// ぁ..ゖ, the hiragana `toHiragana` folds katakana into.
const HIRAGANA: std::ops::RangeInclusive<u16> = 0x3041..=0x3096;
/// ァ..ヶ, the katakana `toHiragana` folds (0x60 above the hiragana).
const KATAKANA: std::ops::RangeInclusive<u16> = 0x30a1..=0x30f6;
/// ー, the long vowel mark, which has no hiragana counterpart.
const LONG_VOWEL_MARK: u16 = 0x30fc;
/// `ROMAJI_PUNCTUATION`: allowed in a kana text, but not kana content.
const ROMAJI_PUNCTUATION: [u16; 4] = bmp("。、？！");

/// True when every character of `text` other than whitespace is hiragana,
/// katakana in ァ..ヶ, ー or one of 。、？！, and at least one is kana.
///
/// Walking code units gives the same answer as walking code points, because every accepted character is a single BMP unit and both
/// halves of a surrogate pair (or a lone surrogate) are rejected either way.
pub fn is_kana_only_text(text: &[u16]) -> bool {
    let mut saw_kana = false;
    for &unit in text {
        if is_js_whitespace(unit) || ROMAJI_PUNCTUATION.contains(&unit) {
            continue;
        }
        if !(HIRAGANA.contains(&unit) || KATAKANA.contains(&unit) || unit == LONG_VOWEL_MARK) {
            return false;
        }
        saw_kana = true;
    }
    saw_kana
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::utf16;

    fn kana(text: &str) -> bool {
        is_kana_only_text(&utf16(text))
    }

    #[test]
    fn accepts_hiragana_katakana_and_the_long_vowel_mark() {
        assert!(kana("あいうえおかきくけこ"));
        assert!(kana("アイウエオカキクケコ"));
        assert!(kana("コーヒーをのむ"));
        assert!(kana("ゐゑヶヴ"));
    }

    #[test]
    fn accepts_whitespace_spaces_tabs_crlf_and_full_width_space() {
        assert!(kana("あい う\tえ\nお\r\nか　き"));
    }

    #[test]
    fn rejects_kanji_and_ascii() {
        assert!(!kana("日本語のぶんしょう"));
        assert!(!kana("hello world"));
    }

    #[test]
    fn accepts_kana_with_the_four_romaji_punctuation_marks() {
        assert!(kana("こんにちは。"));
        assert!(kana("こんにちは、げんきですか"));
        assert!(kana("ですか？"));
        assert!(kana("すごい！"));
    }

    #[test]
    fn rejects_punctuation_without_kana() {
        assert!(!kana("。。。"));
        assert!(!kana("、"));
        assert!(!kana("？ ！"));
    }

    #[test]
    fn rejects_other_punctuation() {
        assert!(!kana("こんにちは「せかい」"));
        assert!(!kana("あ・い"));
    }

    #[test]
    fn rejects_empty_and_whitespace_only_text() {
        assert!(!kana(""));
        assert!(!kana("   \n\t　"));
    }

    #[test]
    fn checks_the_block_edges() {
        assert!(!kana("\u{3040}"));
        assert!(kana("\u{3041}\u{3096}"));
        assert!(!kana("\u{3097}"));
        assert!(!kana("\u{30a0}"));
        assert!(kana("\u{30a1}\u{30f6}"));
        assert!(!kana("\u{30f7}"));
        assert!(!kana("\u{30fb}"));
        assert!(!kana("あ\u{30fd}"));
    }

    #[test]
    fn rejects_surrogates() {
        assert!(!kana("あ😀"));
        assert!(!is_kana_only_text(&[0x3042, 0xd800]));
    }
}
