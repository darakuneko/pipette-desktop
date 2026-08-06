// SPDX-License-Identifier: GPL-3.0-or-later
// Based on Monkeytype (https://github.com/monkeytypegame/monkeytype)

import type { LanguageData, GenerateOptions, GeneratedWords } from './types'
import english from '../languages/english.json'
import { randomInt } from './random'
import { wordWeakSpotScore, pickWeightedIndex, WEAK_SPOT_BIAS_RATIO, type WeakSpotBiasProfile } from './weak-spot-weighting'

const languageCache = new Map<string, LanguageData>()
languageCache.set('english', english as LanguageData)

export function getLanguageDataSync(name: string): LanguageData | undefined {
  return languageCache.get(name)
}

export async function getLanguageData(name: string): Promise<LanguageData> {
  const cached = languageCache.get(name)
  if (cached) return cached

  const data = await window.vialAPI.langGet(name)
  if (data && typeof data === 'object' && 'words' in data) {
    const langData = data as LanguageData
    languageCache.set(name, langData)
    return langData
  }

  return languageCache.get('english')!
}

/** Evicts a single cached language entry, forcing the next `getLanguageData`
 *  call for `name` to re-fetch. `languageCache` is private to this module,
 *  so anything that needs to reseed a name with different word data —
 *  currently only tests that reuse a real language id across cases — goes
 *  through this rather than reaching into module internals. Unlike
 *  `clearTatoebaPackCache`/`clearFileImportTextCache`, this doesn't support
 *  clearing the whole cache: the built-in `'english'` entry is the fallback
 *  `getLanguageData` itself falls back to, so evicting it would break that
 *  fallback. */
export function clearLanguageCache(name: string): void {
  languageCache.delete(name)
}

/** Uniform-random word draw, shared by both the plain and weak-spot-biased
 *  paths below when a biased draw isn't taken (or biasing isn't active at
 *  all). */
function randomWord(wordList: readonly string[]): string {
  return wordList[randomInt(0, wordList.length - 1)]
}

/** Weighted-random word draw against precomputed per-word scores (see
 *  `wordWeakSpotScore`) — `totalWeight` is the caller's already-summed
 *  total, so this never resums per draw. */
function biasedWord(wordList: readonly string[], weights: readonly number[], totalWeight: number): string {
  return wordList[pickWeightedIndex(weights, totalWeight)]
}

/** Samples `count` words from `wordList`, avoiding an immediate repeat of
 *  the previous pick (up to 100 retries, then accepts the repeat rather
 *  than looping forever — matches the pre-existing behaviour for a small
 *  or heavily-skewed list). `seedLastWord` seeds the repeat-avoidance
 *  window with the caller's own preceding word (e.g. a time-mode refill's
 *  last already-generated word — see word-supply.ts's
 *  `refillTimeModeWords`), so the immediate-repeat guarantee holds across
 *  a refill boundary, not just within one batch.
 *
 *  When `weakSpotProfile` is given, each draw independently has a
 *  WEAK_SPOT_BIAS_RATIO (60%) chance of being pulled from the
 *  weak-spot-weighted pool instead of the uniform one — see
 *  weak-spot-weighting.ts's module doc comment for why a fixed mixture
 *  (not pure proportional weighting) is used. Falls back to fully uniform
 *  sampling when every word in `wordList` scores 0 (no matched mistake
 *  tokens at all — nothing to bias toward). */
function sampleWords(
  wordList: readonly string[],
  count: number,
  weakSpotProfile?: WeakSpotBiasProfile,
  seedLastWord?: string,
): string[] {
  if (wordList.length === 0) {
    throw new Error('Word list is empty')
  }

  if (wordList.length === 1) {
    return Array(count).fill(wordList[0]) as string[]
  }

  let weights: number[] | undefined
  let totalWeight = 0
  if (weakSpotProfile) {
    weights = wordList.map((w) => wordWeakSpotScore(w, weakSpotProfile))
    totalWeight = weights.reduce((a, b) => a + b, 0)
  }
  const biasActive = weights !== undefined && totalWeight > 0

  const result: string[] = []
  let lastWord = seedLastWord ?? ''

  for (let i = 0; i < count; i++) {
    const useBiased = biasActive && Math.random() < WEAK_SPOT_BIAS_RATIO
    let word: string
    let attempts = 0

    do {
      word = useBiased ? biasedWord(wordList, weights!, totalWeight) : randomWord(wordList)
      attempts++
    } while (word === lastWord && attempts < 100)

    result.push(word)
    lastWord = word
  }

  return result
}

function appendPunctuation(word: string, punct: string): string {
  return word.replace(/[.,;]+$/, '') + punct
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function randomSentenceEnd(): string {
  const r = Math.random()
  if (r < 0.8) return '.'
  if (r < 0.9) return '?'
  return '!'
}

export function injectPunctuation(words: string[]): string[] {
  const result = [...words]
  let sentenceLength = randomInt(5, 8)
  let wordsSincePeriod = 0
  let capitalizeNext = true // Capitalize first word

  for (let i = 0; i < result.length; i++) {
    if (capitalizeNext) {
      result[i] = capitalize(result[i])
      capitalizeNext = false
    }

    wordsSincePeriod++

    if (i === result.length - 1) {
      result[i] = appendPunctuation(result[i], '.')
      break
    }

    if (wordsSincePeriod >= sentenceLength) {
      result[i] = appendPunctuation(result[i], randomSentenceEnd())
      capitalizeNext = true
      wordsSincePeriod = 0
      sentenceLength = randomInt(5, 8)
    } else if (Math.random() < 0.2) {
      result[i] = appendPunctuation(result[i], ',')
    }
  }

  return result
}

export function injectNumbers(words: string[]): string[] {
  return words.map((word) => {
    if (Math.random() < 0.1) {
      const digits = randomInt(1, 4)
      const min = Math.pow(10, digits - 1)
      const max = Math.pow(10, digits) - 1
      return randomInt(min, max).toString()
    }
    return word
  })
}

function applyOptions(words: string[], options?: GenerateOptions): string[] {
  let result = words
  if (options?.numbers) {
    result = injectNumbers(result)
  }
  if (options?.punctuation) {
    result = injectPunctuation(result)
  }
  return result
}

export function generateWordsSync(
  wordCount: number = 30,
  options?: GenerateOptions,
  language?: string,
  weakSpotProfile?: WeakSpotBiasProfile,
  seedLastWord?: string,
): GeneratedWords {
  const fallback = english as LanguageData
  const langData = language ? (getLanguageDataSync(language) ?? fallback) : fallback
  const words = applyOptions(sampleWords(langData.words, wordCount, weakSpotProfile, seedLastWord), options)
  return { words }
}

export async function generateWords(
  wordCount: number = 30,
  options?: GenerateOptions,
  language?: string,
  weakSpotProfile?: WeakSpotBiasProfile,
  seedLastWord?: string,
): Promise<GeneratedWords> {
  const langData = language ? await getLanguageData(language) : (english as LanguageData)
  const words = applyOptions(sampleWords(langData.words, wordCount, weakSpotProfile, seedLastWord), options)
  return { words }
}
