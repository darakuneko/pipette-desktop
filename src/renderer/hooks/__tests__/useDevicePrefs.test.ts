// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useDevicePrefs } from '../useDevicePrefs'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from './test-helpers'

// Mock vialAPI for IPC calls
const mockPipetteSettingsGet = vi.fn<(uid: string) => Promise<{ _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[] } | null>>()
const mockPipetteSettingsPatch = vi.fn<(uid: string, prefs: { _rev: 1; keyboardLayout: string; autoAdvance: boolean; layerNames: string[]; viewMatrix?: Record<string, { row: number; col: number }> | null }) => Promise<{ success: boolean }>>()

beforeEach(() => {
  vi.clearAllMocks()
  mockPipetteSettingsGet.mockReset()
  mockPipetteSettingsPatch.mockReset()
  mockPipetteSettingsGet.mockResolvedValue(null)
  mockPipetteSettingsPatch.mockResolvedValue({ success: true })
})

function setupMocks(configOverrides: Parameters<typeof setupAppConfigMock>[0] = {}) {
  const mocks = setupAppConfigMock(configOverrides)
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...vialAPIMock(),
      pipetteSettingsGet: mockPipetteSettingsGet,
      pipetteSettingsPatch: mockPipetteSettingsPatch,
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
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: false,
        layerPanelOpen: true,
        basicViewType: 'ansi',
        layerNames: [],
        typingTestResults: [],
      }))
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
      expect(mockPipetteSettingsPatch).not.toHaveBeenCalled()
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
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setLayout('french')
      })

      expect(result.current.layout).toBe('french')
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
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
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setAutoAdvance(false)
      })

      expect(result.current.autoAdvance).toBe(false)
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
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
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setLayerNames(['Base', 'Nav', 'Sym'])
      })

      expect(result.current.layerNames).toEqual(['Base', 'Nav', 'Sym'])
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
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
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setLayout('dvorak')
      })

      const call = mockPipetteSettingsPatch.mock.calls[0]
      expect(call[1].layerNames).toEqual(['Base', 'Fn'])
    })
  })

  // Plan-qwerty-select-no-rewrite Phase K: `keyboardLayout` and
  // `keymapWritten` are always written in the SAME patch via the atomic
  // `setKeyboardLayoutState` setter, so no intermediate render (or
  // persisted file) ever holds a mismatched pair.
  describe('keymapWritten / setKeyboardLayoutState (Plan-qwerty-select-no-rewrite Phase K)', () => {
    it('setKeyboardLayoutState persists keyboardLayout and keymapWritten together in one PATCH', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setKeyboardLayoutState('eucalyn-id', true)
      })

      expect(result.current.layout).toBe('eucalyn-id')
      expect(result.current.keymapWritten).toBe(true)
      expect(mockPipetteSettingsPatch).toHaveBeenCalledTimes(1)
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        keyboardLayout: 'eucalyn-id',
        keymapWritten: true,
      }))
    })

    it('setLayout (compat wrapper) always persists keymapWritten=false, even overriding a previously-true value', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setKeyboardLayoutState('eucalyn-id', true)
      })
      expect(result.current.keymapWritten).toBe(true)

      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setLayout('dvorak-id')
      })

      expect(result.current.layout).toBe('dvorak-id')
      expect(result.current.keymapWritten).toBe(false)
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        keyboardLayout: 'dvorak-id',
        keymapWritten: false,
      }))
    })

    it('round-trips keymapWritten=true from IPC on applyDevicePrefs', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValueOnce({
        _rev: 1,
        keyboardLayout: 'eucalyn-id',
        keymapWritten: true,
        autoAdvance: true,
        layerNames: [],
      } as never)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.layout).toBe('eucalyn-id')
      expect(result.current.keymapWritten).toBe(true)
    })

    it('defaults keymapWritten to false when absent from IPC data (older prefs file, or a plain display switch)', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValueOnce({
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: true,
        layerNames: [],
      })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.layout).toBe('dvorak')
      expect(result.current.keymapWritten).toBe(false)
    })

    it('defaults keymapWritten to false for a brand-new device with no stored prefs', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.keymapWritten).toBe(false)
    })
  })

  describe('invalid data fallback', () => {
    // After the Key Labels migration any non-empty id is accepted; the
    // store may still load it asynchronously after a hub download. Tests
    // below reflect that "the saved id wins" rule.
    it('keeps any non-empty string for default layout (including unknown ids)', async () => {
      setupMocks({ defaultKeyboardLayout: 'invalid-layout' })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.defaultLayout).toBe('invalid-layout')
    })

    it('keeps any non-empty layout id from IPC', async () => {
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
      expect(result.current.layout).toBe('nonexistent')
      expect(result.current.autoAdvance).toBe(false)
    })

    it('keeps the per-device layout id even when the configured default differs', async () => {
      setupMocks({ defaultKeyboardLayout: 'configured-default' })
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
      expect(result.current.layout).toBe('nonexistent')
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

    it('round-trips a valid typingTestResults.mistakes field', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestResults: [
          {
            date: '2024-01-01', wpm: 60, accuracy: 95, wordCount: 30, correctChars: 100, incorrectChars: 5, durationSeconds: 30,
            mistakes: { a: 2, shi: 1 },
          },
        ],
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestResults).toHaveLength(1)
      expect(result.current.typingTestResults[0].mistakes).toEqual({ a: 2, shi: 1 })
    })

    it('drops a malformed typingTestResults.mistakes field but keeps the rest of the result', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestResults: [
          {
            date: '2024-01-01', wpm: 60, accuracy: 95, wordCount: 30, correctChars: 100, incorrectChars: 5, durationSeconds: 30,
            mistakes: { a: 'not-a-number' },
          },
          {
            date: '2024-01-02', wpm: 70, accuracy: 96, wordCount: 30, correctChars: 110, incorrectChars: 4, durationSeconds: 28,
            mistakes: ['not', 'an', 'object'],
          },
        ],
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestResults).toHaveLength(2)
      expect(result.current.typingTestResults[0].wpm).toBe(60)
      expect(result.current.typingTestResults[0].mistakes).toBeUndefined()
      expect(result.current.typingTestResults[1].wpm).toBe(70)
      expect(result.current.typingTestResults[1].mistakes).toBeUndefined()
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
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setTypingTestConfig({ mode: 'words', wordCount: 60, punctuation: true, numbers: false })
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 60,
        punctuation: true,
        numbers: false,
      })
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        typingTestConfig: { mode: 'words', wordCount: 60, punctuation: true, numbers: false },
      }))
    })

    it('restores a tatoeba typingTestConfig from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'tatoeba', language: 'english' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30,
      })
    })

    it('rejects a stale tatoeba value persisted in the MonkeyType fallback', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        // An older build could have saved a tatoeba config here; it must not
        // come back as the MonkeyType fallback.
        typingTestMonkeytypeConfig: { mode: 'tatoeba', language: 'english' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestMonkeytypeConfig).toBeUndefined()
    })

    it('does not cache a tatoeba config as the MonkeyType fallback', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      // Set a normal config → it becomes the MonkeyType fallback.
      act(() => {
        result.current.setTypingTestConfig({ mode: 'words', wordCount: 60, punctuation: false, numbers: false })
      })
      // Switch to tatoeba → the fallback must stay the last normal config.
      act(() => {
        result.current.setTypingTestConfig({ mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30 })
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30,
      })
      expect(result.current.typingTestMonkeytypeConfig).toEqual({ mode: 'words', wordCount: 60, punctuation: false, numbers: false })
    })

    it('setTypingTestLanguage saves via IPC', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setTypingTestLanguage('english_5k')
      })

      expect(result.current.typingTestLanguage).toBe('english_5k')
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
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

    it('preserves romajiInput on a words config restored from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romajiInput: true,
      })
    })

    it('preserves romajiInput on a time config restored from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'time', duration: 60, punctuation: true, numbers: false, romajiInput: true },
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
        romajiInput: true,
      })
    })

    it('drops a non-boolean romajiInput but keeps the rest of the config', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: 'yes' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
      })
    })

    it('preserves romajiInput on the restored MonkeyType fallback config', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestMonkeytypeConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestMonkeytypeConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romajiInput: true,
      })
    })

    it('preserves a fully valid romaji detail block on a words config restored from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          romajiInput: true,
          romaji: { caseStyle: 'capital', guideStyles: ['kunrei'], disabledStyles: ['c', 'digraph'] },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romajiInput: true,
        romaji: { caseStyle: 'capital', guideStyles: ['kunrei'], disabledStyles: ['c', 'digraph'] },
      })
    })

    it('silently drops a persisted romaji fontSize (the guide always tracks Settings > Font now)', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          // Left over from a build that still had the per-guide font
          // control; must not resurface anywhere on the restored config.
          romaji: { fontSize: 40, caseStyle: 'capital' },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romaji: { caseStyle: 'capital' },
      })
    })

    it.each([0, 1, 2, 3])('round-trips a valid guideWordCount of %i', async (guideWordCount) => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          romaji: { guideWordCount },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romaji: { guideWordCount },
      })
    })

    it.each([4, -1, 1.5, 'two'])('drops an out-of-range/non-integer guideWordCount (%p) but keeps the rest of romaji', async (guideWordCount) => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          romaji: { caseStyle: 'capital', guideWordCount },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romaji: { caseStyle: 'capital' },
      })
    })

    it('drops individually invalid romaji fields but keeps the ones that validate', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          romaji: { caseStyle: 'sideways', guideStyles: ['kunrei'], disabledStyles: ['c', 'not-a-style', 123] },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        // caseStyle was malformed and dropped; guideStyles and the one
        // known entry in disabledStyles survived.
        romaji: { guideStyles: ['kunrei'], disabledStyles: ['c'] },
      })
    })

    it('sanitizes a persisted disabledStyles that disables both base systems by dropping kunrei from it', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          // Should never happen via the modal (it blocks disabling the last
          // enabled base), but a hand-edited or corrupted config could still
          // carry both disabled — at least one base must survive validation.
          romaji: { disabledStyles: ['hepburn', 'kunrei', 'digraph'] },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romaji: { disabledStyles: ['hepburn', 'digraph'] },
      })
    })

    it('drops a legacy "cq" style from a persisted disabledStyles/guideStyles (split into separate c/q styles)', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          romaji: { guideStyles: ['cq', 'kunrei'], disabledStyles: ['cq', 'digraph'] },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romaji: { guideStyles: ['kunrei'], disabledStyles: ['digraph'] },
      })
    })

    it('drops a stray hepburn entry from a persisted guideStyles (it is the implicit default, never stored by the modal)', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'words',
          wordCount: 30,
          punctuation: false,
          numbers: false,
          romaji: { guideStyles: ['hepburn', 'xSmall'] },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
        romaji: { guideStyles: ['xSmall'] },
      })
    })

    it('drops the whole romaji block when every field is invalid', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'time',
          duration: 60,
          punctuation: false,
          numbers: false,
          romaji: { caseStyle: 'nope', fontSize: 'big', guideStyles: 'nope', disabledStyles: 'c' },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'time',
        duration: 60,
        punctuation: false,
        numbers: false,
      })
    })

    it('drops a non-object romaji value but keeps the rest of the config', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romaji: 'lower' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'words',
        wordCount: 30,
        punctuation: false,
        numbers: false,
      })
    })

    it('preserves romajiInput + romaji on a tatoeba config restored from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'tatoeba',
          language: 'japanese_hiragana',
          romajiInput: true,
          romaji: { caseStyle: 'capital' },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'tatoeba',
        language: 'japanese_hiragana',
        pattern: 'lines',
        lineCount: 5,
        duration: 30,
        romajiInput: true,
        romaji: { caseStyle: 'capital' },
      })
    })

    it('preserves romajiInput + romaji on a fileImport config restored from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: {
          mode: 'fileImport',
          textId: 'text-1',
          romajiInput: true,
          romaji: { guideStyles: ['kunrei'] },
        },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'fileImport',
        textId: 'text-1',
        romajiInput: true,
        romaji: { guideStyles: ['kunrei'] },
      })
    })

    it('drops a non-boolean romajiInput on a tatoeba config but keeps the rest', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'tatoeba', language: 'english', romajiInput: 'yes' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30,
      })
    })

    it('defaults pattern/lineCount/duration on an old tatoeba config that predates them', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        // Pre-Pattern/Units tatoeba config, as saved by an older build.
        typingTestConfig: { mode: 'tatoeba', language: 'french' },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'tatoeba', language: 'french', pattern: 'lines', lineCount: 5, duration: 30,
      })
    })

    it('round-trips explicit pattern/lineCount/duration on a tatoeba config', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestConfig: { mode: 'tatoeba', language: 'french', pattern: 'time', lineCount: 20, duration: 120 },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })

      expect(result.current.typingTestConfig).toEqual({
        mode: 'tatoeba', language: 'french', pattern: 'time', lineCount: 20, duration: 120,
      })
    })
  })

  describe('splitKeyMode', () => {
    it('defaults to split', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.splitKeyMode).toBe('split')
      expect(result.current.defaultSplitKeyMode).toBe('split')
    })

    it('restores splitKeyMode from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        splitKeyMode: 'flat',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.splitKeyMode).toBe('flat')
    })

    it('setSplitKeyMode saves via IPC', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setSplitKeyMode('flat')
      })

      expect(result.current.splitKeyMode).toBe('flat')
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        splitKeyMode: 'flat',
      }))
    })

    it('setDefaultSplitKeyMode persists via IPC', async () => {
      const { mockAppConfigSet } = setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      act(() => {
        result.current.setDefaultSplitKeyMode('flat')
      })
      expect(mockAppConfigSet).toHaveBeenCalledWith('defaultSplitKeyMode', 'flat')
    })

    it('falls back to default for invalid splitKeyMode from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        splitKeyMode: 'invalid',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.splitKeyMode).toBe('split')
    })
  })

  describe('viewMode', () => {
    it('defaults to "editor" when not in storage', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMode).toBe('editor')
    })

    it('loads stored viewMode from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMode: 'typingView',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMode).toBe('typingView')
    })

    it('falls back to "editor" for invalid viewMode from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMode: 'bogus',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMode).toBe('editor')
    })

    it('setViewMode saves via IPC', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()
      act(() => {
        result.current.setViewMode('typingTest')
      })

      expect(result.current.viewMode).toBe('typingTest')
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        viewMode: 'typingTest',
      }))
    })

    it('appliedUid is null before applyDevicePrefs', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.appliedUid).toBeNull()
    })

    it('appliedUid matches uid after applyDevicePrefs resolves', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.appliedUid).toBe('0xAABB')
    })

    it('setTypingTestViewOnly preserves stored viewMode (disconnect scenario)', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestViewOnly: true,
        viewMode: 'typingView',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      // Simulates disconnect cleanup: resets typingTestViewOnly but should not touch viewMode
      act(() => {
        result.current.setTypingTestViewOnly(false)
      })

      expect(result.current.viewMode).toBe('typingView')
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        typingTestViewOnly: false,
        viewMode: 'typingView',
      }))
    })
  })

  describe('typingViewMenuTab', () => {
    it('defaults to "window" when not in storage', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.typingViewMenuTab).toBe('window')
    })

    it('restores stored typingViewMenuTab from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingViewMenuTab: 'rec',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.typingViewMenuTab).toBe('rec')
    })

    it('falls back to "window" for an unknown typingViewMenuTab value', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingViewMenuTab: 'bogus',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.typingViewMenuTab).toBe('window')
    })

    it('setTypingViewMenuTab saves via IPC and updates state', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setTypingViewMenuTab('rec')
      })

      expect(result.current.typingViewMenuTab).toBe('rec')
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        typingViewMenuTab: 'rec',
      }))
    })

    it('setTypingViewMenuTab skips the IPC save when the value is unchanged', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setTypingViewMenuTab('window')
      })

      expect(result.current.typingViewMenuTab).toBe('window')
      expect(mockPipetteSettingsPatch).not.toHaveBeenCalled()
    })
  })

  describe('typingRecordEnabled', () => {
    it('defaults to false for a new device', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.typingRecordEnabled).toBe(false)
    })

    it('restores typingRecordEnabled from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingRecordEnabled: true,
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.typingRecordEnabled).toBe(true)
    })

    it('falls back to false when IPC returns a non-boolean typingRecordEnabled', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingRecordEnabled: 'yes',
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.typingRecordEnabled).toBe(false)
    })

    it('setTypingRecordEnabled saves via IPC and updates state', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setTypingRecordEnabled(true)
      })

      expect(result.current.typingRecordEnabled).toBe(true)
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        typingRecordEnabled: true,
      }))
    })

    it('setTypingRecordEnabled skips the IPC save when the value is unchanged', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setTypingRecordEnabled(false)
      })

      expect(result.current.typingRecordEnabled).toBe(false)
      expect(mockPipetteSettingsPatch).not.toHaveBeenCalled()
    })
  })


  describe('viewMatrix', () => {
    it('defaults to undefined when not in storage', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMatrix).toBeUndefined()
    })

    it('restores a valid viewMatrix from IPC', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMatrix: { '0,0': { row: 0, col: 5 }, '1,2': { row: 0, col: 0 } },
      } as never)

      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMatrix).toEqual({
        '0,0': { row: 0, col: 5 },
        '1,2': { row: 0, col: 0 },
      })
    })

    it('setViewMatrix saves via IPC and updates state (round trip through save/apply)', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      mockPipetteSettingsPatch.mockClear()

      const next = { '0,0': { row: 2, col: 3 } }
      act(() => {
        result.current.setViewMatrix(next)
      })

      expect(result.current.viewMatrix).toEqual(next)
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        viewMatrix: next,
      }))

      // Simulate reload: the last patch payload is what IPC would persist
      // and return on the next `pipetteSettingsGet`.
      const lastPatch = mockPipetteSettingsPatch.mock.calls[mockPipetteSettingsPatch.mock.calls.length - 1][1]
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMatrix: lastPatch.viewMatrix,
      } as never)
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMatrix).toEqual(next)
    })

    it('setViewMatrix(undefined) clears the field by sending null in the patch', async () => {
      setupMocks()
      mockPipetteSettingsGet.mockResolvedValue({
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMatrix: { '0,0': { row: 2, col: 3 } },
      } as never)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      expect(result.current.viewMatrix).toEqual({ '0,0': { row: 2, col: 3 } })
      mockPipetteSettingsPatch.mockClear()

      act(() => {
        result.current.setViewMatrix(undefined)
      })

      expect(result.current.viewMatrix).toBeUndefined()
      expect(mockPipetteSettingsPatch).toHaveBeenCalledWith('0xAABB', expect.objectContaining({
        viewMatrix: null,
      }))
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

    // After the Key Labels migration the only built-in layout is
    // QWERTY; dvorak (and friends) are downloaded into the Key Label
    // store at runtime. The async store fetch is exercised in
    // useKeyLabelLookup tests, so this remap-after-change scenario is
    // covered there instead.
    it.skip('remapLabel updates after layout change (legacy: dvorak built-in)', async () => {})

    it('isRemapped returns false for qwerty', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.isRemapped('KC_A')).toBe(false)
    })
  })

  // Plan-qwerty-select-no-rewrite v5 最終仕様: Display Only is the sole
  // remap-rendering mode — there is no more "applied mode" gate to switch
  // between (a Rewrite resets the select to QWERTY on success, so it never
  // leaves anything for `remapLabel`/`isRemapped` to simulate). Both
  // functions always resolve through the active Key Label pack's own
  // compositeLabels -> map lookup order. Same fixture as
  // `shared/keymap/__tests__/keymap-apply.test.ts` (real Colemak data).
  describe('remap-rendering (Plan-qwerty-select-no-rewrite v5, single mode)', () => {
    const COLEMAK: Record<string, string> = {
      KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
      KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
      KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
    }

    function mockKeyLabelPack(id: string, map: Record<string, string>, compositeLabels?: Record<string, string>): void {
      const existing = vialAPIMock()
      Object.defineProperty(window, 'vialAPI', {
        value: {
          ...existing,
          keyLabelStoreGet: async (reqId: string) => {
            if (reqId !== id) return { success: false, errorCode: 'NOT_FOUND' }
            return {
              success: true,
              data: {
                meta: { id, name: id, filename: `${id}.json`, savedAt: '', updatedAt: '' },
                data: { name: id, map, compositeLabels },
              },
            }
          },
        },
        writable: true,
        configurable: true,
      })
    }

    it('remapLabel returns the pack\'s own label, and isRemapped marks both a map source key and a compositeLabels-only entry', async () => {
      setupMocks()
      mockKeyLabelPack('colemak-id', COLEMAK, { 'LALT(KC_L)': 'KC_LALT' })
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setLayout('colemak-id')
      })
      await act(async () => {}) // flush the ensure() IPC fetch
      expect(result.current.remapLabel('KC_E')).toBe('F')
      expect(result.current.isRemapped('KC_E')).toBe(true) // KC_E is a pack SOURCE key
      expect(result.current.isRemapped('LALT(KC_L)')).toBe(true) // compositeLabels-only entry
      expect(result.current.isRemapped('KC_A')).toBe(false) // untouched key
    })

    // Bug fix: `isRemapped` used to test membership (`qmkId in map`)
    // instead of the value-difference rule every picker/palette consumer
    // applies via `remapLabel(x) !== x`. A pack entry whose value is a
    // passthrough identical to its own qmkId (present in the map but never
    // actually changing the label) must not be marked either.
    it('an identity passthrough entry (map value equal to its own qmkId) is not marked, matching remapLabel(x) === x', async () => {
      setupMocks()
      const PACK_WITH_PASSTHROUGH: Record<string, string> = { ...COLEMAK, KC_A: 'KC_A' }
      mockKeyLabelPack('colemak-passthrough-id', PACK_WITH_PASSTHROUGH)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setLayout('colemak-passthrough-id')
      })
      await act(async () => {})
      expect(result.current.remapLabel('KC_A')).toBe('KC_A')
      expect(result.current.isRemapped('KC_A')).toBe(false)
      // A genuinely changed entry is still marked.
      expect(result.current.remapLabel('KC_E')).toBe('F')
      expect(result.current.isRemapped('KC_E')).toBe(true)
    })

    it('isRemapped and remapLabel always agree (isRemapped(x) === (remapLabel(x) !== x))', async () => {
      setupMocks()
      const PACK_WITH_PASSTHROUGH: Record<string, string> = { ...COLEMAK, KC_A: 'KC_A' }
      mockKeyLabelPack('colemak-passthrough-id', PACK_WITH_PASSTHROUGH)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setLayout('colemak-passthrough-id')
      })
      await act(async () => {})
      for (const qmkId of ['KC_A', 'KC_E', 'KC_Z']) {
        expect(result.current.isRemapped(qmkId)).toBe(result.current.remapLabel(qmkId) !== qmkId)
      }
    })

    it('QWERTY resolves to identity (empty builtin map) — raw label, no remap tint', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.remapLabel('KC_E')).toBe('KC_E')
      expect(result.current.isRemapped('KC_E')).toBe(false)
    })
  })

  // Plan-qwerty-select-no-rewrite v6 (Phase P): the key PICKER only ever
  // changes for a pack that deviates from ANSI — a pure QWERTY-keycode
  // permutation pack (Colemak et al.) leaves the picker raw in every mode,
  // since every character it swaps in already exists in the picker
  // somewhere. `pickerRemapLabel` is the gated variant; `remapLabel`
  // (the keymap-legend source) is unaffected either way.
  describe('pickerRemapLabel (Plan-qwerty-select-no-rewrite v6, Phase P)', () => {
    const COLEMAK: Record<string, string> = {
      KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
      KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
      KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
    }

    // Real sample-packs/key-labels/japanese_qwerty_ej.json-style data — a
    // QWERTY physical layout with shift-pair display labels. Fails
    // `buildKeymapRewriteTable` (a shift pair can't flatten to one
    // keycode), so it counts as an "ANSI-deviation" pack the picker must
    // still remap — same fixture shape as
    // `shared/keymap/__tests__/keymap-apply.test.ts`.
    const JAPANESE_QWERTY: Record<string, string> = {
      KC_LBRACKET: '`\n@',
      KC_RBRACKET: '{\n[',
      KC_2: '"\n2',
    }

    function mockKeyLabelPack(id: string, map: Record<string, string>): void {
      const existing = vialAPIMock()
      Object.defineProperty(window, 'vialAPI', {
        value: {
          ...existing,
          keyLabelStoreGet: async (reqId: string) => {
            if (reqId !== id) return { success: false, errorCode: 'NOT_FOUND' }
            return {
              success: true,
              data: {
                meta: { id, name: id, filename: `${id}.json`, savedAt: '', updatedAt: '' },
                data: { name: id, map },
              },
            }
          },
        },
        writable: true,
        configurable: true,
      })
    }

    it('is identity for a pure permutation pack (Colemak) while remapLabel/isRemapped still remap', async () => {
      setupMocks()
      mockKeyLabelPack('colemak-id', COLEMAK)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setLayout('colemak-id')
      })
      await act(async () => {}) // flush the ensure() IPC fetch

      // Picker stays raw...
      expect(result.current.pickerRemapLabel('KC_E')).toBe('KC_E')
      // ...while the keymap-legend source keeps remapping and tinting.
      expect(result.current.remapLabel('KC_E')).toBe('F')
      expect(result.current.isRemapped('KC_E')).toBe(true)
    })

    it('matches remapLabel for a deviation pack that fails buildKeymapRewriteTable (JIS shift pairs)', async () => {
      setupMocks()
      mockKeyLabelPack('jis-id', JAPANESE_QWERTY)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setLayout('jis-id')
      })
      await act(async () => {})

      expect(result.current.pickerRemapLabel('KC_LBRACKET')).toBe(result.current.remapLabel('KC_LBRACKET'))
      expect(result.current.pickerRemapLabel('KC_LBRACKET')).toBe('`\n@')
      expect(result.current.pickerRemapLabel('KC_2')).toBe('"\n2')
    })

    it('is identity for QWERTY, matching remapLabel', async () => {
      setupMocks()
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      expect(result.current.pickerRemapLabel('KC_E')).toBe('KC_E')
      expect(result.current.pickerRemapLabel('KC_E')).toBe(result.current.remapLabel('KC_E'))
    })
  })

  // Plan-qwerty-select-no-rewrite Phase K: once `keymapWritten` is true for
  // the active `layout`, the KEYMAP surface (remapLabel/isRemapped) must
  // show raw legends (no pack-label translation — the keymap already holds
  // the rewritten characters as real keycodes) and color ONLY the keys the
  // rewrite table actually changed. `setKeyboardLayoutState` is used
  // directly here (rather than `setLayout`, which always forces
  // written=false) to enter written mode without going through
  // `useKeymapApplyPrompt`'s own transition logic (covered separately).
  describe('written-mode rendering gate (Plan-qwerty-select-no-rewrite Phase K)', () => {
    const COLEMAK: Record<string, string> = {
      KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
      KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
      KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
    }
    // Real sample-packs/key-labels/japanese_qwerty_ej.json-style data — fails
    // buildKeymapRewriteTable (a shift pair can't flatten to one keycode).
    const JAPANESE_QWERTY: Record<string, string> = {
      KC_LBRACKET: '`\n@',
      KC_RBRACKET: '{\n[',
      KC_2: '"\n2',
    }

    function mockKeyLabelPack(id: string, map: Record<string, string>): void {
      const existing = vialAPIMock()
      Object.defineProperty(window, 'vialAPI', {
        value: {
          ...existing,
          keyLabelStoreGet: async (reqId: string) => {
            if (reqId !== id) return { success: false, errorCode: 'NOT_FOUND' }
            return {
              success: true,
              data: {
                meta: { id, name: id, filename: `${id}.json`, savedAt: '', updatedAt: '' },
                data: { name: id, map },
              },
            }
          },
        },
        writable: true,
        configurable: true,
      })
    }

    it('written=true shows raw legends (no pack translation) and colors only the rewrite table\'s non-identity targets', async () => {
      setupMocks()
      mockKeyLabelPack('colemak-id', COLEMAK)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setKeyboardLayoutState('colemak-id', true)
      })
      await act(async () => {}) // flush the ensure() IPC fetch

      // Raw legend despite the pack mapping KC_E -> 'F' — the keymap
      // already embodies the rewrite, so no label translation happens.
      expect(result.current.remapLabel('KC_E')).toBe('KC_E')
      expect(result.current.remapLabel('KC_A')).toBe('KC_A')
      // KC_E is a rewrite-table TARGET (KC_K -> KC_E) — colored.
      expect(result.current.isRemapped('KC_E')).toBe(true)
      // KC_A never appears in the table — not colored.
      expect(result.current.isRemapped('KC_A')).toBe(false)
    })

    it('written=true excludes identity entries from color, same as Display Only', async () => {
      setupMocks()
      const PACK_WITH_PASSTHROUGH: Record<string, string> = { ...COLEMAK, KC_A: 'KC_A' }
      mockKeyLabelPack('colemak-passthrough-id', PACK_WITH_PASSTHROUGH)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setKeyboardLayoutState('colemak-passthrough-id', true)
      })
      await act(async () => {})

      // KC_A -> KC_A is an identity entry in the built table (source ===
      // target) — it must stay unmarked even though it's technically
      // present in the map.
      expect(result.current.isRemapped('KC_A')).toBe(false)
      expect(result.current.remapLabel('KC_A')).toBe('KC_A')
    })

    it('degrades to no color (but keeps raw legends) when the pack is missing/not yet loaded', async () => {
      setupMocks() // no keyLabelStoreGet override — the pack never resolves
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setKeyboardLayoutState('missing-pack-id', true)
      })
      await act(async () => {})

      expect(result.current.remapLabel('KC_E')).toBe('KC_E')
      expect(result.current.isRemapped('KC_E')).toBe(false)
      expect(result.current.isRemapped('KC_A')).toBe(false)
    })

    it('degrades to no color (but keeps raw legends) when buildKeymapRewriteTable fails (e.g. the pack was re-imported with shift-pair content)', async () => {
      setupMocks()
      mockKeyLabelPack('jis-id', JAPANESE_QWERTY)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setKeyboardLayoutState('jis-id', true)
      })
      await act(async () => {})

      expect(result.current.remapLabel('KC_LBRACKET')).toBe('KC_LBRACKET')
      expect(result.current.isRemapped('KC_LBRACKET')).toBe(false)
    })

    it('written=false is unaffected — Display Only behavior continues to apply', async () => {
      setupMocks()
      mockKeyLabelPack('colemak-id', COLEMAK)
      const { result } = renderHookWithConfig(() => useDevicePrefs())
      await act(async () => {})
      await act(async () => {
        await result.current.applyDevicePrefs('0xAABB')
      })
      act(() => {
        result.current.setKeyboardLayoutState('colemak-id', false)
      })
      await act(async () => {})

      expect(result.current.remapLabel('KC_E')).toBe('F')
      expect(result.current.isRemapped('KC_E')).toBe(true)
    })
  })
})
