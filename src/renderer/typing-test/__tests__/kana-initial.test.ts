import { describe, it, expect } from 'vitest'
import { normalizeKanaInitial, KANA_ROWS, KANA_ROW_COLUMNS } from '../kana-initial'

describe('normalizeKanaInitial', () => {
  it('converts a hiragana reading to its katakana initial', () => {
    expect(normalizeKanaInitial('だざい おさむ')).toBe('タ')
  })

  it('keeps an already-katakana reading as-is', () => {
    expect(normalizeKanaInitial('アーヴィング ワシントン')).toBe('ア')
  })

  it('folds a dakuten kana to its base column kana', () => {
    expect(normalizeKanaInitial('がぎがき')).toBe('カ')
    expect(normalizeKanaInitial('ザメンホフ')).toBe('サ')
    expect(normalizeKanaInitial('ダンテ')).toBe('タ')
  })

  it('folds a handakuten kana to its base column kana', () => {
    expect(normalizeKanaInitial('ぱすかる')).toBe('ハ')
  })

  it('folds ヴ to ウ', () => {
    expect(normalizeKanaInitial('ヴェルヌ')).toBe('ウ')
    expect(normalizeKanaInitial('ゔぇるぬ')).toBe('ウ')
  })

  it('folds a small kana to its full-size counterpart', () => {
    expect(normalizeKanaInitial('ぁいうえお')).toBe('ア')
    expect(normalizeKanaInitial('ォずぼーん')).toBe('オ')
    expect(normalizeKanaInitial('ヶ原')).toBe('ケ')
    expect(normalizeKanaInitial('ゕ')).toBe('カ')
  })

  it('handles canonically decomposed input (base kana + combining mark)', () => {
    // A decomposed first char splits into base + U+3099/U+309A; the base
    // kana alone already lands on the right column.
    expect(normalizeKanaInitial('がき')).toBe('カ')
    expect(normalizeKanaInitial('ぱり')).toBe('ハ')
    expect(normalizeKanaInitial('ヴェルヌ')).toBe('ウ')
  })

  it('skips leading whitespace before reading the first character', () => {
    expect(normalizeKanaInitial('  だざい おさむ')).toBe('タ')
  })

  it('returns null for an empty or undefined string', () => {
    expect(normalizeKanaInitial('')).toBeNull()
    expect(normalizeKanaInitial(undefined)).toBeNull()
    expect(normalizeKanaInitial('   ')).toBeNull()
  })

  it('returns null when the first character is not part of the gojuon grid', () => {
    expect(normalizeKanaInitial('太宰 治')).toBeNull()
    expect(normalizeKanaInitial('ンドゥール')).toBeNull()
    expect(normalizeKanaInitial('Smith John')).toBeNull()
  })

  it('exposes each row header inside its own column set', () => {
    for (const row of KANA_ROWS) {
      expect(KANA_ROW_COLUMNS[row]).toContain(row)
    }
  })

  it('gives ヤ three columns and ワ a single column', () => {
    expect(KANA_ROW_COLUMNS['ヤ']).toEqual(['ヤ', 'ユ', 'ヨ'])
    expect(KANA_ROW_COLUMNS['ワ']).toEqual(['ワ'])
  })
})
