// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useKeyboardLayout, remapKeycode, remapLabel, isRemappedKeycode } from '../useKeyboardLayout'
import { setupAppConfigMock, renderHookWithConfig } from './test-helpers'
import { KEYBOARD_LAYOUTS, LAYOUT_BY_ID } from '../../data/keyboard-layouts'

const COMPOSITE_TEST_LAYOUT_ID = '__composite-test__'

function withCompositeTestLayout(
  compositeLabels: Record<string, string>,
  body: () => void,
): void {
  const def = {
    id: COMPOSITE_TEST_LAYOUT_ID,
    name: 'Composite Test',
    map: { KC_A: 'カスタムA' },
    compositeLabels,
  }
  const insertedAt = KEYBOARD_LAYOUTS.push(def) - 1
  LAYOUT_BY_ID.set(COMPOSITE_TEST_LAYOUT_ID, def)
  try {
    body()
  } finally {
    LAYOUT_BY_ID.delete(COMPOSITE_TEST_LAYOUT_ID)
    if (KEYBOARD_LAYOUTS[insertedAt] === def) {
      KEYBOARD_LAYOUTS.splice(insertedAt, 1)
    }
  }
}

describe('remapKeycode', () => {
  describe('QWERTY (identity)', () => {
    it('returns the same qmkId for QWERTY layout', () => {
      expect(remapKeycode('KC_A', 'qwerty')).toBe('KC_A')
      expect(remapKeycode('KC_S', 'qwerty')).toBe('KC_S')
      expect(remapKeycode('KC_Z', 'qwerty')).toBe('KC_Z')
    })

    it('passes through non-letter keycodes unchanged', () => {
      expect(remapKeycode('KC_ENTER', 'qwerty')).toBe('KC_ENTER')
      expect(remapKeycode('KC_SPACE', 'qwerty')).toBe('KC_SPACE')
      expect(remapKeycode('KC_F1', 'qwerty')).toBe('KC_F1')
    })
  })

  // Dvorak (and friends) are no longer built-in after the Key Labels
  // migration; they are downloaded into the Key Label store at runtime.
  // The store-aware path is exercised by useKeyLabelLookup integration
  // tests, so the standalone `remapKeycode` helper falls back to qwerty
  // identity for any non-built-in id and these expectations no longer
  // apply.
  describe.skip('Dvorak mapping (display strings)', () => {
    it('remaps letter keys to display strings', () => {
      expect(remapKeycode('KC_Q', 'dvorak')).toBe("'")
      expect(remapKeycode('KC_W', 'dvorak')).toBe(',')
      expect(remapKeycode('KC_E', 'dvorak')).toBe('.')
      expect(remapKeycode('KC_R', 'dvorak')).toBe('P')
      expect(remapKeycode('KC_T', 'dvorak')).toBe('Y')
      expect(remapKeycode('KC_Y', 'dvorak')).toBe('F')
      expect(remapKeycode('KC_U', 'dvorak')).toBe('G')
      expect(remapKeycode('KC_I', 'dvorak')).toBe('C')
      expect(remapKeycode('KC_O', 'dvorak')).toBe('R')
      expect(remapKeycode('KC_P', 'dvorak')).toBe('L')
    })

    it('remaps home row to display strings', () => {
      expect(remapKeycode('KC_A', 'dvorak')).toBe('A')
      expect(remapKeycode('KC_S', 'dvorak')).toBe('O')
      expect(remapKeycode('KC_D', 'dvorak')).toBe('E')
      expect(remapKeycode('KC_F', 'dvorak')).toBe('U')
      expect(remapKeycode('KC_G', 'dvorak')).toBe('I')
      expect(remapKeycode('KC_H', 'dvorak')).toBe('D')
      expect(remapKeycode('KC_J', 'dvorak')).toBe('H')
      expect(remapKeycode('KC_K', 'dvorak')).toBe('T')
      expect(remapKeycode('KC_L', 'dvorak')).toBe('N')
      expect(remapKeycode('KC_SCOLON', 'dvorak')).toBe('S')
      expect(remapKeycode('KC_QUOTE', 'dvorak')).toBe('-')
    })

    it('remaps bottom row to display strings', () => {
      expect(remapKeycode('KC_Z', 'dvorak')).toBe(';')
      expect(remapKeycode('KC_X', 'dvorak')).toBe('Q')
      expect(remapKeycode('KC_C', 'dvorak')).toBe('J')
      expect(remapKeycode('KC_V', 'dvorak')).toBe('K')
      expect(remapKeycode('KC_B', 'dvorak')).toBe('X')
      expect(remapKeycode('KC_N', 'dvorak')).toBe('B')
      expect(remapKeycode('KC_M', 'dvorak')).toBe('M')
      expect(remapKeycode('KC_COMMA', 'dvorak')).toBe('W')
      expect(remapKeycode('KC_DOT', 'dvorak')).toBe('V')
      expect(remapKeycode('KC_SLASH', 'dvorak')).toBe('Z')
    })

    it('passes through non-mapped keycodes unchanged', () => {
      expect(remapKeycode('KC_ENTER', 'dvorak')).toBe('KC_ENTER')
      expect(remapKeycode('KC_SPACE', 'dvorak')).toBe('KC_SPACE')
      expect(remapKeycode('KC_F1', 'dvorak')).toBe('KC_F1')
      expect(remapKeycode('KC_LSHIFT', 'dvorak')).toBe('KC_LSHIFT')
    })
  })

  describe.skip('Colemak mapping (display strings)', () => {
    it('remaps letter keys to display strings', () => {
      expect(remapKeycode('KC_Q', 'colemak')).toBe('KC_Q') // not in map
      expect(remapKeycode('KC_W', 'colemak')).toBe('KC_W') // not in map
      expect(remapKeycode('KC_E', 'colemak')).toBe('F')
      expect(remapKeycode('KC_R', 'colemak')).toBe('P')
      expect(remapKeycode('KC_T', 'colemak')).toBe('G')
      expect(remapKeycode('KC_Y', 'colemak')).toBe('J')
      expect(remapKeycode('KC_U', 'colemak')).toBe('L')
      expect(remapKeycode('KC_I', 'colemak')).toBe('U')
      expect(remapKeycode('KC_O', 'colemak')).toBe('Y')
      expect(remapKeycode('KC_P', 'colemak')).toBe(';')
    })

    it('remaps home row to display strings', () => {
      expect(remapKeycode('KC_A', 'colemak')).toBe('KC_A') // not in map
      expect(remapKeycode('KC_S', 'colemak')).toBe('R')
      expect(remapKeycode('KC_D', 'colemak')).toBe('S')
      expect(remapKeycode('KC_F', 'colemak')).toBe('T')
      expect(remapKeycode('KC_G', 'colemak')).toBe('D')
      expect(remapKeycode('KC_H', 'colemak')).toBe('KC_H') // not in map
      expect(remapKeycode('KC_J', 'colemak')).toBe('N')
      expect(remapKeycode('KC_K', 'colemak')).toBe('E')
      expect(remapKeycode('KC_L', 'colemak')).toBe('I')
      expect(remapKeycode('KC_SCOLON', 'colemak')).toBe('O')
    })

    it('remaps bottom row to display strings', () => {
      expect(remapKeycode('KC_Z', 'colemak')).toBe('KC_Z') // not in map
      expect(remapKeycode('KC_N', 'colemak')).toBe('K')
      expect(remapKeycode('KC_M', 'colemak')).toBe('KC_M') // not in map
    })

    it('passes through non-mapped keycodes unchanged', () => {
      expect(remapKeycode('KC_ENTER', 'colemak')).toBe('KC_ENTER')
      expect(remapKeycode('KC_TAB', 'colemak')).toBe('KC_TAB')
      expect(remapKeycode('KC_BSPACE', 'colemak')).toBe('KC_BSPACE')
    })
  })

  describe.skip('Japanese mapping', () => {
    it('remaps Japanese-specific keys to display strings', () => {
      expect(remapKeycode('KC_LBRACKET', 'japanese')).toBe('`\n@')
      expect(remapKeycode('KC_RBRACKET', 'japanese')).toBe('{\n[')
      expect(remapKeycode('KC_GRAVE', 'japanese')).toBe('半角\n全角')
      expect(remapKeycode('KC_SCOLON', 'japanese')).toBe('+\n;')
      expect(remapKeycode('KC_QUOTE', 'japanese')).toBe('*\n:')
    })

    it('passes through unmapped keys', () => {
      expect(remapKeycode('KC_A', 'japanese')).toBe('KC_A')
      expect(remapKeycode('KC_Q', 'japanese')).toBe('KC_Q')
    })
  })

  describe.skip('German mapping', () => {
    it('remaps German-specific keys to display strings', () => {
      expect(remapKeycode('KC_LBRACKET', 'german')).toBe('Ü')
      expect(remapKeycode('KC_SCOLON', 'german')).toBe('Ö')
      expect(remapKeycode('KC_QUOTE', 'german')).toBe('Ä')
      expect(remapKeycode('KC_Y', 'german')).toBe('Z')
      expect(remapKeycode('KC_Z', 'german')).toBe('Y')
      expect(remapKeycode('KC_MINUS', 'german')).toBe('?\nß')
    })
  })

  describe.skip('French mapping', () => {
    it('remaps French AZERTY keys to display strings', () => {
      expect(remapKeycode('KC_Q', 'french')).toBe('A')
      expect(remapKeycode('KC_W', 'french')).toBe('Z')
      expect(remapKeycode('KC_A', 'french')).toBe('Q')
      expect(remapKeycode('KC_Z', 'french')).toBe('W')
      expect(remapKeycode('KC_SCOLON', 'french')).toBe('M')
      expect(remapKeycode('KC_GRAVE', 'french')).toBe('²')
    })
  })

  describe.skip('Russian mapping', () => {
    it('remaps Russian keys to display strings', () => {
      expect(remapKeycode('KC_Q', 'russian')).toBe('Q\nЙ')
      expect(remapKeycode('KC_A', 'russian')).toBe('A\nФ')
      expect(remapKeycode('KC_Z', 'russian')).toBe('Z\nЯ')
    })
  })
})

