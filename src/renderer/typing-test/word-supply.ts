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
/** Sentences sampled for the tatoeba Time pattern's initial batch and every
 *  refill — larger than a Lines-pattern run since a running clock chews
 *  through many short sentences before the next low-water refill check. */
const TATOEBA_TIME_BATCH_SIZE = 20

/** Return the word count and generation options for word-based modes (words/time). */
function wordGenParams(config: TypingTestConfig & { mode: 'words' | 'time' }): { count: number; opts: { punctuation: boolean; numbers: boolean } } {
  return {
    count: config.mode === 'words' ? config.wordCount : TIME_MODE_BATCH_SIZE,
    opts: { punctuation: config.punctuation, numbers: config.numbers },
  }
}

/** Result of a time-bounded refill: `words` is the extended list; `lineBreaks`
 *  are the NEW line-break indices (absolute, into the returned `words`)
 *  contributed by this refill. Empty for monkeytype time mode (no line
 *  concept); the caller merges these into the run's existing `lineBreaks`
 *  set (see `advanceAfterWord`). */
export interface WordsRefill {
  words: string[]
  lineBreaks: number[]
}

/** Time-bounded word refill — monkeytype time mode, or the tatoeba Time
 *  pattern (see `isTimeBoundedRun`). Self-contained: every non-time-bounded
 *  config (including tatoeba's Lines pattern) returns null on its own,
 *  rather than trusting the caller to only invoke this once time-bounded.
 *  When the untyped tail of `words` runs low, returns the list extended by
 *  one more batch; returns null when no refill is due, or (tatoeba) the
 *  pack isn't cached / sampled empty, so the caller can keep its state
 *  object untouched. Keeps the batch/threshold policy private to this
 *  module. */
export function refillTimeModeWords(
  words: readonly string[],
  nextIndex: number,
  config: TypingTestConfig,
  language: string,
): WordsRefill | null {
  if (words.length - nextIndex >= TIME_MODE_EXTEND_THRESHOLD) return null

  if (config.mode === 'tatoeba' && config.pattern === 'time') {
    const pack = getTatoebaPackSync(config.language)
    if (!pack) return null
    const { words: moreWords, lineBreaks } = tatoebaRun(pack, TATOEBA_TIME_BATCH_SIZE)
    if (moreWords.length === 0) return null
    const offset = words.length
    // The previous batch's final sentence never got a trailing break
    // recorded (nothing followed it yet, by tatoebaRun's own convention) —
    // the seam between it and this batch's first sentence needs one now,
    // so Enter (not Space) still advances between them.
    return {
      words: [...words, ...moreWords],
      lineBreaks: [offset - 1, ...lineBreaks.map((b) => b + offset)],
    }
  }

  if (config.mode !== 'time') return null
  const { opts } = wordGenParams(config)
  const { words: moreWords } = generateWordsSync(TIME_MODE_BATCH_SIZE, opts, language)
  return { words: [...words, ...moreWords], lineBreaks: [] }
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
 *  text. `count` is the Lines pattern's `lineCount`, or the Time pattern's
 *  initial batch size — see the two `createWordsForConfig*` call sites. */
function tatoebaWordsForConfig(pack: { name: string; words: string[] } | undefined, count: number): WordsForConfig {
  if (!pack) return { words: [], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
  return { ...tatoebaRun(pack, count), lineIndents: [], romajiCapable: false }
}

/** Sentence count to sample for a tatoeba config: the Lines pattern's own
 *  `lineCount`, or the Time pattern's fixed initial batch (matching the
 *  refill batch size — see `refillTimeModeWords`). */
function tatoebaSampleCount(config: TypingTestConfig & { mode: 'tatoeba' }): number {
  return config.pattern === 'time' ? TATOEBA_TIME_BATCH_SIZE : config.lineCount
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
    return tatoebaWordsForConfig(getTatoebaPackSync(config.language), tatoebaSampleCount(config))
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
    return tatoebaWordsForConfig(await getTatoebaPack(config.language), tatoebaSampleCount(config))
  }
  const { count, opts } = wordGenParams(config)
  const { words } = await generateWords(count, opts, language)
  return { words, quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }
}
