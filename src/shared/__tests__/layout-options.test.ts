import { describe, it, expect } from 'vitest'
import {
  parseLayoutLabels,
  unpackLayoutOptions,
  packLayoutOptions,
} from '../layout-options'

describe('Layout Options', () => {
  it('parses string labels as boolean options', () => {
    const result = parseLayoutLabels(['Split Backspace', 'ISO Enter'])
    expect(result).toHaveLength(2)
    expect(result[0].labels).toEqual(['Split Backspace'])
    expect(result[1].labels).toEqual(['ISO Enter'])
  })

  it('parses array labels as select options', () => {
    const result = parseLayoutLabels([
      ['Bottom Row', 'ANSI', 'Tsangan', 'WKL'],
    ])
    expect(result).toHaveLength(1)
    expect(result[0].labels).toEqual(['Bottom Row', 'ANSI', 'Tsangan', 'WKL'])
  })

  it('unpacks and repacks to same value', () => {
    const labels: (string | string[])[] = [
      'Split BS',
      ['Bottom', 'ANSI', 'Tsangan', 'WKL'],
    ]
    const options = parseLayoutLabels(labels)
    const packed = 5 // some value
    const unpacked = unpackLayoutOptions(packed, options)
    const repacked = packLayoutOptions(unpacked, options)
    expect(repacked).toBe(packed)
  })

  it('handles empty options', () => {
    const result = parseLayoutLabels(undefined)
    expect(result).toEqual([])
  })

  it('round-trips boolean options correctly', () => {
    const options = parseLayoutLabels(['Opt A', 'Opt B'])
    const values = new Map<number, number>([
      [0, 1],
      [1, 0],
    ])
    const packed = packLayoutOptions(values, options)
    const unpacked = unpackLayoutOptions(packed, options)
    expect(unpacked.get(0)).toBe(1)
    expect(unpacked.get(1)).toBe(0)
  })
})
