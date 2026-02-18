// SPDX-License-Identifier: GPL-2.0-or-later

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { createElement, type ReactNode } from 'react'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types/app-config'
import i18n from '../i18n'

interface AppConfigContextValue {
  config: AppConfig
  loading: boolean
  set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void
}

const AppConfigContext = createContext<AppConfigContextValue | null>(null)

export function AppConfigProvider({ children }: { children: ReactNode }): ReactNode {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.vialAPI.appConfigGetAll().then((loaded) => {
      setConfig(loaded)
      void i18n.changeLanguage(loaded.language ?? 'en')
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [])

  const set = useCallback(<K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    window.vialAPI.appConfigSet(key, value).catch(() => {
      // fire-and-forget — best-effort persistence
    })
  }, [])

  return createElement(
    AppConfigContext.Provider,
    { value: { config, loading, set } },
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
