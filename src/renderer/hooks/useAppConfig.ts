// SPDX-License-Identifier: GPL-2.0-or-later

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { createElement, type ReactNode } from 'react'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types/app-config'
import i18n from '../i18n'

interface AppConfigContextValue {
  config: AppConfig
  loading: boolean
  set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void
  /** Reads the stored config again, as on mount (after a reset changed it
   *  behind the renderer). A failed read keeps the current config. */
  reload: () => Promise<void>
}

const AppConfigContext = createContext<AppConfigContextValue | null>(null)

export function AppConfigProvider({ children }: { children: ReactNode }): ReactNode {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const loaded = await window.vialAPI.appConfigGetAll()
      setConfig(loaded)
      void i18n.changeLanguage(loaded.language ?? 'builtin:en')
    } catch {
      // Keep the current config.
    }
  }, [])

  useEffect(() => {
    void reload().finally(() => setLoading(false))
  }, [reload])

  const set = useCallback(<K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    window.vialAPI.appConfigSet(key, value).catch(() => {
      // fire-and-forget — best-effort persistence
    })
  }, [])

  return createElement(
    AppConfigContext.Provider,
    { value: { config, loading, set, reload } },
    children,
  )
}

export function useAppConfig(): AppConfigContextValue {
  const ctx = useContext(AppConfigContext)
  if (!ctx) {
    throw new Error('useAppConfig must be used within AppConfigProvider')
  }
  return ctx
}
