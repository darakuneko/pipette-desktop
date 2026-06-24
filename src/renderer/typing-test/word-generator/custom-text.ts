// SPDX-License-Identifier: GPL-2.0-or-later
// Imported custom-text source for the typing test. Mirrors the language
// cache: fetched once per id from the typing-test-texts store, then
// served synchronously. Played verbatim in order via the quote path.

import { parseCustomText } from '../../../shared/types/typing-test-text-store'

export interface CustomTextData {
  name: string
  /** Words in original order (space- and newline-separated, flattened). */
  words: string[]
  /** Indices of words that end a line — Enter advances past them; Space
   *  advances the others. Empty for single-line texts. */
  lineBreaks: number[]
  /** Leading whitespace per line (display only, preserves code indentation). */
  indents: string[]
}

const customTextCache = new Map<string, CustomTextData>()

export function getCustomTextDataSync(textId: string): CustomTextData | undefined {
  return customTextCache.get(textId)
}

export async function getCustomTextData(textId: string): Promise<CustomTextData | undefined> {
  const cached = customTextCache.get(textId)
  if (cached) return cached

  const result = await window.vialAPI.typingTestTextStoreGet(textId)
  if (!result.success || !result.data) return undefined

  const { name, text } = result.data.data
  // Shares parseCustomText with the main-process import path so playback
  // and storage agree on word boundaries AND line breaks.
  const { words, lineBreaks, indents } = parseCustomText(text)
  const data: CustomTextData = { name, words, lineBreaks, indents }
  customTextCache.set(textId, data)
  return data
}

/** Drop cached entries so the next read re-fetches from the store. Called
 *  by useTypingTestTexts after rename / delete / import / sync changes. */
export function clearCustomTextCache(textId?: string): void {
  if (textId) {
    customTextCache.delete(textId)
  } else {
    customTextCache.clear()
  }
}
