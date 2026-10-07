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

interface CachedText {
  data: FileImportTextData
  /** The store meta's `updatedAt` when fetched. An overwrite import keeps
   *  the id and changes this, so it is what tells a stale entry apart. */
  updatedAt: string
}

const fileImportTextCache = new Map<string, CachedText>()
// Bumped by every revalidation; a fetch that started under an older value
// returns its data but does not cache it (it may predate the sync).
let cacheGeneration = 0

export function getFileImportTextDataSync(textId: string): FileImportTextData | undefined {
  return fileImportTextCache.get(textId)?.data
}

export async function getFileImportTextData(textId: string): Promise<FileImportTextData | undefined> {
  const cached = fileImportTextCache.get(textId)
  if (cached) return cached.data

  const generation = cacheGeneration
  const result = await window.vialAPI.typingTestTextStoreGet(textId)
  if (!result.success || !result.data) return undefined

  const { name, text } = result.data.data
  // Shares parseFileImportText with the main-process import path so playback
  // and storage agree on word boundaries AND line breaks.
  const { words, lineBreaks, indents } = parseFileImportText(text)
  const romajiCapable = result.data.meta.romajiCapable === true
  const data: FileImportTextData = { name, words, lineBreaks, indents, romajiCapable }
  if (generation === cacheGeneration) {
    fileImportTextCache.set(textId, { data, updatedAt: result.data.meta.updatedAt })
  }
  return data
}

/** Drop cached entries so the next read re-fetches from the store. Called
 *  by useTypingTestTexts after rename / delete / import. */
export function clearFileImportTextCache(textId?: string): void {
  if (textId) {
    fileImportTextCache.delete(textId)
  } else {
    fileImportTextCache.clear()
  }
}

/** After a sync merge of the texts store: drop the entries whose text was
 *  deleted or rewritten (`updatedAt` differs), keep the rest. A failed list
 *  read drops everything. A run already started keeps its words — the run
 *  state holds its own copy and never reads this cache again. */
export async function revalidateFileImportTextCache(): Promise<void> {
  const generation = ++cacheGeneration
  let current: Map<string, string> | null = null
  try {
    const result = await window.vialAPI.typingTestTextStoreList()
    if (result.success && result.data) current = new Map(result.data.map((m) => [m.id, m.updatedAt]))
  } catch {
    current = null
  }
  // A newer revalidation owns the cache from here.
  if (generation !== cacheGeneration) return
  for (const [id, entry] of fileImportTextCache) {
    if (current?.get(id) !== entry.updatedAt) fileImportTextCache.delete(id)
  }
}
