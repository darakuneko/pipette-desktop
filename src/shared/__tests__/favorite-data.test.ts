// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  isValidFavoriteType,
  isFavoriteDataFile,
  FAV_EXPORT_KEY_MAP,
  FAV_TYPE_TO_EXPORT_KEY,
  FAV_KEYCODE_FIELDS,
  isValidFavExportFile,
  serializeFavData,
  deserializeFavData,
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
      version: 2,
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

    it('rejects version 1 (legacy)', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).version = 1
      expect(isValidFavExportFile(file)).toBe(false)
    })

    it('rejects unsupported version', () => {
      const file = makeValidExportFile()
      ;(file as Record<string, unknown>).version = 3
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

describe('FAV_KEYCODE_FIELDS', () => {
  it('lists keycode fields for tapDance (excludes tappingTerm)', () => {
    expect(FAV_KEYCODE_FIELDS.tapDance).toEqual(['onTap', 'onHold', 'onDoubleTap', 'onTapHold'])
  })

  it('lists no fields for macro (already uses QMK names)', () => {
    expect(FAV_KEYCODE_FIELDS.macro).toEqual([])
  })

  it('lists keycode fields for combo', () => {
    expect(FAV_KEYCODE_FIELDS.combo).toEqual(['key1', 'key2', 'key3', 'key4', 'output'])
  })

  it('lists only trigger/replacement for keyOverride (excludes bitmasks)', () => {
    expect(FAV_KEYCODE_FIELDS.keyOverride).toEqual(['triggerKey', 'replacementKey'])
  })

  it('lists only lastKey/altKey for altRepeatKey (excludes bitmasks)', () => {
    expect(FAV_KEYCODE_FIELDS.altRepeatKey).toEqual(['lastKey', 'altKey'])
  })

  it('covers all FavoriteTypes', () => {
    const ALL_FAV_TYPES = ['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey'] as const
    for (const t of ALL_FAV_TYPES) {
      expect(FAV_KEYCODE_FIELDS).toHaveProperty(t)
    }
  })
})

describe('serializeFavData', () => {
  const mockSerialize = (code: number): string => `QMK_${code}`

  it('converts keycode fields in tapDance data', () => {
    const data = { onTap: 4, onHold: 5, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
    const result = serializeFavData('tapDance', data, mockSerialize)
    expect(result).toEqual({
      onTap: 'QMK_4',
      onHold: 'QMK_5',
      onDoubleTap: 'QMK_0',
      onTapHold: 'QMK_0',
      tappingTerm: 200,
    })
  })

  it('converts keycode fields in combo data', () => {
    const data = { key1: 4, key2: 5, key3: 0, key4: 0, output: 10 }
    const result = serializeFavData('combo', data, mockSerialize)
    expect(result).toEqual({
      key1: 'QMK_4',
      key2: 'QMK_5',
      key3: 'QMK_0',
      key4: 'QMK_0',
      output: 'QMK_10',
    })
  })

  it('converts only triggerKey/replacementKey in keyOverride data', () => {
    const data = {
      triggerKey: 4, replacementKey: 5,
      layers: 0xffff, triggerMods: 2, negativeMods: 0,
      suppressedMods: 0, options: 0, enabled: true,
    }
    const result = serializeFavData('keyOverride', data, mockSerialize)
    expect(result).toEqual({
      triggerKey: 'QMK_4', replacementKey: 'QMK_5',
      layers: 0xffff, triggerMods: 2, negativeMods: 0,
      suppressedMods: 0, options: 0, enabled: true,
    })
  })

  it('converts only lastKey/altKey in altRepeatKey data', () => {
    const data = { lastKey: 4, altKey: 5, allowedMods: 0, options: 0, enabled: true }
    const result = serializeFavData('altRepeatKey', data, mockSerialize)
    expect(result).toEqual({
      lastKey: 'QMK_4', altKey: 'QMK_5',
      allowedMods: 0, options: 0, enabled: true,
    })
  })

  it('returns macro data unchanged', () => {
    const data = [['tap', 'KC_A'], ['text', 'hello']]
    const result = serializeFavData('macro', data, mockSerialize)
    expect(result).toEqual(data)
  })

  it('does not mutate the original data object', () => {
    const data = { onTap: 4, onHold: 5, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
    const original = { ...data }
    serializeFavData('tapDance', data, mockSerialize)
    expect(data).toEqual(original)
  })

  it('returns non-object data unchanged', () => {
    expect(serializeFavData('tapDance', null, mockSerialize)).toBeNull()
    expect(serializeFavData('tapDance', 42, mockSerialize)).toBe(42)
  })
})

describe('deserializeFavData', () => {
  const mockDeserialize = (val: string | number): number =>
    typeof val === 'number' ? val : parseInt(val.replace('QMK_', ''), 10)

  it('converts QMK name fields back to numbers in tapDance data', () => {
    const data = { onTap: 'QMK_4', onHold: 'QMK_5', onDoubleTap: 'QMK_0', onTapHold: 'QMK_0', tappingTerm: 200 }
    const result = deserializeFavData('tapDance', data, mockDeserialize)
    expect(result).toEqual({
      onTap: 4, onHold: 5, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200,
    })
  })

  it('passes through already-numeric fields (backward compat v1)', () => {
    const data = { onTap: 4, onHold: 5, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
    const result = deserializeFavData('tapDance', data, mockDeserialize)
    expect(result).toEqual(data)
  })

  it('converts combo data', () => {
    const data = { key1: 'QMK_4', key2: 'QMK_5', key3: 'QMK_0', key4: 'QMK_0', output: 'QMK_10' }
    const result = deserializeFavData('combo', data, mockDeserialize)
    expect(result).toEqual({ key1: 4, key2: 5, key3: 0, key4: 0, output: 10 })
  })

  it('returns macro data unchanged', () => {
    const data = [['tap', 'KC_A'], ['text', 'hello']]
    const result = deserializeFavData('macro', data, mockDeserialize)
    expect(result).toEqual(data)
  })

  it('does not mutate the original data object', () => {
    const data = { onTap: 'QMK_4', onHold: 'QMK_5', onDoubleTap: 'QMK_0', onTapHold: 'QMK_0', tappingTerm: 200 }
    const original = { ...data }
    deserializeFavData('tapDance', data, mockDeserialize)
    expect(data).toEqual(original)
  })

  it('returns non-object data unchanged', () => {
    expect(deserializeFavData('tapDance', null, mockDeserialize)).toBeNull()
  })
})

describe('serializeFavData / deserializeFavData roundtrip', () => {
  const mockSerialize = (code: number): string => `QMK_${code}`
  const mockDeserialize = (val: string | number): number =>
    typeof val === 'number' ? val : parseInt(val.replace('QMK_', ''), 10)

  it.each([
    ['tapDance', { onTap: 48, onHold: 68, onDoubleTap: 230, onTapHold: 226, tappingTerm: 150 }],
    ['combo', { key1: 4, key2: 5, key3: 0, key4: 0, output: 10 }],
    ['keyOverride', { triggerKey: 4, replacementKey: 5, layers: 0xffff, triggerMods: 0, negativeMods: 0, suppressedMods: 0, options: 0, enabled: true }],
    ['altRepeatKey', { lastKey: 4, altKey: 5, allowedMods: 0, options: 0, enabled: true }],
  ] as const)('roundtrips %s data', (type, data) => {
    const serialized = serializeFavData(type, data, mockSerialize)
    const deserialized = deserializeFavData(type, serialized, mockDeserialize)
    expect(deserialized).toEqual(data)
  })
})
