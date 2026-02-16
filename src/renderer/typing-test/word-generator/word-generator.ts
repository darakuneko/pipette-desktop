// SPDX-License-Identifier: GPL-3.0-or-later
// Based on Monkeytype (https://github.com/monkeytypegame/monkeytype)

import type { LanguageData, GenerateOptions, GeneratedWords } from './types'
import english from '../languages/english.json'
import { randomInt } from './random'

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

function sampleWords(
  wordList: readonly string[],
  count: number,
): string[] {
  if (wordList.length === 0) {
    throw new Error('Word list is empty')
  }

  if (wordList.length === 1) {
    return Array(count).fill(wordList[0]) as string[]
  }

  const result: string[] = []
  let lastWord = ''

  for (let i = 0; i < count; i++) {
    let word: string
    let attempts = 0

    do {
      word = wordList[randomInt(0, wordList.length - 1)]
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

export function generateWordsSync(wordCount: number = 30, options?: GenerateOptions, language?: string): GeneratedWords {
  const fallback = english as LanguageData
  const langData = language ? (getLanguageDataSync(language) ?? fallback) : fallback
  const words = applyOptions(sampleWords(langData.words, wordCount), options)
  return { words }
}

export async function generateWords(wordCount: number = 30, options?: GenerateOptions, language?: string): Promise<GeneratedWords> {
  const langData = language ? await getLanguageData(language) : (english as LanguageData)
  const words = applyOptions(sampleWords(langData.words, wordCount), options)
  return { words }
}
