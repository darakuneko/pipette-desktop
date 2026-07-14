// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hiragana <-> katakana codepoint conversion, shared by the romaji matcher
// (romaji-engine.ts normalizes kana to hiragana before matching), the
// Aozora catalog's kana-initial classifier (kana-initial.ts normalizes
// readings to katakana for the gojuon grid), and the shared kana-purity
// check (kana-purity.ts folds katakana to hiragana before scanning). Both
// scripts sit in contiguous Unicode blocks a constant +0x60 apart, so each
// conversion is a straight codepoint offset in the corresponding direction.
//
// Lives in shared/ (not renderer/typing-test/) so the main process can use
// it too, without renderer code depending on main or vice versa. The
// renderer's former copy at renderer/typing-test/kana-script.ts now
// re-exports this module to avoid touching its three existing call sites.

const HIRAGANA_START = 0x3041 // ぁ
const HIRAGANA_END = 0x3096 // ゖ
const KATAKANA_START = 0x30a1 // ァ
const KATAKANA_END = 0x30f6 // ヶ
const HIRAGANA_TO_KATAKANA_OFFSET = 0x60

/** Converts a katakana character to its hiragana counterpart; any other
 *  character (including katakana outside the ァ..ヶ range) passes through
 *  unchanged. */
export function toHiragana(char: string): string {
  const code = char.codePointAt(0)
  if (code === undefined || code < KATAKANA_START || code > KATAKANA_END) return char
  return String.fromCodePoint(code - HIRAGANA_TO_KATAKANA_OFFSET)
}

/** Converts a hiragana character to its katakana counterpart; any other
 *  character (including hiragana outside the ぁ..ゖ range) passes through
 *  unchanged. */
export function toKatakana(char: string): string {
  const code = char.codePointAt(0)
  if (code === undefined || code < HIRAGANA_START || code > HIRAGANA_END) return char
  return String.fromCodePoint(code + HIRAGANA_TO_KATAKANA_OFFSET)
}
