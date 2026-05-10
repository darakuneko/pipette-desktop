// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { validatePack, validateName, validateVersion } from '../validate'

describe('validate.ts', () => {
  describe('validateName', () => {
    it('rejects non-string / empty values', () => {
      expect(validateName(undefined)).toMatch(/string/)
      expect(validateName('')).toMatch(/empty/)
      expect(validateName(' ')).toMatch(/empty/)
    })

    it('rejects > 64 characters', () => {
      expect(validateName('a'.repeat(65))).toMatch(/64/)
    })

    it('accepts a sane name', () => {
      expect(validateName('日本語')).toBeNull()
    })
  })

  describe('validateVersion', () => {
    it('accepts semver', () => {
      expect(validateVersion('0.1.0')).toBeNull()
      expect(validateVersion('1.2.3-beta.4')).toBeNull()
    })
    it('rejects non-semver', () => {
      expect(validateVersion('foo')).toMatch(/semver/)
      expect(validateVersion('1.2')).toMatch(/semver/)
    })
  })

  describe('validatePack', () => {
    const validPack = (): Record<string, unknown> => ({
      version: '0.1.0',
      name: '日本語',
      common: { save: '保存' },
    })

    it('accepts a well-formed pack', () => {
      const result = validatePack(validPack())
      expect(result.ok).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.dangerousKeys).toEqual([])
      expect(result.header).toEqual({ name: '日本語', version: '0.1.0' })
    })

    it('rejects non-object input', () => {
      expect(validatePack(null).ok).toBe(false)
      expect(validatePack([]).ok).toBe(false)
      expect(validatePack('hello').ok).toBe(false)
    })

    it('rejects missing name / version', () => {
      const result = validatePack({ common: { save: 's' } })
      expect(result.ok).toBe(false)
    })

    it('flags prototype-pollution keys', () => {
      const pack = validPack()
      pack.constructor = { polluted: 'true' }
      const result = validatePack(pack)
      expect(result.ok).toBe(false)
      expect(result.dangerousKeys.length).toBeGreaterThan(0)
    })

    it('rejects keys containing dot (separator collision)', () => {
      const pack = validPack()
      pack['foo.bar'] = 'x'
      const result = validatePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors.some((e) => /key segment/.test(e))).toBe(true)
    })

    it('rejects non-string leaves', () => {
      const pack = validPack()
      ;(pack.common as Record<string, unknown>).save = 123
      const result = validatePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors.some((e) => /must be a string/.test(e))).toBe(true)
    })

    it('accepts large packs (size enforcement is server-side)', () => {
      const pack = validPack()
      const huge: Record<string, string> = {}
      for (let i = 0; i < 100; i++) huge[`k${String(i)}`] = 'x'.repeat(3000)
      pack.fat = huge
      const result = validatePack(pack)
      expect(result.ok).toBe(true)
    })
  })
})
