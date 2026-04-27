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

/** Fetches the cross-machine daily summary for `uid` honouring
 * `deviceScope` (own / all / hash). Returns the latest payload, or `[]`
 * before the IPC resolves and on error. Re-fires whenever `uid` or the
 * scope changes; cancels in-flight responses on unmount or scope swap. */
export function useDailySummary(uid: string, deviceScope: DeviceScope): TypingDailySummary[] {
  const [daily, setDaily] = useState<TypingDailySummary[]>([])
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    const dailyPromise = isHashScope(deviceScope)
      ? window.vialAPI.typingAnalyticsListItemsForHash(uid, deviceScope.machineHash)
      : isOwnScope(deviceScope)
        ? window.vialAPI.typingAnalyticsListItemsLocal(uid)
        : window.vialAPI.typingAnalyticsListItems(uid)
    void dailyPromise
      .then((rows) => { if (!cancelled) setDaily(rows) })
      .catch(() => { if (!cancelled) setDaily([]) })
    return () => { cancelled = true }
  }, [uid, scopeKey])

  return daily
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
