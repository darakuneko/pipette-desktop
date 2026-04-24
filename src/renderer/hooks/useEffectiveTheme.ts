// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useState } from 'react'

export type EffectiveTheme = 'light' | 'dark'

const DARK_CLASS = 'dark'

function readThemeFromDocument(): EffectiveTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains(DARK_CLASS) ? 'dark' : 'light'
}

/**
 * Subscribe-only hook: returns the current effective theme by
 * observing the `.dark` class on `<html>`. Deliberately independent
 * from `useAppConfig` so leaf components (KeyWidget, KeyboardWidget)
 * can depend on theme without dragging the AppConfigProvider +
 * i18n import chain into every test that uses them.
 *
 * `useTheme` is the single writer: it flips the class based on
 * `AppConfig.theme`. Consumers here just read and re-render on the
 * MutationObserver callback.
 */
export function useEffectiveTheme(): EffectiveTheme {
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(readThemeFromDocument)

  useEffect(() => {
    const root = document.documentElement
    // Functional update so unrelated class mutations on <html>
    // (e.g. from other libraries) don't queue an identical update.
    const sync = () =>
      setEffectiveTheme((prev) => {
        const next = readThemeFromDocument()
        return prev === next ? prev : next
      })
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return effectiveTheme
}
