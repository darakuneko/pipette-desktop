// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useAppConfig } from './useAppConfig'
import type { ThemeMode } from '../../shared/types/app-config'

export type { ThemeMode }
export type EffectiveTheme = 'light' | 'dark'

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

interface UseThemeReturn {
  theme: ThemeMode
  effectiveTheme: EffectiveTheme
  setTheme: (mode: ThemeMode) => void
}

export function useTheme(): UseThemeReturn {
  const { config, set } = useAppConfig()
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() =>
    resolveEffectiveTheme(config.theme),
  )

  // Apply the dark class whenever the effective theme changes
  useEffect(() => {
    applyThemeClass(effectiveTheme)
  }, [effectiveTheme])

  // Sync effective theme when config.theme changes
  useEffect(() => {
    setEffectiveTheme(resolveEffectiveTheme(config.theme))
  }, [config.theme])

  // Listen for system color scheme changes when in 'system' mode
  useEffect(() => {
    const mql = window.matchMedia(MEDIA_QUERY)
    const handler = () => {
      if (config.theme === 'system') {
        setEffectiveTheme(resolveEffectiveTheme('system'))
      }
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [config.theme])

  const setTheme = useCallback((mode: ThemeMode) => {
    set('theme', mode)
    setEffectiveTheme(resolveEffectiveTheme(mode))
  }, [set])

  return { theme: config.theme, effectiveTheme, setTheme }
}
