// SPDX-License-Identifier: GPL-2.0-or-later

/** Word/quote supply for each typing-test mode config. Resolves a
 *  TypingTestConfig + language into the word list (plus any quote / line
 *  metadata) a run's state is seeded from, in sync (cache-only) and async
 *  (store round-trip) variants. */

import { generateWords, generateWordsSync, selectQuote, quoteToWords, getFileImportTextData, getFileImportTextDataSync, getTatoebaPack, getTatoebaPackSync, tatoebaRun } from './word-generator'
import type { FileImportTextData } from './word-generator'
import type { TypingTestConfig, Quote } from './types'

const TIME_MODE_BATCH_SIZE = 60
const TIME_MODE_EXTEND_THRESHOLD = 10

/** Return the word count and generation options for word-based modes (words/time). */
function wordGenParams(config: TypingTestConfig & { mode: 'words' | 'time' }): { count: number; opts: { punctuation: boolean; numbers: boolean } } {
  return {
    count: config.mode === 'words' ? config.wordCount : TIME_MODE_BATCH_SIZE,
    opts: { punctuation: config.punctuation, numbers: config.numbers },
  }
}

/** Time-mode word refill: when the untyped tail of `words` runs low,
 *  returns the list extended by one more generated batch (same
 *  punctuation/numbers opts as the initial supply); returns null when no
 *  refill is due, so the caller can keep its state object untouched. Keeps
 *  the batch/threshold policy private to this module. */
export function refillTimeModeWords(
  words: readonly string[],
  nextIndex: number,
  config: TypingTestConfig & { mode: 'time' },
  language: string,
): string[] | null {
  if (words.length - nextIndex >= TIME_MODE_EXTEND_THRESHOLD) return null
  const { opts } = wordGenParams(config)
  const { words: moreWords } = generateWordsSync(TIME_MODE_BATCH_SIZE, opts, language)
  return [...words, ...moreWords]
}

export interface WordsForConfig {
  words: string[]
  quote: Quote | null
  /** Line-end word indices — Enter advances past them; empty for flat
   *  word-flow sources. */
  lineBreaks: number[]
  /** Per-line leading whitespace (fileImport mode only); empty otherwise. */
  lineIndents: string[]
  /** Whether this text is romaji-capable (fileImport mode only — see
   *  `isRomajiCapable` in romaji-input.ts). Always false for every other
   *  mode, which derive capability from `language`/`config.language`
   *  instead and never consult this field. */
  romajiCapable: boolean
}

/** Build the verbatim quote shell for an imported fileImport text so the
 *  finished screen can show its name as the source. Carries the line-break
 *  positions through so Enter can advance at line ends. */
function fileImportTextToWords(data: FileImportTextData): WordsForConfig {
  const text = data.words.join(' ')
  return {
    words: data.words,
    quote: { id: 0, text, source: data.name, length: text.length },
    lineBreaks: data.lineBreaks,
    lineIndents: data.indents,
    romajiCapable: data.romajiCapable,
  }
}

/** Build a word-flow config from a sampled Tatoeba run (empty when the pack
 *  is uncached / not downloaded). Reuses the quote path's char-based
 *  counting and carries the run's per-sentence `lineBreaks` through so each
 *  sampled sentence renders on its own line, same as imported fileImport
 *  text. */
function tatoebaWordsForConfig(pack: { name: string; words: string[] } | undefined): WordsForConfig {
  if (!pack) return { words: [], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
  return { ...tatoebaRun(pack), lineIndents: [], romajiCapable: false }
}

export function createWordsForConfigSync(config: TypingTestConfig, language: string): WordsForConfig {
  if (config.mode === 'quote') {
    const quote = selectQuote(config.quoteLength)
    return { words: quoteToWords(quote), quote, lineBreaks: [], lineIndents: [], romajiCapable: false }
  }
  if (config.mode === 'fileImport') {
    const data = getFileImportTextDataSync(config.textId)
    // Cache miss — the async setConfig path fills words once the store
    // round-trip resolves. Return empty (never call sampleWords on []).
    return data ? fileImportTextToWords(data) : { words: [], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
  }
  if (config.mode === 'tatoeba') {
    // Cache miss — the async path fills words once langGet resolves.
    return tatoebaWordsForConfig(getTatoebaPackSync(config.language))
  }
  const { count, opts } = wordGenParams(config)
  const { words } = generateWordsSync(count, opts, language)
  return { words, quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
}

export async function createWordsForConfig(config: TypingTestConfig, language: string): Promise<WordsForConfig> {
  if (config.mode === 'quote') {
    const quote = selectQuote(config.quoteLength)
    return { words: quoteToWords(quote), quote, lineBreaks: [], lineIndents: [], romajiCapable: false }
  }
  if (config.mode === 'fileImport') {
    const data = await getFileImportTextData(config.textId)
    return data ? fileImportTextToWords(data) : { words: [], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
  }
  if (config.mode === 'tatoeba') {
    return tatoebaWordsForConfig(await getTatoebaPack(config.language))
  }
  const { count, opts } = wordGenParams(config)
  const { words } = await generateWords(count, opts, language)
  return { words, quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
}
