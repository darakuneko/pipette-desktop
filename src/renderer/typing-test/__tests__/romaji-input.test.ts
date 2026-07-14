// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isRomajiCapable, isRomajiInputEnabled, isRomajiInputActive, romajiDetail, carryRomajiFields } from '../romaji-input'
import type { RomajiDetailSettings, TypingTestConfig } from '../types'

// Each helper takes `romaji` directly (rather than spreading its return
// value elsewhere) so the literal stays narrowed to its own mode branch —
// spreading a `TypingTestConfig`-typed value loses that narrowing and
// resurfaces a bogus "romaji does not exist on the quote branch" error.
const wordsConfig = (romajiInput?: boolean, romaji?: RomajiDetailSettings): TypingTestConfig =>
  ({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput, romaji })
const timeConfig = (romajiInput?: boolean, romaji?: RomajiDetailSettings): TypingTestConfig =>
  ({ mode: 'time', duration: 30, punctuation: false, numbers: false, romajiInput, romaji })
const tatoebaConfig = (language: string, romajiInput?: boolean, romaji?: RomajiDetailSettings): TypingTestConfig =>
  ({ mode: 'tatoeba', language, romajiInput, romaji })
const fileImportConfig = (romajiInput?: boolean, romaji?: RomajiDetailSettings): TypingTestConfig =>
  ({ mode: 'fileImport', textId: 't1', romajiInput, romaji })
const quoteConfig = (): TypingTestConfig => ({ mode: 'quote', quoteLength: 'medium' })

describe('isRomajiCapable', () => {
  it('words/time: capable for a kana language, not for a non-kana language', () => {
    expect(isRomajiCapable(wordsConfig(), 'japanese_hiragana', undefined)).toBe(true)
    expect(isRomajiCapable(wordsConfig(), 'japanese_katakana', undefined)).toBe(true)
    expect(isRomajiCapable(wordsConfig(), 'english', undefined)).toBe(false)
    expect(isRomajiCapable(timeConfig(), 'japanese_hiragana', undefined)).toBe(true)
    expect(isRomajiCapable(timeConfig(), 'english', undefined)).toBe(false)
  })

  it('tatoeba: capable when the pack language id is a kana pack, regardless of the active word-language pack', () => {
    expect(isRomajiCapable(tatoebaConfig('japanese_hiragana'), 'english', undefined)).toBe(true)
    expect(isRomajiCapable(tatoebaConfig('japanese_katakana'), 'english', undefined)).toBe(true)
    expect(isRomajiCapable(tatoebaConfig('english'), 'japanese_hiragana', undefined)).toBe(false)
  })

  it('fileImport: capable only when the loaded text is kana-pure, regardless of the active word-language pack', () => {
    expect(isRomajiCapable(fileImportConfig(), 'english', true)).toBe(true)
    expect(isRomajiCapable(fileImportConfig(), 'english', false)).toBe(false)
    expect(isRomajiCapable(fileImportConfig(), 'english', undefined)).toBe(false)
    expect(isRomajiCapable(fileImportConfig(), 'japanese_hiragana', false)).toBe(false)
  })

  it('quote: never capable, even with a kana language active', () => {
    expect(isRomajiCapable(quoteConfig(), 'japanese_hiragana', true)).toBe(false)
  })
})

describe('isRomajiInputEnabled', () => {
  it('defaults to enabled when romajiInput is unset, regardless of capability', () => {
    expect(isRomajiInputEnabled(wordsConfig())).toBe(true)
    expect(isRomajiInputEnabled(timeConfig())).toBe(true)
    expect(isRomajiInputEnabled(tatoebaConfig('english'))).toBe(true)
    expect(isRomajiInputEnabled(fileImportConfig())).toBe(true)
  })

  it('an explicit false opts out, an explicit true stays opted in', () => {
    expect(isRomajiInputEnabled(wordsConfig(false))).toBe(false)
    expect(isRomajiInputEnabled(wordsConfig(true))).toBe(true)
  })

  it('quote never carries the field and is always disabled', () => {
    expect(isRomajiInputEnabled(quoteConfig())).toBe(false)
  })
})

