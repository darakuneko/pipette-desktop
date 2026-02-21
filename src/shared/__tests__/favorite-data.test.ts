// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  isValidFavoriteType,
  isFavoriteDataFile,
  FAV_EXPORT_KEY_MAP,
  FAV_TYPE_TO_EXPORT_KEY,
  isValidFavExportFile,
} from '../favorite-data'

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

describe('FAV_EXPORT_KEY_MAP / FAV_TYPE_TO_EXPORT_KEY', () => {
  const ALL_FAV_TYPES = ['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey'] as const

  it('roundtrips from export key to FavoriteType and back', () => {
    for (const [exportKey, favType] of Object.entries(FAV_EXPORT_KEY_MAP)) {
      expect(FAV_TYPE_TO_EXPORT_KEY[favType]).toBe(exportKey)
    }
  })

  it('roundtrips from FavoriteType to export key and back', () => {
    for (const [favType, exportKey] of Object.entries(FAV_TYPE_TO_EXPORT_KEY)) {
      expect(FAV_EXPORT_KEY_MAP[exportKey]).toBe(favType)
    }
  })

  it('covers every FavoriteType in FAV_TYPE_TO_EXPORT_KEY', () => {
    for (const t of ALL_FAV_TYPES) {
      expect(FAV_TYPE_TO_EXPORT_KEY).toHaveProperty(t)
    }
  })

  it('covers every FavoriteType as a value in FAV_EXPORT_KEY_MAP', () => {
    const mappedTypes = new Set(Object.values(FAV_EXPORT_KEY_MAP))
    for (const t of ALL_FAV_TYPES) {
      expect(mappedTypes.has(t)).toBe(true)
    }
  })

  it('has the same number of entries in both maps', () => {
    expect(Object.keys(FAV_EXPORT_KEY_MAP).length).toBe(Object.keys(FAV_TYPE_TO_EXPORT_KEY).length)
  })
})

describe('isValidFavExportFile', () => {
  function makeValidExportFile(categories: Record<string, unknown[]> = {}) {
    return {
      app: 'pipette',
      version: 1,
      scope: 'fav',
      exportedAt: '2026-01-01T00:00:00.000Z',
      categories,
    }
  }

  function makeEntry(overrides: Record<string, unknown> = {}) {
    return { label: 'My macro', savedAt: '2026-01-01T00:00:00.000Z', data: [['tap', 'KC_A']], ...overrides }
  }

  it('accepts a valid file with empty categories', () => {
    expect(isValidFavExportFile(makeValidExportFile())).toBe(true)
  })

  it('accepts a valid file with populated categories', () => {
    const file = makeValidExportFile({
      macro: [makeEntry()],
      td: [makeEntry({ label: 'TD 1', data: { onTap: 4, onHold: 5 } })],
    })
    expect(isValidFavExportFile(file)).toBe(true)
  })

  it('accepts a category with multiple entries', () => {
    const file = makeValidExportFile({
      combo: [makeEntry(), makeEntry({ label: 'Second' })],
    })
    expect(isValidFavExportFile(file)).toBe(true)
  })

  it('accepts all valid category keys', () => {
    const file = makeValidExportFile({
      macro: [makeEntry()],
      td: [makeEntry()],
      combo: [makeEntry()],
      ko: [makeEntry()],
      ark: [makeEntry()],
    })
    expect(isValidFavExportFile(file)).toBe(true)
  })

  describe('top-level field validation', () => {
    it('rejects null', () => {
      expect(isValidFavExportFile(null)).toBe(false)
    })

    it('rejects non-object', () => {
      expect(isValidFavExportFile('string')).toBe(false)
    })

    it('rejects array', () => {
      expect(isValidFavExportFile([])).toBe(false)
    })

    it('rejects wrong app', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).app = 'other'
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects wrong version', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).version = 2
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects wrong scope', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).scope = 'keymap'
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects missing exportedAt', () => {
      const file = makeValidExportFile()
      delete (file as Record<string, unknown>).exportedAt
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects non-string exportedAt', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).exportedAt = 12345
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects missing categories', () => {
      const { categories: _, ...rest } = makeValidExportFile()
      expect(isValidFavExportFile(rest)).toBe(false)
    })

    it('rejects categories as array', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).categories = []
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects categories as null', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).categories = null
      expect(isValidFavExportFile(file)).toBe(false)
    })
  })

  describe('category key validation', () => {
    it('rejects unknown category key', () => {
      const file = makeValidExportFile({ unknown: [makeEntry()] })
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects FavoriteType as category key (must use export key)', () => {
      const file = makeValidExportFile({ tapDance: [makeEntry()] })
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects non-array category value', () => {
      const file = makeValidExportFile({ macro: 'not-array' as unknown as unknown[] })
      expect(isValidFavExportFile(file)).toBe(false)
    })
  })

  describe('entry validation', () => {
    it('rejects entry that is not an object', () => {
      const file = makeValidExportFile({ macro: ['not-object'] })
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects entry with missing label', () => {
      const file = makeValidExportFile({ macro: [makeEntry({ label: undefined })] })
      delete (file.categories.macro[0] as Record<string, unknown>).label
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects entry with non-string label', () => {
      const file = makeValidExportFile({ macro: [makeEntry({ label: 42 })] })
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects entry with missing savedAt', () => {
      const file = makeValidExportFile({ macro: [makeEntry({ savedAt: undefined })] })
      delete (file.categories.macro[0] as Record<string, unknown>).savedAt
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects entry with non-string savedAt', () => {
      const file = makeValidExportFile({ macro: [makeEntry({ savedAt: 999 })] })
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects entry with missing data', () => {
      const file = makeValidExportFile({ macro: [makeEntry({ data: undefined })] })
      delete (file.categories.macro[0] as Record<string, unknown>).data
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('accepts entry where data is null (present but null)', () => {
      const file = makeValidExportFile({ macro: [makeEntry({ data: null })] })
      expect(isValidFavExportFile(file)).toBe(true)
    })
  })
})
