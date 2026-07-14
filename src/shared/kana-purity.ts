// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure content check used to decide whether the romaji typing input can be
// enabled for a piece of text. Previously the romaji engine only activated
// for the built-in monkeytype kana packs; this predicate extends that to
// any text (e.g. a file import or Tatoeba sentence) whose content is pure
// kana, since the romaji matcher only understands hiragana input.
//
// Kept in shared/ (not main/ or renderer/) because both the main process
// (computing the flag for imported texts) and the renderer (deciding which
// built-in packs are romaji-capable) need the same rule.

import { toHiragana } from './kana-script'

// Hiragana block (ぁ..ゖ) plus the katakana-only long vowel mark (ー), which
// has no hiragana counterpart and is left as-is by toHiragana. Everything
// typable by the romaji engine's kana domain falls in this set once
// katakana has been folded to hiragana.
const KANA_CHAR_PATTERN = /^[ぁ-ゖー]$/

// Whitespace is allowed for tokenization only (word/line separators in
// imported text) — it carries no typing content. JS `\s` already covers the
// full-width space U+3000 (Unicode category Zs) alongside space/tab/CR/LF.
const WHITESPACE_PATTERN = /^\s$/

/**
 * True when every non-whitespace character in `text` is typable by the
 * romaji engine's kana domain: hiragana, katakana (folded to hiragana), or
 * the long-vowel mark ー. Kanji, latin, digits, and punctuation (including
 * full-width punctuation like 、。「」！？・…) all return false. Empty or
 * whitespace-only text returns false — there is nothing to type.
 */
export function isKanaOnlyText(text: string): boolean {
  let sawTypeableChar = false
  for (const char of text) {
    if (WHITESPACE_PATTERN.test(char)) continue
    if (!KANA_CHAR_PATTERN.test(toHiragana(char))) return false
    sawTypeableChar = true
  }
  return sawTypeableChar
}
