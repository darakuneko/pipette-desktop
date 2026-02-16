// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isValidFavoriteType, isFavoriteDataFile } from '../favorite-data'

describe('isValidFavoriteType', () => {
  it.each(['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey'])(
    'returns true for %s',
    (type) => {
      expect(isValidFavoriteType(type)).toBe(true)
    },
  )

  it('returns false for invalid strings', () => {
    expect(isValidFavoriteType('qmkSettings')).toBe(false)
    expect(isValidFavoriteType('')).toBe(false)
    expect(isValidFavoriteType('TAPDANCE')).toBe(false)
  })

  it('returns false for non-strings', () => {
    expect(isValidFavoriteType(42)).toBe(false)
    expect(isValidFavoriteType(null)).toBe(false)
    expect(isValidFavoriteType(undefined)).toBe(false)
  })
})

describe('isFavoriteDataFile', () => {
  describe('tapDance', () => {
    it('accepts valid tapDance data', () => {
      const file = {
        type: 'tapDance',
        data: { onTap: 4, onHold: 5, onDoubleTap: 6, onTapHold: 7, tappingTerm: 200 },
      }
      expect(isFavoriteDataFile(file, 'tapDance')).toBe(true)
    })

    it('rejects missing fields', () => {
      const file = { type: 'tapDance', data: { onTap: 4, onHold: 5 } }
      expect(isFavoriteDataFile(file, 'tapDance')).toBe(false)
    })

    it('rejects wrong type field', () => {
      const file = {
        type: 'macro',
        data: { onTap: 4, onHold: 5, onDoubleTap: 6, onTapHold: 7, tappingTerm: 200 },
      }
      expect(isFavoriteDataFile(file, 'tapDance')).toBe(false)
    })

    it('rejects non-number fields', () => {
      const file = {
        type: 'tapDance',
        data: { onTap: 'A', onHold: 5, onDoubleTap: 6, onTapHold: 7, tappingTerm: 200 },
      }
      expect(isFavoriteDataFile(file, 'tapDance')).toBe(false)
    })
  })

  describe('macro', () => {
    it('accepts valid macro data', () => {
      const file = {
        type: 'macro',
        data: [['text', 'Hello'], ['tap', 'KC_A']],
      }
      expect(isFavoriteDataFile(file, 'macro')).toBe(true)
    })

    it('accepts empty macro', () => {
      const file = { type: 'macro', data: [] }
      expect(isFavoriteDataFile(file, 'macro')).toBe(true)
    })

    it('rejects non-array data', () => {
      const file = { type: 'macro', data: 'hello' }
      expect(isFavoriteDataFile(file, 'macro')).toBe(false)
    })

    it('rejects items without string tag', () => {
      const file = { type: 'macro', data: [[42]] }
      expect(isFavoriteDataFile(file, 'macro')).toBe(false)
    })
  })

  describe('combo', () => {
    it('accepts valid combo data', () => {
      const file = {
        type: 'combo',
        data: { key1: 4, key2: 5, key3: 0, key4: 0, output: 10 },
      }
      expect(isFavoriteDataFile(file, 'combo')).toBe(true)
    })

    it('rejects missing fields', () => {
      const file = { type: 'combo', data: { key1: 4, key2: 5 } }
      expect(isFavoriteDataFile(file, 'combo')).toBe(false)
    })
  })

  describe('keyOverride', () => {
    it('accepts valid keyOverride data', () => {
      const file = {
        type: 'keyOverride',
        data: {
          triggerKey: 4,
          replacementKey: 5,
          layers: 0xffff,
          triggerMods: 0,
          negativeMods: 0,
          suppressedMods: 0,
          options: 0,
          enabled: true,
        },
      }
      expect(isFavoriteDataFile(file, 'keyOverride')).toBe(true)
    })

    it('rejects missing enabled boolean', () => {
      const file = {
        type: 'keyOverride',
        data: {
          triggerKey: 4,
          replacementKey: 5,
          layers: 0xffff,
          triggerMods: 0,
          negativeMods: 0,
          suppressedMods: 0,
          options: 0,
        },
      }
      expect(isFavoriteDataFile(file, 'keyOverride')).toBe(false)
    })
  })

  describe('altRepeatKey', () => {
    it('accepts valid altRepeatKey data', () => {
      const file = {
        type: 'altRepeatKey',
        data: { lastKey: 4, altKey: 5, allowedMods: 0, options: 0, enabled: true },
      }
      expect(isFavoriteDataFile(file, 'altRepeatKey')).toBe(true)
    })

    it('rejects non-boolean enabled', () => {
      const file = {
        type: 'altRepeatKey',
        data: { lastKey: 4, altKey: 5, allowedMods: 0, options: 0, enabled: 1 },
      }
      expect(isFavoriteDataFile(file, 'altRepeatKey')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('rejects null', () => {
      expect(isFavoriteDataFile(null, 'tapDance')).toBe(false)
    })

    it('rejects arrays', () => {
      expect(isFavoriteDataFile([], 'tapDance')).toBe(false)
    })

    it('rejects missing data field', () => {
      expect(isFavoriteDataFile({ type: 'tapDance' }, 'tapDance')).toBe(false)
    })
  })
})
