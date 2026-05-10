// SPDX-License-Identifier: GPL-2.0-or-later
import { useEffect, useRef, useState } from 'react'

const HUB_TIMESTAMPS_RATE_LIMIT_MS = 5 * 60 * 1000

export interface HubFreshnessEntry {
  serverUpdatedAt?: string
  removed: boolean
}

export interface HubFreshnessCandidate {
  localId: string
  hubPostId: string
}

interface UseHubFreshnessOptions {
  enabled: boolean
  candidates: HubFreshnessCandidate[]
  fetchTimestamps: (ids: string[]) => Promise<{ success: boolean; data?: { items: { id: string; updated_at: string }[] }; error?: string }>
}

export function useHubFreshness({
  enabled,
  candidates,
  fetchTimestamps,
}: UseHubFreshnessOptions): Map<string, HubFreshnessEntry> {
  const [hubFreshness, setHubFreshness] = useState<Map<string, HubFreshnessEntry>>(new Map())
  const lastCheckAtRef = useRef<number>(0)

  useEffect(() => {
    if (!enabled) return
    if (Date.now() - lastCheckAtRef.current < HUB_TIMESTAMPS_RATE_LIMIT_MS) return
    if (candidates.length === 0) return
    let cancelled = false
    void (async () => {
      const ids = candidates.map((c) => c.hubPostId)
      const res = await fetchTimestamps(ids)
      if (cancelled || !res.success || !res.data) return
      lastCheckAtRef.current = Date.now()
      const serverMap = new Map(res.data.items.map((x) => [x.id, x.updated_at]))
      const next = new Map<string, HubFreshnessEntry>()
      for (const c of candidates) {
        const serverUpdatedAt = serverMap.get(c.hubPostId)
        if (serverUpdatedAt) {
          next.set(c.localId, { serverUpdatedAt, removed: false })
        } else {
          next.set(c.localId, { removed: true })
        }
      }
      setHubFreshness(next)
    })()
    return () => { cancelled = true }
  }, [enabled, candidates, fetchTimestamps])

  return hubFreshness
}

export function hasUpdate(
  freshness: HubFreshnessEntry | undefined,
  localHubUpdatedAt: string | undefined,
): boolean {
  return !!freshness && !freshness.removed
    && !!freshness.serverUpdatedAt
    && (!localHubUpdatedAt || freshness.serverUpdatedAt > localHubUpdatedAt)
}