describe('isRomajiInputActive', () => {
  it('words/time: defaults to active (romajiInput undefined) when the language is capable, inactive when not capable', () => {
    expect(isRomajiInputActive(wordsConfig(), 'japanese_hiragana', undefined)).toBe(true)
    expect(isRomajiInputActive(wordsConfig(), 'english', undefined)).toBe(false)
    expect(isRomajiInputActive(timeConfig(), 'japanese_hiragana', undefined)).toBe(true)
  })

  it('words/time: an explicit true stays active, an explicit false opts out, for a capable language', () => {
    expect(isRomajiInputActive(wordsConfig(true), 'japanese_hiragana', undefined)).toBe(true)
    expect(isRomajiInputActive(wordsConfig(true), 'english', undefined)).toBe(false)
    expect(isRomajiInputActive(wordsConfig(false), 'japanese_hiragana', undefined)).toBe(false)
  })

  it('tatoeba: defaults to active for a kana pack, and an explicit false opts out', () => {
    expect(isRomajiInputActive(tatoebaConfig('japanese_hiragana'), 'english', undefined)).toBe(true)
    expect(isRomajiInputActive(tatoebaConfig('japanese_hiragana', true), 'english', undefined)).toBe(true)
    expect(isRomajiInputActive(tatoebaConfig('english', true), 'english', undefined)).toBe(false)
    expect(isRomajiInputActive(tatoebaConfig('japanese_hiragana', false), 'english', undefined)).toBe(false)
  })

  it('fileImport: defaults to active for a kana-pure text, and an explicit false opts out', () => {
    expect(isRomajiInputActive(fileImportConfig(), 'english', true)).toBe(true)
    expect(isRomajiInputActive(fileImportConfig(true), 'english', true)).toBe(true)
    expect(isRomajiInputActive(fileImportConfig(true), 'english', false)).toBe(false)
    expect(isRomajiInputActive(fileImportConfig(false), 'english', true)).toBe(false)
  })

  it('quote: never active, even with romajiInput somehow set and a kana language active', () => {
    expect(isRomajiInputActive(quoteConfig(), 'japanese_hiragana', true)).toBe(false)
  })
})

describe('carryRomajiFields', () => {
  it('carries romajiInput and romaji from words/time/tatoeba/fileImport configs', () => {
    const romaji = { caseStyle: 'capital' as const }
    expect(carryRomajiFields(wordsConfig(false, romaji))).toEqual({ romajiInput: false, romaji })
    expect(carryRomajiFields(timeConfig(true, romaji))).toEqual({ romajiInput: true, romaji })
    expect(carryRomajiFields(tatoebaConfig('japanese_hiragana', true, romaji))).toEqual({ romajiInput: true, romaji })
    expect(carryRomajiFields(fileImportConfig(false, romaji))).toEqual({ romajiInput: false, romaji })
  })

  it('returns {} for quote (no romaji fields at all)', () => {
    expect(carryRomajiFields(quoteConfig())).toEqual({})
  })

  it('returns {} when the source config never set romajiInput/romaji', () => {
    expect(carryRomajiFields(wordsConfig())).toEqual({})
    expect(carryRomajiFields(tatoebaConfig('japanese_hiragana'))).toEqual({})
    expect(carryRomajiFields(fileImportConfig())).toEqual({})
  })

  it('carries only romajiInput when romaji detail settings are absent', () => {
    expect(carryRomajiFields(wordsConfig(true))).toEqual({ romajiInput: true })
  })
})

describe('romajiDetail', () => {
  it('reads the romaji block from every mode but quote', () => {
    const romaji = { caseStyle: 'capital' as const }
    expect(romajiDetail(wordsConfig(undefined, romaji))).toEqual(romaji)
    expect(romajiDetail(timeConfig(undefined, romaji))).toEqual(romaji)
    expect(romajiDetail(tatoebaConfig('japanese_hiragana', undefined, romaji))).toEqual(romaji)
    expect(romajiDetail(fileImportConfig(undefined, romaji))).toEqual(romaji)
  })

  it('is always undefined for quote (the shape has no romaji field)', () => {
    expect(romajiDetail(quoteConfig())).toBeUndefined()
  })

  it('is undefined when the mode carries romaji but it was never set', () => {
    expect(romajiDetail(wordsConfig())).toBeUndefined()
    expect(romajiDetail(tatoebaConfig('japanese_hiragana'))).toBeUndefined()
    expect(romajiDetail(fileImportConfig())).toBeUndefined()
  })
})
