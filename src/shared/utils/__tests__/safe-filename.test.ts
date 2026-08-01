// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { safeFilename, isSafePathSegment, isSafePackId, tsForFilename, tsForExportFilename } from '../safe-filename'

describe('isSafePathSegment', () => {
  it('rejects empty string', () => {
    expect(isSafePathSegment('')).toBe(false)
  })

  it('rejects "."', () => {
    expect(isSafePathSegment('.')).toBe(false)
  })

  it('rejects ".."', () => {
    expect(isSafePathSegment('..')).toBe(false)
  })

  it('rejects a forward-slash separator', () => {
    expect(isSafePathSegment('a/b')).toBe(false)
  })

  it('rejects a backslash separator', () => {
    expect(isSafePathSegment('a\\b')).toBe(false)
  })

  it('accepts a normal filename', () => {
    expect(isSafePathSegment('my-file_1.json')).toBe(true)
  })

  it('accepts unicode segments', () => {
    expect(isSafePathSegment('キーボード設定')).toBe(true)
  })
})

describe('isSafePackId', () => {
  it('accepts a 64-character id', () => {
    expect(isSafePackId('a'.repeat(64))).toBe(true)
  })

  it('rejects a 65-character id', () => {
    expect(isSafePackId('a'.repeat(65))).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isSafePackId('')).toBe(false)
  })

  it('rejects characters outside the allowlist', () => {
    expect(isSafePackId('../evil')).toBe(false)
    expect(isSafePackId('pack/id')).toBe(false)
  })
})

describe('tsForFilename', () => {
  it('replaces every colon with a hyphen', () => {
    const date = new Date('2026-07-31T15:30:45.123Z')
    expect(tsForFilename(date)).toBe('2026-07-31T15-30-45.123Z')
  })

  it('defaults to the current time when no argument is given', () => {
    expect(tsForFilename()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+Z$/)
  })
})

describe('tsForExportFilename', () => {
  it('strips colons, the sub-second fraction, and the T separator', () => {
    const date = new Date('2026-07-31T15:30:45.123Z')
    expect(tsForExportFilename(date)).toBe('2026-07-31-153045')
  })

  it('defaults to the current time when no argument is given', () => {
    expect(tsForExportFilename()).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/)
  })
})

describe('safeFilename', () => {
  it('collapses unsafe characters to a single underscore', () => {
    expect(safeFilename('my file!!name', 'fallback')).toBe('my_file_name')
  })

  it('falls back when the scrubbed result is empty', () => {
    expect(safeFilename('!!!', 'fallback')).toBe('fallback')
  })
})
