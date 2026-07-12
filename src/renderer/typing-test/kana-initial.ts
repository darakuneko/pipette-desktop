// SPDX-License-Identifier: GPL-2.0-or-later
//
// Gojuon (五十音) initial-kana classification for the Aozora catalog's
// author filter. Pure normalization only: hiragana -> katakana,
// dakuten/handakuten -> base kana, small kana -> full-size kana. The kana
// characters themselves are linguistic data, not translatable UI text, so
// they live here as constants rather than i18n keys.

import { toKatakana } from './kana-script'

/** The ten gojuon row headers, in reading order. */
export const KANA_ROWS = ['ア', 'カ', 'サ', 'タ', 'ナ', 'ハ', 'マ', 'ヤ', 'ラ', 'ワ'] as const

export type KanaRow = (typeof KANA_ROWS)[number]

/** Each row's column kana. ヤ has 3 columns and ワ has 1; every other row
 *  has the full 5 (modern reference readings never start with ヰ/ヱ/ヲ, so
 *  those historical ワ-row columns are intentionally omitted). */
export const KANA_ROW_COLUMNS: Record<KanaRow, readonly string[]> = {
  ア: ['ア', 'イ', 'ウ', 'エ', 'オ'],
  カ: ['カ', 'キ', 'ク', 'ケ', 'コ'],
  サ: ['サ', 'シ', 'ス', 'セ', 'ソ'],
  タ: ['タ', 'チ', 'ツ', 'テ', 'ト'],
  ナ: ['ナ', 'ニ', 'ヌ', 'ネ', 'ノ'],
  ハ: ['ハ', 'ヒ', 'フ', 'ヘ', 'ホ'],
  マ: ['マ', 'ミ', 'ム', 'メ', 'モ'],
  ヤ: ['ヤ', 'ユ', 'ヨ'],
  ラ: ['ラ', 'リ', 'ル', 'レ', 'ロ'],
  ワ: ['ワ'],
}

// Every base kana across all ten rows — used to reject a normalized
// character that isn't actually part of the gojuon grid (kanji, ン, ...).
const ALL_COLUMN_KANA = new Set(Object.values(KANA_ROW_COLUMNS).flat())

/** Column kana -> its row header, inverted from KANA_ROW_COLUMNS once at
 *  load so a row filter is a single equality test per entry. */
export const KANA_COLUMN_TO_ROW: Readonly<Record<string, KanaRow>> = Object.fromEntries(
  (Object.entries(KANA_ROW_COLUMNS) as [KanaRow, readonly string[]][])
    .flatMap(([row, columns]) => columns.map((column) => [column, row])),
)

// Small kana, folded to their full-size counterpart.
const SMALL_FOLD: Record<string, string> = {
  ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ',
  ヵ: 'カ', ヶ: 'ケ',
  ッ: 'ツ',
  ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ',
  ヮ: 'ワ',
}

/** Normalizes a reading/name string down to a single base gojuon kana: the
 *  first non-space character, converted to katakana, with dakuten/
 *  handakuten and small-kana marks folded off. Returns `null` when the
 *  string is empty/undefined, or its first character isn't part of the
 *  gojuon grid at all (a kanji name, ン, a Latin letter, ...) — such
 *  entries never match a row/column filter. */
export function normalizeKanaInitial(text: string | undefined): string | null {
  if (!text) return null
  const trimmed = text.trimStart()
  if (trimmed.length === 0) return null
  const first = [...trimmed][0]
  const katakana = toKatakana(first)
  // NFD strips combining dakuten/handakuten (ガ→カ, パ→ハ, ヴ→ウ) — the
  // same folding as the Aozora Bunko author index. Small kana are distinct
  // codepoints (not decompositions), so they need their own table.
  const folded = SMALL_FOLD[katakana] ?? katakana.normalize('NFD')[0]
  return ALL_COLUMN_KANA.has(folded) ? folded : null
}
