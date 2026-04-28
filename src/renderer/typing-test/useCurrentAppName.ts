// SPDX-License-Identifier: GPL-2.0-or-later
// Live-preview hook for the Monitor App settings tab. Polls the main
// process for the active application name on a slow timer (2s) while
// the tab is open. Stops polling automatically when `enabled` flips
// off so the user moving away from the Monitor App tab does not keep
// the OS lookup churning in the background.

import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 2_000

interface UseCurrentAppNameOptions {
  /** Whether to poll right now. The caller flips this on while the
   * Monitor App tab is visible and REC is running, off otherwise. */
  enabled: boolean
}

/** Returns the most recently observed active-app name, or null when
 * Monitor App is off / the OS lookup failed / polling hasn't started.
 * The hook is read-only — the analytics aggregator gets the same
 * value through main-process internals and does not depend on this
 * hook firing. */
export function useCurrentAppName({ enabled }: UseCurrentAppNameOptions): string | null {
  const [appName, setAppName] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      setAppName(null)
      return
    }
    let cancelled = false
    const tick = (): void => {
      window.vialAPI
        .typingAnalyticsGetCurrentAppName()
        .then((name) => {
          if (!cancelled) setAppName(name)
        })
        .catch(() => {
          // Lookup failure surfaces as null; we only swallow here so a
          // transient OS error doesn't unmount the popover.
          if (!cancelled) setAppName(null)
        })
    }
    tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [enabled])

  return appName
}
