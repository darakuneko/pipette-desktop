// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isKanaOnlyText } from '../kana-purity'

describe('isKanaOnlyText', () => {
  it('accepts pure hiragana', () => {
    expect(isKanaOnlyText('あいうえおかきくけこ')).toBe(true)
  })

  it('accepts pure katakana', () => {
    expect(isKanaOnlyText('アイウエオカキクケコ')).toBe(true)
  })

  it('accepts mixed hiragana/katakana with the long vowel mark', () => {
    expect(isKanaOnlyText('コーヒーをのむ')).toBe(true)
  })

  it('accepts whitespace: spaces, tabs, CR/LF, and full-width space', () => {
    expect(isKanaOnlyText('あい う\tえ\nお\r\nか　き')).toBe(true)
  })

  it('rejects kanji', () => {
    expect(isKanaOnlyText('日本語のぶんしょう')).toBe(false)
  })

  it('rejects ascii text', () => {
    expect(isKanaOnlyText('hello world')).toBe(false)
  })

  it('rejects kana mixed with a full-width period', () => {
    expect(isKanaOnlyText('こんにちは。')).toBe(false)
  })

  it('rejects kana mixed with a full-width comma', () => {
    expect(isKanaOnlyText('こんにちは、げんきですか')).toBe(false)
  })

  it('rejects empty text', () => {
    expect(isKanaOnlyText('')).toBe(false)
  })

  it('rejects whitespace-only text', () => {
    expect(isKanaOnlyText('   \n\t　')).toBe(false)
  })

  it('accepts historical kana, the archaic small ka/ke, and the katakana-only vu', () => {
    expect(isKanaOnlyText('ゐゑヶヴ')).toBe(true)
  })
})
