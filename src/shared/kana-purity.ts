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

// The Japanese punctuation the romaji engine can type (see PUNCTUATION_TABLE
// in renderer/typing-test/romaji-engine.ts, whose keys are type-locked to
// this list). Allowed inside otherwise-kana text so imported sentences with
// punctuation still qualify for romaji input, but a text of only these marks
// is not "kana" and stays non-capable.
export const ROMAJI_PUNCTUATION = ['。', '、', '？', '！'] as const

const PUNCTUATION_SET: ReadonlySet<string> = new Set(ROMAJI_PUNCTUATION)

/** Type guard narrowing `char` to one of ROMAJI_PUNCTUATION's members, so
 *  callers indexing PUNCTUATION_TABLE (whose keys are locked to that list)
 *  get a type-checked lookup instead of a manual cast. */
export function isRomajiPunctuation(char: string): char is (typeof ROMAJI_PUNCTUATION)[number] {
  return PUNCTUATION_SET.has(char)
}

/**
 * True when every non-whitespace character in `text` is typable by the
 * romaji engine's kana domain: hiragana, katakana (folded to hiragana), the
 * long-vowel mark ー, or one of the four ROMAJI_PUNCTUATION marks (。、？！),
 * which are permitted but don't count toward the required kana content on
 * their own. Kanji, latin, digits, and other punctuation (full-width or
 * half-width variants not in ROMAJI_PUNCTUATION, e.g. 「」・…) all return
 * false. Empty, whitespace-only, or punctuation-only text returns false —
 * there is nothing (or nothing but punctuation) to type as kana.
 */
export function isKanaOnlyText(text: string): boolean {
  let sawKana = false
  for (const char of text) {
    if (WHITESPACE_PATTERN.test(char)) continue
    if (isRomajiPunctuation(char)) continue
    if (!KANA_CHAR_PATTERN.test(toHiragana(char))) return false
    sawKana = true
  }
  return sawKana
}