describe('isRemappedKeycode', () => {
  it('returns false for QWERTY (no remap table)', () => {
    expect(isRemappedKeycode('KC_Q', 'qwerty')).toBe(false)
    expect(isRemappedKeycode('KC_A', 'qwerty')).toBe(false)
  })

  // German / Japanese / Dvorak / Colemak / French / Russian are no
  // longer built-in after the Key Labels migration; they live in the
  // local Key Label store. The async store path is exercised by
  // useKeyLabelLookup integration tests, so the standalone
  // `isRemappedKeycode` helper only tests QWERTY identity here.
  it.skip('returns true for remapped keys in German layout (legacy)', () => {})
  it.skip('returns false for non-remapped keys in German layout (legacy)', () => {})
  it.skip('returns true for remapped keys in Japanese layout (legacy)', () => {})
  it.skip('returns false for non-remapped keys in Japanese layout (legacy)', () => {})
})

describe('remapLabel (composite override)', () => {
  it('returns the composite label when defined', () => {
    withCompositeTestLayout({ 'LALT(KC_L)': 'Alt L' }, () => {
      expect(remapLabel('LALT(KC_L)', COMPOSITE_TEST_LAYOUT_ID)).toBe('Alt L')
    })
  })

  it('falls back to basic-key map when composite has no entry', () => {
    withCompositeTestLayout({ 'LALT(KC_L)': 'Alt L' }, () => {
      // Basic key still uses `map`
      expect(remapLabel('KC_A', COMPOSITE_TEST_LAYOUT_ID)).toBe('カスタムA')
    })
  })

  it('passes the qmkId through when neither table covers it', () => {
    withCompositeTestLayout({ 'LALT(KC_L)': 'Alt L' }, () => {
      expect(remapLabel('KC_Z', COMPOSITE_TEST_LAYOUT_ID)).toBe('KC_Z')
    })
  })

  it('still works for layouts without compositeLabels (qwerty)', () => {
    expect(remapLabel('KC_A', 'qwerty')).toBe('KC_A')
    expect(remapLabel('LALT(KC_L)', 'qwerty')).toBe('LALT(KC_L)')
  })

  // Dvorak / Japanese have moved to the Key Label store; the standalone
  // `remapLabel` helper now falls back to the qmkId for any non-built-in
  // id. Store-aware remapping is covered in useKeyLabelLookup tests.
  it.skip('preserves existing remapKeycode behavior on layouts that only define map (legacy)', () => {})

  it('marks composite-only entries as remapped', () => {
    withCompositeTestLayout({ 'LALT(KC_L)': 'Alt L' }, () => {
      expect(isRemappedKeycode('LALT(KC_L)', COMPOSITE_TEST_LAYOUT_ID)).toBe(true)
      // basic-key remap also still detected
      expect(isRemappedKeycode('KC_A', COMPOSITE_TEST_LAYOUT_ID)).toBe(true)
      expect(isRemappedKeycode('KC_Z', COMPOSITE_TEST_LAYOUT_ID)).toBe(false)
    })
  })

  it('treats an empty compositeLabels object as no-op', () => {
    withCompositeTestLayout({}, () => {
      expect(remapLabel('LALT(KC_L)', COMPOSITE_TEST_LAYOUT_ID)).toBe('LALT(KC_L)')
      expect(isRemappedKeycode('LALT(KC_L)', COMPOSITE_TEST_LAYOUT_ID)).toBe(false)
    })
  })

  it('does not affect remapKeycode (basic-key-only) lookups', () => {
    withCompositeTestLayout({ 'LALT(KC_L)': 'Alt L' }, () => {
      // remapKeycode still ignores compositeLabels
      expect(remapKeycode('LALT(KC_L)', COMPOSITE_TEST_LAYOUT_ID)).toBe('LALT(KC_L)')
    })
  })
})

