// SPDX-License-Identifier: GPL-2.0-or-later
// Imported file-import-text source for the typing test. Mirrors the language
// cache: fetched once per id from the typing-test-texts store, then
// served synchronously. Played verbatim in order via the quote path.

import { parseFileImportText } from '../../../shared/types/typing-test-text-store'

export interface FileImportTextData {
  name: string
  /** Words in original order (space- and newline-separated, flattened). */
  words: string[]
  /** Indices of words that end a line — Enter advances past them; Space
   *  advances the others. Empty for single-line texts. */
  lineBreaks: number[]
  /** Leading whitespace per line (display only, preserves code indentation). */
  indents: string[]
  /** Whether this text's content is pure kana, so the romaji input can be
   *  enabled for it (see `isRomajiCapable` in romaji-input.ts). Sourced
   *  from the store's computed `TypingTestTextMeta.romajiCapable` field
   *  rather than recomputed here, so the renderer and the store never
   *  disagree on what counts as kana-pure. */
  romajiCapable: boolean
}

const fileImportTextCache = new Map<string, FileImportTextData>()

export function getFileImportTextDataSync(textId: string): FileImportTextData | undefined {
  return fileImportTextCache.get(textId)
}

export async function getFileImportTextData(textId: string): Promise<FileImportTextData | undefined> {
  const cached = fileImportTextCache.get(textId)
  if (cached) return cached

  const result = await window.vialAPI.typingTestTextStoreGet(textId)
  if (!result.success || !result.data) return undefined

  const { name, text } = result.data.data
  // Shares parseFileImportText with the main-process import path so playback
  // and storage agree on word boundaries AND line breaks.
  const { words, lineBreaks, indents } = parseFileImportText(text)
  const romajiCapable = result.data.meta.romajiCapable === true
  const data: FileImportTextData = { name, words, lineBreaks, indents, romajiCapable }
  fileImportTextCache.set(textId, data)
  return data
}

/** Drop cached entries so the next read re-fetches from the store. Called
 *  by useTypingTestTexts after rename / delete / import / sync changes. */
export function clearFileImportTextCache(textId?: string): void {
  if (textId) {
    fileImportTextCache.delete(textId)
  } else {
    fileImportTextCache.clear()
  }
}
