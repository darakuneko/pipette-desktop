// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useDevicePrefs } from '../useDevicePrefs'
import { setupAppConfigMock, renderHookWithConfig } from './test-helpers'

// Mock vialAPI for IPC calls
const mockPipetteSettingsGet = vi.fn<(uid: string) => Promise<{ _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] } | null>>()
const mockPipetteSettingsSet = vi.fn<(uid: string, prefs: { _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] }) => Promise<{ success: boolean }>>()

beforeEach(() => {
  vi.clearAllMocks()
  mockPipetteSettingsGet.mockReset()
  mockPipetteSettingsSet.mockReset()
  mockPipetteSettingsGet.mockResolvedValue(null)
  mockPipetteSettingsSet.mockResolvedValue({ success: true })
})

function setupMocks(configOverrides: Parameters<typeof setupAppConfigMock>[0] = {}) {
  const mocks = setupAppConfigMock(configOverrides)
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...((window as Record<string, unknown>).vialAPI as Record<string, unknown>),
      pipetteSettingsGet: mockPipetteSettingsGet,
      pipetteSettingsSet: mockPipetteSettingsSet,
    },
    writable: true,
    configurable: true,
  })
  return mocks
}

describe('useDevicePrefs', () => {
  describe('defaults', () => {
    it('returns qwerty and true as initial defaults', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.defaultLayout).toBe('qwerty')
      expect(result.current.defaultAutoAdvance).toBe(true)
    })

    it('reads stored default layout from config', async () => {
      setupMocks({ defaultKeyboardLayout: 'dvorak' })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.defaultLayout).toBe('dvorak')
    })

    it('reads stored default autoAdvance from config', async () => {
      setupMocks({ defaultAutoAdvance: false })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.defaultAutoAdvance).toBe(false)
    })

    it('setDefaultLayout persists via IPC', async () => {
      const { mockAppConfigSet } = setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      act(() => {
        result.current.setDefaultLayout('colemak')
      })
      expect(result.current.defaultLayout).toBe('colemak')
      expect(mockAppConfigSet).toHaveBeenCalledWith('defaultKeyboardLayout', 'colemak')
    })

    it('setDefaultAutoAdvance persists via IPC', async () => {
      const { mockAppConfigSet } = setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      act(() => {
        result.current.setDefaultAutoAdvance(false)
      })
      expect(result.current.defaultAutoAdvance).toBe(false)
      expect(mockAppConfigSet).toHaveBeenCalledWith('defaultAutoAdvance', false)
    })
  })

  describe('applyDevicePrefs', () => {
    it('applies defaults for new device and saves via IPC', async () => {
      setupMocks({ defaultKeyboardLayout: 'dvorak', defaultAutoAdvance: false })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.layout).toBe('dvorak')
      expect(result.current.autoAdvance).toBe(false)
      expect(result.current.layerNames).toEqual([])

      expect(mockPipetteSettingsGet).toHaveBeenCalledWith('0xAABB')
      expect(mockPipetteSettingsSet).toHaveBeenCalledWith('0xAABB', {
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: false,
        layerNames: [],
        typingTestResults: [],
      })
    })

    it('restores existing per-device prefs from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'colemak',
        autoAdvance: false,
        layerNames: ['Base', 'Fn'],
      })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.layout).toBe('colemak')
      expect(result.current.autoAdvance).toBe(false)
      expect(result.current.layerNames).toEqual(['Base', 'Fn'])
      expect(mockPipetteSettingsSet).not.toHaveBeenCalled()
    })

    it('does not overwrite existing per-device prefs with defaults', async () => {
      setupMocks({ defaultKeyboardLayout: 'dvorak' })
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'german',
        autoAdvance: true,
        layerNames: [],
      })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.layout).toBe('german')
    })
  })

  describe('per-device setters', () => {
    it('setLayout saves per-device prefs via IPC after applyDevicePrefs', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsSet.mockClear()
      act(() => {
        result.current.setLayout('french')
      })

      expect(result.current.layout).toBe('french')
      expect(mockPipetteSettingsSet).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        _rev: 1,
        keyboardLayout: 'french',
      }))
    })

    it('setAutoAdvance saves per-device prefs via IPC after applyDevicePrefs', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsSet.mockClear()
      act(() => {
        result.current.setAutoAdvance(false)
      })

      expect(result.current.autoAdvance).toBe(false)
      expect(mockPipetteSettingsSet).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        _rev: 1,
        autoAdvance: false,
      }))
    })

    it('setLayerNames saves via IPC and updates state', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsSet.mockClear()
      act(() => {
        result.current.setLayerNames(['Base', 'Nav', 'Sym'])
      })

      expect(result.current.layerNames).toEqual(['Base', 'Nav', 'Sym'])
      expect(mockPipetteSettingsSet).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        _rev: 1,
        layerNames: ['Base', 'Nav', 'Sym'],
      }))
    })

    it('setLayout does not overwrite layerNames', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: ['Base', 'Fn'],
      })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsSet.mockClear()
      act(() => {
        result.current.setLayout('dvorak')
      })

      const call = mockPipetteSettingsSet.mock.calls[0]
      expect(call[1].layerNames).toEqual(['Base', 'Fn'])
    })
  })

  describe('invalid data fallback', () => {
    it('falls back to qwerty for invalid default layout', async () => {
      setupMocks({ defaultKeyboardLayout: 'invalid-layout' })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.defaultLayout).toBe('qwerty')
    })

    it('falls back to defaults when IPC returns invalid data', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'nonexistent',
        autoAdvance: false,
        layerNames: [],
      } as { _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      // layout falls back to default (qwerty), autoAdvance kept from stored
      expect(result.current.layout).toBe('qwerty')
      expect(result.current.autoAdvance).toBe(false)
    })

    it('falls back to configured defaults when per-device prefs have invalid layout', async () => {
      setupMocks({ defaultKeyboardLayout: 'dvorak' })
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'nonexistent',
        autoAdvance: false,
        layerNames: [],
      } as { _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      // layout falls back to configured default (dvorak), autoAdvance kept from stored
      expect(result.current.layout).toBe('dvorak')
      expect(result.current.autoAdvance).toBe(false)
    })

    it('filters out malformed typingTestResults from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestResults: [
          { date: '2024-01-01', wpm: 60, accuracy: 95, wordCount: 30, correctChars: 100, incorrectChars: 5, durationSeconds: 30 },
          null,
          { wpm: 50 },
          'not-an-object',
          42,
          { date: '2024-01-02', wpm: 80, accuracy: 97, wordCount: 30, correctChars: 120, incorrectChars: 3, durationSeconds: 25 },
        ],
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      // Only the 2 valid entries should survive
      expect(result.current.typingTestResults).toHaveLength(2)
      expect(result.current.typingTestResults[0].wpm).toBe(60)
      expect(result.current.typingTestResults[1].wpm).toBe(80)
    })

    it('falls back to defaults when IPC fails', async () => {
      setupMocks({ defaultKeyboardLayout: 'dvorak' })
      mockPipetteSettingsGet.mockRejectedValue(new Error('IPC error'))

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.layout).toBe('dvorak')
      expect(result.current.autoAdvance).toBe(true)
    })
  })

  describe('race guard', () => {
    it('discards stale applyDevicePrefs result when UID changes', async () => {
      setupMocks()
      let resolveFirst: (value: { _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] } | null) => void
      const firstPromise = new Promise<{ _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] } | null>((resolve) => {
        resolveFirst = resolve
      })
      mockPipetteSettingsGet
        .mockReturnValueOnce(firstPromise)
        .mockResolvedValueOnce({ _rev: 1, keyboardLayout: 'colemak', autoAdvance: true, layerNames: [] })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})

      // Start first apply (will be pending)
      let firstDone = false
      act(() => {
        result.current.applyDevicePrefs('uid-1').then(() => { firstDone = true })
      })

      // Start second apply immediately (uid changes)
      await act(async () => {
        await result.current.applyDevicePrefs('uid-2')
      })

      // Resolve the first promise (stale)
      await act(async () => {
        resolveFirst!({ _rev: 1, keyboardLayout: 'german', autoAdvance: false, layerNames: [] })
        // Let microtasks settle
        await new Promise((r) => setTimeout(r, 0))
      })

      // Should have uid-2's prefs, not uid-1's stale result
      expect(firstDone).toBe(true)
      expect(result.current.layout).toBe('colemak')
      expect(result.current.autoAdvance).toBe(true)
    })
  })

  describe('typingTestConfig persistence', () => {
    it('restores typingTestConfig from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'time', duration: 60, punctuation: true, numbers: false },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'time',
        duration: 60,
        punctuation: true,
        numbers: false,
      })
    })

    it('restores typingTestLanguage from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestLanguage: 'english_1k',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestLanguage).toBe('english_1k')
    })

    it('setTypingTestConfig saves via IPC', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsSet.mockClear()

      act(() => {
        result.current.setTypingTestConfig({ mode: 'words', wordCount: 60, punctuation: true, numbers: false })
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 60,
        punctuation: true,
        numbers: false,
      })
      expect(mockPipetteSettingsSet).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        typingTestConfig: { mode: 'words', wordCount: 60, punctuation: true, numbers: false },
      }))
    })

    it('setTypingTestLanguage saves via IPC', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsSet.mockClear()

      act(() => {
        result.current.setTypingTestLanguage('english_5k')
      })

      expect(result.current.typingTestLanguage).toBe('english_5k')
      expect(mockPipetteSettingsSet).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        typingTestLanguage: 'english_5k',
      }))
    })

    it('returns undefined for typingTestConfig/typingTestLanguage when not stored', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      })

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toBeUndefined()
      expect(result.current.typingTestLanguage).toBeUndefined()
    })

    it('ignores invalid typingTestConfig from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'invalid' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toBeUndefined()
    })

    it('accepts any non-empty string as typingTestLanguage from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestLanguage: 'klingon',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestLanguage).toBe('klingon')
    })

    it('ignores empty string typingTestLanguage from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestLanguage: '',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestLanguage).toBeUndefined()
    })

    it('rejects typingTestConfig with NaN wordCount', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'words', wordCount: NaN, punctuation: false, numbers: false },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toBeUndefined()
    })

    it('rejects typingTestConfig with negative duration', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'time', duration: -5, punctuation: false, numbers: false },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toBeUndefined()
    })

    it('rejects typingTestConfig with Infinity wordCount', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'words', wordCount: Infinity, punctuation: false, numbers: false },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toBeUndefined()
    })

    it('rejects typingTestConfig that is an array', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: [1, 2, 3],
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toBeUndefined()
    })

    it('validates quote mode config from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'quote', quoteLength: 'medium' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'quote',
        quoteLength: 'medium',
      })
    })
  })

  describe('remapLabel and isRemapped', () => {
    it('remapLabel delegates to remapKeycode with current layout', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      // Default qwerty: identity
      expect(result.current.remapLabel('KC_A')).toBe('KC_A')
    })

    it('remapLabel updates after layout change', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setLayout('dvorak')
      })
      expect(result.current.remapLabel('KC_S')).toBe('O')
    })

    it('isRemapped returns false for qwerty', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.isRemapped('KC_A')).toBe(false)
    })
  })
})
