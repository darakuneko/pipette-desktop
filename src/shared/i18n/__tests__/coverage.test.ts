// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { flattenTranslations, computeCoverage, stripMetaKeys } from '../coverage'

describe('coverage.ts', () => {
  describe('flattenTranslations', () => {
    it('flattens nested keys with dot separator', () => {
      const flat = flattenTranslations({ common: { save: 'Save', cancel: 'Cancel' } })
      expect(flat).toEqual({ 'common.save': 'Save', 'common.cancel': 'Cancel' })
    })

    it('drops reserved meta keys at the root only', () => {
      const flat = flattenTranslations({
        version: '0.1.0',
        name: 'English',
        common: { save: 'Save' },
      })
      expect(flat).toEqual({ 'common.save': 'Save' })
    })

    it('skips prototype-pollution keys', () => {
      const obj: Record<string, unknown> = { common: { save: 'Save' } }
      Object.defineProperty(obj, '__proto__', { value: { hacked: true }, enumerable: true })
      const flat = flattenTranslations(obj)
      expect(flat['__proto__.hacked']).toBeUndefined()
    })

    it('handles non-object input', () => {
      expect(flattenTranslations(null)).toEqual({})
      expect(flattenTranslations([])).toEqual({})
      expect(flattenTranslations('hello')).toEqual({})
    })
  })

  describe('computeCoverage', () => {
    const base = { version: '0.1.0', name: 'English', a: { b: 'B', c: 'C' }, d: 'D' }

    it('reports 100% when pack covers every base key', () => {
      const pack = { version: '0.1.0', name: 'JA', a: { b: 'びー', c: 'しー' }, d: 'でぃー' }
      const result = computeCoverage(pack, base)
      expect(result.totalKeys).toBe(3)
      expect(result.coveredKeys).toBe(3)
      expect(result.missingKeys).toEqual([])
      expect(result.coverageRatio).toBe(1)
    })

    it('reports partial coverage with missing keys', () => {
      const pack = { version: '0.1.0', name: 'JA', a: { b: 'びー' } }
      const result = computeCoverage(pack, base)
      expect(result.totalKeys).toBe(3)
      expect(result.coveredKeys).toBe(1)
      expect(result.missingKeys.sort()).toEqual(['a.c', 'd'])
      expect(result.coverageRatio).toBeCloseTo(1 / 3)
    })

    it('reports excess keys that are not in the base', () => {
      const pack = { version: '0.1.0', name: 'JA', a: { b: 'びー', c: 'しー' }, d: 'でぃー', extra: 'X' }
      const result = computeCoverage(pack, base)
      expect(result.excessKeys).toContain('extra')
    })

    it('returns 1 ratio when both inputs are empty', () => {
      const result = computeCoverage({}, {})
      expect(result.coverageRatio).toBe(1)
      expect(result.totalKeys).toBe(0)
    })
  })

  describe('stripMetaKeys', () => {
    it('removes name / version at the root', () => {
      const out = stripMetaKeys({ version: '1', name: 'X', common: { ok: 'OK' } })
      expect(out).toEqual({ common: { ok: 'OK' } })
    })

    it('returns empty object for non-object input', () => {
      expect(stripMetaKeys(null)).toEqual({})
      expect(stripMetaKeys([])).toEqual({})
    })
  })
})
