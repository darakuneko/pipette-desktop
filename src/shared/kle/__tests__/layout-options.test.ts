import { describe, it, expect } from 'vitest'
import { decodeLayoutOptions } from '../layout-options'

describe('decodeLayoutOptions', () => {
  it('returns empty map for negative options', () => {
    const result = decodeLayoutOptions(-1, ['Split BS'])
    expect(result.size).toBe(0)
  })

  it('decodes boolean labels (1 bit each)', () => {
    // Two boolean options: reversed order → index 1 uses bit 0, index 0 uses bit 1
    // options = 0b10 = 2 → index 1 = 0, index 0 = 1
    const labels: (string | string[])[] = ['Split BS', 'ISO Enter']
    const result = decodeLayoutOptions(0b10, labels)
    expect(result.get(0)).toBe(1)
    expect(result.get(1)).toBe(0)
  })

  it('decodes 2-choice select label as 1 bit', () => {
    // ['Label', 'A', 'B'] → 2 choices → 1 bit
    const labels: (string | string[])[] = [['Row', 'ANSI', 'ISO']]
    const result = decodeLayoutOptions(1, labels)
    expect(result.get(0)).toBe(1)
  })

  it('decodes 3-choice select label as 2 bits', () => {
    // ['Label', 'A', 'B', 'C'] → 3 choices → 2 bits
    const labels: (string | string[])[] = [['Bottom Row', 'ANSI', 'Tsangan', 'WKL']]
    const result = decodeLayoutOptions(2, labels)
    expect(result.get(0)).toBe(2)
  })

  it('decodes mixed boolean and select labels', () => {
    // labels[0] = boolean (1 bit), labels[1] = 3-choice select (2 bits)
    // Reversed packing: labels[1] uses lowest bits, labels[0] uses next bit
    // options = 0b1_10 = 6 → labels[1] = 2 (bottom 2 bits), labels[0] = 1 (next bit)
    const labels: (string | string[])[] = [
      'Split BS',
      ['Bottom', 'ANSI', 'Tsangan', 'WKL'],
    ]
    const result = decodeLayoutOptions(0b110, labels)
    expect(result.get(0)).toBe(1)
    expect(result.get(1)).toBe(2)
  })

  it('returns all zeros for options = 0', () => {
    const labels: (string | string[])[] = [
      'Opt A',
      ['Row', 'A', 'B', 'C'],
    ]
    const result = decodeLayoutOptions(0, labels)
    expect(result.get(0)).toBe(0)
    expect(result.get(1)).toBe(0)
  })

  it('handles empty labels array', () => {
    const result = decodeLayoutOptions(42, [])
    expect(result.size).toBe(0)
  })
})
