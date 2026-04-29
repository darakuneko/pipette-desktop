// SPDX-License-Identifier: GPL-2.0-or-later
// Shared data hooks for the Analyze > Summary cards. Hoist the
// daily-summary fetch and the local-day pivot here so multiple cards
// (Today, Streak/Goal, future Weekly Report / Typing Profile) can read
// the same payload from a single IPC + a single timer instead of each
// re-issuing the call.

import { useEffect, useState } from 'react'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'
import { isHashScope, isOwnScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import { toLocalDate } from './analyze-streak-goal'
import type { DeviceScope } from './analyze-types'

export interface DailySummaryState {
  daily: TypingDailySummary[]
  /** `true` between scope/uid swap and the IPC resolving. The Calendar
   * tab keys its loading overlay off this; legacy callers can ignore it
   * — the `daily` array still defaults to `[]` so existing code paths
   * that only render with data keep working unchanged. */
  loading: boolean
}

/** Fetches the cross-machine daily summary for `uid` honouring
 * `deviceScope` (own / all / hash) and the optional `appScopes`
 * filter (empty array = no filter). Returns the latest payload, or
 * `[]` before the IPC resolves and on error. Re-fires whenever `uid`
 * / the scope / the app filter changes; cancels in-flight responses
 * on unmount or any of the swaps. */
export function useDailySummary(
  uid: string,
  deviceScope: DeviceScope,
  appScopes: string[] = [],
): DailySummaryState {
  const [daily, setDaily] = useState<TypingDailySummary[]>([])
  const [loading, setLoading] = useState(true)
  const scopeKey = scopeToSelectValue(deviceScope)
  // Stable string identity for the app filter so the effect doesn't
  // refire when the parent passes a fresh-but-equal array each render.
  const appScopesKey = appScopes.join('|')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const dailyPromise = isHashScope(deviceScope)
      ? window.vialAPI.typingAnalyticsListItemsForHash(uid, deviceScope.machineHash, appScopes)
      : isOwnScope(deviceScope)
        ? window.vialAPI.typingAnalyticsListItemsLocal(uid, appScopes)
        : window.vialAPI.typingAnalyticsListItems(uid, appScopes)
    void dailyPromise
      .then((rows) => { if (!cancelled) setDaily(rows) })
      .catch(() => { if (!cancelled) setDaily([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // appScopesKey carries the array's identity, so the raw array can
    // be omitted from deps.
  }, [uid, scopeKey, appScopesKey])

  return { daily, loading }
}

/** Tracks the user's local YYYY-MM-DD day. Re-evaluates every minute
 * so a Summary tab left open across midnight flips to the new day on
 * its own without waiting for the user to interact. The setter
 * short-circuits on identical values so React skips re-rendering
 * subscribers when nothing changed. */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => toLocalDate(Date.now()))
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = toLocalDate(Date.now())
      setToday((prev) => (prev === next ? prev : next))
    }, 60_000)
    return () => window.clearInterval(id)
  }, [])
  return today
}
