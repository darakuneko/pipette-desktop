// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildCsv, escapeCsvField } from '../csv-export'

describe('escapeCsvField', () => {
  it('returns plain values untouched', () => {
    expect(escapeCsvField('hello')).toBe('hello')
    expect(escapeCsvField(42)).toBe('42')
    expect(escapeCsvField(0)).toBe('0')
  })

  it('renders null and undefined as empty', () => {
    expect(escapeCsvField(null)).toBe('')
    expect(escapeCsvField(undefined)).toBe('')
  })

  it('quotes values containing commas, quotes, or newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralizes formula-injection prefixes', () => {
    expect(escapeCsvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(escapeCsvField('+1+1')).toBe("'+1+1")
    expect(escapeCsvField('-2')).toBe("'-2")
    expect(escapeCsvField('@import')).toBe("'@import")
  })

  it('strips leading whitespace before the formula check', () => {
    expect(escapeCsvField('   =SUM(A1)')).toBe("'=SUM(A1)")
    expect(escapeCsvField('\t-2')).toBe("'-2")
  })
})

describe('buildCsv', () => {
  it('joins headers and escaped rows with newlines', () => {
    const csv = buildCsv(
      ['name', 'count'],
      [
        ['alpha', 1],
        ['beta', 2],
      ],
    )
    expect(csv).toBe('name,count\nalpha,1\nbeta,2')
  })

  it('escapes per-field independently across rows', () => {
    const csv = buildCsv(
      ['key', 'note'],
      [
        ['x', 'a,b'],
        ['y', '=danger'],
      ],
    )
    expect(csv).toBe('key,note\nx,"a,b"\ny,\'=danger')
  })

  it('emits a header-only file when there are no rows', () => {
    expect(buildCsv(['a', 'b'], [])).toBe('a,b')
  })
})
