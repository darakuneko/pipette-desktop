// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useKeyboardLayout, remapKeycode, isRemappedKeycode } from '../useKeyboardLayout'
import { setupAppConfigMock, renderHookWithConfig } from './test-helpers'

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

  describe('Dvorak mapping (display strings)', () => {
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

  describe('Colemak mapping (display strings)', () => {
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

  describe('Japanese mapping', () => {
    it('remaps Japanese-specific keys to display strings', () => {
      expect(remapKeycode('KC_LBRACKET', 'japanese')).toBe('`\n@')
      expect(remapKeycode('KC_RBRACKET', 'japanese')).toBe('{\n[')
      expect(remapKeycode('KC_GRAVE', 'japanese')).toBe('HAN/\nZEN')
      expect(remapKeycode('KC_SCOLON', 'japanese')).toBe('+\n;')
      expect(remapKeycode('KC_QUOTE', 'japanese')).toBe('*\n:')
    })

    it('passes through unmapped keys', () => {
      expect(remapKeycode('KC_A', 'japanese')).toBe('KC_A')
      expect(remapKeycode('KC_Q', 'japanese')).toBe('KC_Q')
    })
  })

  describe('German mapping', () => {
    it('remaps German-specific keys to display strings', () => {
      expect(remapKeycode('KC_LBRACKET', 'german')).toBe('Ü')
      expect(remapKeycode('KC_SCOLON', 'german')).toBe('Ö')
      expect(remapKeycode('KC_QUOTE', 'german')).toBe('Ä')
      expect(remapKeycode('KC_Y', 'german')).toBe('Z')
      expect(remapKeycode('KC_Z', 'german')).toBe('Y')
      expect(remapKeycode('KC_MINUS', 'german')).toBe('?\nß')
    })
  })

  describe('French mapping', () => {
    it('remaps French AZERTY keys to display strings', () => {
      expect(remapKeycode('KC_Q', 'french')).toBe('A')
      expect(remapKeycode('KC_W', 'french')).toBe('Z')
      expect(remapKeycode('KC_A', 'french')).toBe('Q')
      expect(remapKeycode('KC_Z', 'french')).toBe('W')
      expect(remapKeycode('KC_SCOLON', 'french')).toBe('M')
      expect(remapKeycode('KC_GRAVE', 'french')).toBe('²')
    })
  })

  describe('Russian mapping', () => {
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

  it('returns true for remapped keys in German layout', () => {
    expect(isRemappedKeycode('KC_Y', 'german')).toBe(true)
    expect(isRemappedKeycode('KC_Z', 'german')).toBe(true)
    expect(isRemappedKeycode('KC_LBRACKET', 'german')).toBe(true)
    expect(isRemappedKeycode('KC_SCOLON', 'german')).toBe(true)
  })

  it('returns false for non-remapped keys in German layout', () => {
    expect(isRemappedKeycode('KC_A', 'german')).toBe(false)
    expect(isRemappedKeycode('KC_ENTER', 'german')).toBe(false)
  })

  it('returns true for remapped keys in Japanese layout', () => {
    expect(isRemappedKeycode('KC_GRAVE', 'japanese')).toBe(true)
    expect(isRemappedKeycode('KC_LBRACKET', 'japanese')).toBe(true)
  })

  it('returns false for non-remapped keys in Japanese layout', () => {
    expect(isRemappedKeycode('KC_A', 'japanese')).toBe(false)
    expect(isRemappedKeycode('KC_Q', 'japanese')).toBe(false)
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

  it('remapLabel remaps for dvorak (display strings)', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'dvorak' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.remapLabel('KC_S')).toBe('O')
    expect(result.current.remapLabel('KC_D')).toBe('E')
  })

  it('remapLabel remaps for colemak (display strings)', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'colemak' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.remapLabel('KC_S')).toBe('R')
    expect(result.current.remapLabel('KC_J')).toBe('N')
  })

  it('remapLabel updates when layout changes', async () => {
    setupAppConfigMock()
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.remapLabel('KC_S')).toBe('KC_S')

    act(() => {
      result.current.setLayout('colemak')
    })
    expect(result.current.remapLabel('KC_S')).toBe('R')
  })

  it('ignores invalid stored values', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'invalid-layout' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.layout).toBe('qwerty')
  })

  it('supports new layout IDs from config', async () => {
    setupAppConfigMock({ currentKeyboardLayout: 'japanese' })
    const { result } = renderHookWithConfig(() => useKeyboardLayout())
    await act(async () => {})
    expect(result.current.layout).toBe('japanese')
    expect(result.current.remapLabel('KC_GRAVE')).toBe('HAN/\nZEN')
  })
})
