// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppConfig } from './useAppConfig'
import type { ThemeMode, ThemeSelection } from '../../shared/types/app-config'
import { THEME_COLOR_KEYS } from '../../shared/types/theme-store'
import type { ThemePackColors, ThemePackEntryFile } from '../../shared/types/theme-store'
import { useEffectiveTheme, type EffectiveTheme } from './useEffectiveTheme'

export type { ThemeMode, ThemeSelection }
export type { EffectiveTheme }
export { useEffectiveTheme }

const DARK_CLASS = 'dark'
const MEDIA_QUERY = '(prefers-color-scheme: dark)'

function getSystemPrefersDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches
}

function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'system') {
    return getSystemPrefersDark() ? 'dark' : 'light'
  }
  return mode
}

function applyThemeClass(effective: EffectiveTheme): void {
  const root = document.documentElement
  if (effective === 'dark') {
    root.classList.add(DARK_CLASS)
  } else {
    root.classList.remove(DARK_CLASS)
  }
}

function applyPackColors(colors: ThemePackColors): void {
  const root = document.documentElement
  for (const key of THEME_COLOR_KEYS) {
    root.style.setProperty(`--${key}`, colors[key])
  }
}

function clearPackColors(): void {
  const root = document.documentElement
  for (const key of THEME_COLOR_KEYS) {
    root.style.removeProperty(`--${key}`)
  }
  root.style.removeProperty('color-scheme')
}

function applyPackTheme(
  pack: ThemePackEntryFile,
  setEffectiveTheme: (t: EffectiveTheme) => void,
): void {
  const effective = resolveEffectiveTheme('system')
  setEffectiveTheme(effective)
  applyPackColors(pack.colors)
  document.documentElement.style.setProperty('color-scheme', effective)
}

export function isPackTheme(theme: ThemeSelection): theme is `pack:${string}` {
  return theme.startsWith('pack:')
}

export function extractPackId(theme: `pack:${string}`): string {
  return theme.slice(5)
}

interface UseThemeReturn {
  theme: ThemeSelection
  effectiveTheme: EffectiveTheme
  setTheme: (mode: ThemeSelection) => void
}

export function useTheme(): UseThemeReturn {
  const { config, set } = useAppConfig()
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => {
    if (isPackTheme(config.theme)) return getSystemPrefersDark() ? 'dark' : 'light'
    return resolveEffectiveTheme(config.theme)
  })
  const cachedPackRef = useRef<{ id: string; pack: ThemePackEntryFile } | null>(null)

  // Apply the dark class whenever the effective theme changes
  useEffect(() => {
    applyThemeClass(effectiveTheme)
  }, [effectiveTheme])

  // Handle pack theme loading and standard theme sync
  useEffect(() => {
    if (!isPackTheme(config.theme)) {
      // Standard theme: clear any pack overrides and resolve
      clearPackColors()
      setEffectiveTheme(resolveEffectiveTheme(config.theme))
      return
    }

    const packId = extractPackId(config.theme)

    if (cachedPackRef.current?.id === packId) {
      applyPackTheme(cachedPackRef.current.pack, setEffectiveTheme)
      return
    }

    let cancelled = false
    window.vialAPI.themePackGet(packId).then((result) => {
      if (cancelled) return
      if (!result.success || !result.data) {
        clearPackColors()
        set('theme', 'system')
        setEffectiveTheme(resolveEffectiveTheme('system'))
        return
      }
      const { pack } = result.data
      cachedPackRef.current = { id: packId, pack }
      applyPackTheme(pack, setEffectiveTheme)
    })
    return () => { cancelled = true }
  }, [config.theme, set])

  // Listen for system color scheme changes when in 'system' mode
  useEffect(() => {
    if (config.theme !== 'system') return
    const mql = window.matchMedia(MEDIA_QUERY)
    const handler = () => {
      setEffectiveTheme(resolveEffectiveTheme('system'))
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [config.theme])

  // Re-fetch pack colors when the pack store changes (sync / re-import)
  useEffect(() => {
    if (!isPackTheme(config.theme)) return
    const packId = extractPackId(config.theme)
    const unsubscribe = window.vialAPI.themePackOnChanged?.(() => {
      window.vialAPI.themePackGet(packId).then((result) => {
        if (!result.success || !result.data) return
        const { pack } = result.data
        cachedPackRef.current = { id: packId, pack }
        applyPackTheme(pack, setEffectiveTheme)
      })
    })
    return () => { unsubscribe?.() }
  }, [config.theme])

  const setTheme = useCallback((mode: ThemeSelection) => {
    set('theme', mode)
    if (!isPackTheme(mode)) {
      clearPackColors()
      setEffectiveTheme(resolveEffectiveTheme(mode as ThemeMode))
    }
    // Pack themes are applied by the useEffect above once config updates
  }, [set])

  return { theme: config.theme, effectiveTheme, setTheme }
}
