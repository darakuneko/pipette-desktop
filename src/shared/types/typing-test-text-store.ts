// SPDX-License-Identifier: GPL-2.0-or-later
// Local store for imported Typing Test texts — mirrors key-label-store's
// index + per-entry layout (entry-level LWW with soft tombstones).

/**
 * Per-entry metadata persisted in `userData/sync/typing-test-texts/index.json`.
 * Cross-keyboard (global) user content, synced like Key Labels.
 */
export interface TypingTestTextMeta {
  /** Local UUID v4. Stable across renames; used as the config `textId`. */
  id: string
  /** Display name (defaults to the imported file's base name). Unique
   *  (case-insensitive) across active entries. */
  name: string
  /** Number of whitespace-separated words stored (post word-cap). Shown
   *  in the Import list. */
  wordCount: number
  /** Internal filename (`{id}_{timestamp}.json`). */
  filename: string
  /** First save time (ISO 8601). */
  savedAt: string
  /** Last update time (ISO 8601) — LWW key. */
  updatedAt: string
  /** Soft delete tombstone (ISO 8601). 30-day GC matches favorites. */
  deletedAt?: string
}

export interface TypingTestTextIndex {
  entries: TypingTestTextMeta[]
}

/** On-disk content of `{filename}`. The raw verbatim text the user typed
 *  against, normalized + capped on import. */
export interface TypingTestTextEntryFile {
  name: string
  text: string
}

/** Combined meta + entry payload returned by `get`. */
export interface TypingTestTextRecord {
  meta: TypingTestTextMeta
  data: TypingTestTextEntryFile
}

/** Specific error codes the renderer can branch on. */
export type TypingTestTextStoreErrorCode =
  | 'INVALID_NAME'
  | 'DUPLICATE_NAME'
  | 'NOT_FOUND'
  | 'INVALID_FILE'
  | 'EMPTY_TEXT'
  | 'TOO_LARGE'
  | 'NOT_UTF8'
  | 'IO_ERROR'

export interface TypingTestTextStoreResult<T> {
  success: boolean
  data?: T
  errorCode?: TypingTestTextStoreErrorCode
  error?: string
}

/** Max accepted `.txt` file size on import (bytes). */
export const TYPING_TEST_TEXT_MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB
/** Max stored words per imported text. Excess is truncated on import. */
export const TYPING_TEST_TEXT_MAX_WORDS = 5000

export interface ParsedCustomText {
  /** Words in original order (space- and newline-separated, flattened). */
  words: string[]
  /** Indices of words that END a line — a newline follows them, so the
   *  typing engine expects Enter (not Space) to advance. The final word is
   *  never included (no trailing newline). */
  lineBreaks: number[]
  /** Leading whitespace of each kept line, indexed by line order. Shown for
   *  code structure (display only — not typed, since Space submits a word). */
  indents: string[]
}

/**
 * Parse imported text into words + line-break positions, preserving the
 * line structure. Space and newline are treated separately: intra-line
 * whitespace runs collapse to one word separator; a newline marks a line
 * break. Empty lines are dropped. Capped at `maxWords` (excess truncated).
 *
 * Shared by the main store (canonicalize on import) and the renderer
 * (verbatim playback) so the two never disagree on words or break points.
 */
export function parseCustomText(text: string, maxWords: number = TYPING_TEST_TEXT_MAX_WORDS): ParsedCustomText {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({
      // Leading whitespace kept for display; the rest splits into words.
      indent: line.match(/^[^\S\n]*/)?.[0] ?? '',
      words: line.split(/[^\S\n]+/).filter((w) => w.length > 0),
    }))
    .filter((line) => line.words.length > 0)

  const words: string[] = []
  const lineBreaks: number[] = []
  const indents: string[] = []
  for (const line of lines) {
    if (words.length >= maxWords) break
    indents.push(line.indent)
    for (const w of line.words) {
      if (words.length >= maxWords) break
      words.push(w)
    }
    // Record a break after this line's last word. A truncated line (cap
    // hit mid-line) gets no break.
    if (words.length < maxWords) lineBreaks.push(words.length - 1)
  }
  // The last line's recorded break points at the final word, which has no
  // newline after it — drop it.
  if (lineBreaks.length > 0 && lineBreaks[lineBreaks.length - 1] === words.length - 1) {
    lineBreaks.pop()
  }
  return { words, lineBreaks, indents }
}

/**
 * Canonicalize raw imported text for storage: words joined by a single
 * space within a line and a newline at each line break. Round-trips
 * through `parseCustomText` so storage and playback agree exactly.
 */
export function normalizeCustomText(raw: string, maxWords: number = TYPING_TEST_TEXT_MAX_WORDS): { text: string; wordCount: number } {
  const { words, lineBreaks, indents } = parseCustomText(raw, maxWords)
  const breakSet = new Set(lineBreaks)
  let text = ''
  let lineIdx = 0
  for (let i = 0; i < words.length; i++) {
    // Start of a line (first word, or the previous word ended a line) →
    // restore its leading indentation so code structure survives the round-trip.
    if (i === 0 || breakSet.has(i - 1)) {
      text += indents[lineIdx] ?? ''
      lineIdx++
    }
    text += words[i]
    if (i < words.length - 1) text += breakSet.has(i) ? '\n' : ' '
  }
  return { text, wordCount: words.length }
}