describe('useKeyboardLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults to qwerty', async () => {
    setupAppConfigMock()
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.layout).toBe('qwerty')
  })

  it('restores layout from config', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'dvorak' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.layout).toBe('dvorak')
  })

  it('changes layout and persists via IPC', async () => {
    const { mockAppConfigSet } = setupAppConfigMock()
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    act(() => {
      result.current.setLayout('colemak')
    })
    expect(result.current.layout).toBe('colemak')
    expect(mockAppConfigSet).toHaveBeenCalledWith('currentKeyboardLayout', 'colemak')
  })

  it('remapLabel returns identity for qwerty', async () => {
    setupAppConfigMock()
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.remapLabel('KC_S')).toBe('KC_S')
    expect(result.current.remapLabel('KC_A')).toBe('KC_A')
  })

  // After the Key Labels migration only QWERTY is built-in; non-QWERTY
  // remap is exercised via useKeyLabelLookup with IPC mocks, not here.
  it.skip('remapLabel remaps for dvorak (display strings) (legacy)', async () => {})
  it.skip('remapLabel remaps for colemak (display strings) (legacy)', async () => {})
  it.skip('remapLabel updates when layout changes (legacy)', async () => {})

  it('keeps any non-empty stored layout id (was: ignores invalid)', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'invalid-layout' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    // The id is preserved; remap falls back to the qmkId until the
    // store loads a matching entry.
    expect(result.current.layout).toBe('invalid-layout')
  })

  it('supports new layout IDs from config', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'japanese' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.layout).toBe('japanese')
    // Without a Key Label store entry the remap defaults to qmkId.
    expect(result.current.remapLabel('KC_GRAVE')).toBe('KC_GRAVE')
  })
})
