// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { applyPackColors, clearPackColors, useTheme } from '../useTheme'
import { THEME_COLOR_KEYS, type ThemeColorScheme, type ThemePackColors } from '../../../shared/types/theme-store'
import { DEFAULT_SIMULATED_COLOR } from '../../utils/simulated-color'
import { renderHookWithConfig, setupAppConfigMock } from './test-helpers'
import { themePackBackends } from './theme-pack-backends'

function baseColors(overrides: Partial<ThemePackColors> = {}): ThemePackColors {
  const colors = {} as ThemePackColors
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = '#123456'
  }
  colors['key-label-remap'] = '#0000ff'
  return { ...colors, ...overrides }
}

describe('applyPackColors / clearPackColors', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('sets every required color token as a CSS custom property', () => {
    applyPackColors(baseColors(), 'dark')
    const root = document.documentElement
    for (const key of THEME_COLOR_KEYS) {
      const expected = key === 'key-label-remap' ? '#0000ff' : '#123456'
      expect(root.style.getPropertyValue(`--${key}`)).toBe(expected)
    }
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark')
  })

  it('uses the pack-defined key-label-simulated value when present', () => {
    applyPackColors(baseColors({ 'key-label-simulated': '#ff00ff' }), 'dark')
    expect(document.documentElement.style.getPropertyValue('--key-label-simulated')).toBe('#ff00ff')
  })

  it('derives key-label-simulated from key-label-remap when absent (light mode)', () => {
    // #0000ff (blue) rotated 180 -> yellow, light clamp min(l,50) is a
    // no-op here since blue is already at l=50.
    applyPackColors(baseColors(), 'light')
    expect(document.documentElement.style.getPropertyValue('--key-label-simulated')).toBe('#ffff00')
  })

  it('falls back to the built-in default when key-label-remap is achromatic', () => {
    applyPackColors(baseColors({ 'key-label-remap': '#808080' }), 'dark')
    expect(document.documentElement.style.getPropertyValue('--key-label-simulated')).toBe(DEFAULT_SIMULATED_COLOR.dark)
  })

  it('clearPackColors removes every required token, key-label-simulated, and color-scheme', () => {
    applyPackColors(baseColors({ 'key-label-simulated': '#ff00ff' }), 'dark')
    clearPackColors()
    const root = document.documentElement
    for (const key of THEME_COLOR_KEYS) {
      expect(root.style.getPropertyValue(`--${key}`)).toBe('')
    }
    expect(root.style.getPropertyValue('--key-label-simulated')).toBe('')
    expect(root.style.getPropertyValue('color-scheme')).toBe('')
  })

  it('leaves wire-row unset (falls through to the stylesheet accent default) and derives wire-col when the pack omits both', () => {
    // baseColors() sets every required key (including accent) to
    // '#123456'. wire-row is left unset inline so style.css's own
    // `var(--accent)` default applies via the cascade; wire-col should be
    // deriveSimulatedColor('#123456', 'dark', DEFAULT_WIRE_COL_COLOR), not
    // a literal re-derivation here (that would just duplicate the
    // implementation).
    applyPackColors(baseColors(), 'dark')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--wire-row')).toBe('')
    expect(root.style.getPropertyValue('--wire-col')).not.toBe('')
    expect(root.style.getPropertyValue('--wire-col')).not.toBe('#123456')
  })

  it('uses the pack-defined wire-row/wire-col values verbatim when present', () => {
    applyPackColors(baseColors({ 'wire-row': '#111111', 'wire-col': '#222222' }), 'light')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--wire-row')).toBe('#111111')
    expect(root.style.getPropertyValue('--wire-col')).toBe('#222222')
  })

  it('clearPackColors removes wire-row and wire-col', () => {
    applyPackColors(baseColors({ 'wire-row': '#111111', 'wire-col': '#222222' }), 'light')
    clearPackColors()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--wire-row')).toBe('')
    expect(root.style.getPropertyValue('--wire-col')).toBe('')
  })
})

// The hook reads a pack theme through `themePackGet` and reads it again on
// each theme pack change broadcast. Runs on both vialAPI implementations
// (theme-pack-backends.ts).
const mockGet = vi.fn()

function record(accent: string, colorScheme: ThemeColorScheme) {
  return {
    success: true,
    data: {
      meta: { id: 'p1', filename: 'packs/p1.json', name: 'Pack', version: '1.0.0', savedAt: 'now', updatedAt: 'now' },
      pack: { name: 'Pack', version: '1.0.0', colorScheme, colors: baseColors({ accent }) },
    },
  }
}

describe.each(themePackBackends({ themePackGet: mockGet }))('useTheme with a pack theme ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.removeAttribute('style')
    Object.defineProperty(window, 'matchMedia', {
      value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'vialAPI', { value: backend.install(), writable: true, configurable: true })
  })

  afterEach(() => {
    clearMocks()
  })

  it('applies the pack and applies it again after a change broadcast', async () => {
    setupAppConfigMock({ theme: 'pack:p1' })
    mockGet.mockResolvedValueOnce(record('#111111', 'dark'))
    const { result } = renderHookWithConfig(() => useTheme())
    const accent = (): string => document.documentElement.style.getPropertyValue('--accent')
    // The colors are set on the document at once, the effective theme on
    // the hook's next render, so the wait covers both.
    await waitFor(() => {
      expect(accent()).toBe('#111111')
      expect(result.current.effectiveTheme).toBe('dark')
    })
    expect(mockGet).toHaveBeenCalledWith('p1')

    mockGet.mockResolvedValueOnce(record('#222222', 'light'))
    // The shim's listener is registered asynchronously.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { await backend.broadcast() })
    await waitFor(() => {
      expect(accent()).toBe('#222222')
      expect(result.current.effectiveTheme).toBe('light')
    })
  })

  it('falls back to the system theme when the pack cannot be read', async () => {
    const { mockAppConfigSet } = setupAppConfigMock({ theme: 'pack:p1' })
    mockGet.mockResolvedValue({ success: false, errorCode: 'NOT_FOUND', error: 'Theme pack not found' })
    renderHookWithConfig(() => useTheme())
    await waitFor(() => expect(mockAppConfigSet).toHaveBeenCalledWith('theme', 'system'))
  })
})
