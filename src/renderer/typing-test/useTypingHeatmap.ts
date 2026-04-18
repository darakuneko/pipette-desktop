// SPDX-License-Identifier: GPL-2.0-or-later
// Polls the main-process typing-analytics heatmap API and exposes the
// aggregated matrix press counts as a map for the KeyWidget heatmap
// overlay. Only runs when recording is on; pauses/resets otherwise so
// a stale overlay does not linger after the user toggles record off.

import { useEffect, useRef, useState } from 'react'

/** One hour window backing the simplified typing-view heatmap. The full
 * statistics dashboard (Phase 5 item 1) will let the user pick a span;
 * this view intentionally has no controls. */
export const TYPING_HEATMAP_WINDOW_MS = 60 * 60 * 1_000

/** Poll cadence for the heatmap while the typing view is open with
 * recording on. The main-process query stays under one ms per call for
 * realistic row counts, so 5 s balances perceived freshness against DB
 * chatter. */
export const TYPING_HEATMAP_POLL_MS = 5_000

export interface UseTypingHeatmapOptions {
  uid: string | null
  layer: number | null
  enabled: boolean
  pollIntervalMs?: number
  windowMs?: number
}

export interface UseTypingHeatmapResult {
  /** `"row,col"` → total press count across the window. `null` means
   * the hook is disabled (no uid, record off) or has not produced its
   * first result yet. */
  intensityByCell: Map<string, number> | null
  /** Peak count across `intensityByCell`. `0` when there is no data
   * yet, which lets callers skip the colour ramp without a separate
   * empty-state flag. */
  maxCount: number
}

export function useTypingHeatmap({
  uid,
  layer,
  enabled,
  pollIntervalMs = TYPING_HEATMAP_POLL_MS,
  windowMs = TYPING_HEATMAP_WINDOW_MS,
}: UseTypingHeatmapOptions): UseTypingHeatmapResult {
  const [intensityByCell, setIntensity] = useState<Map<string, number> | null>(null)
  const [maxCount, setMaxCount] = useState(0)

  // Unmount guard. React 18 StrictMode double-mounts the hook, so we
  // also need to bail out on cleanup to avoid logging a "cant set
  // state after unmount" warning for the second mount.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // Disabled by anything — no uid yet, no layer resolved, or record
    // is off. Clear any stale overlay so the UI does not show 1-hour-old
    // data when the user flips record back on.
    if (!enabled || !uid || layer === null) {
      setIntensity(null)
      setMaxCount(0)
      return
    }

    let cancelled = false

    async function fetchOnce(): Promise<void> {
      try {
        const sinceMs = Date.now() - windowMs
        const heat = await window.vialAPI.typingAnalyticsGetMatrixHeatmap(uid as string, layer as number, sinceMs)
        if (cancelled || !isMountedRef.current) return
        const next = new Map<string, number>(Object.entries(heat))
        let nextMax = 0
        for (const count of next.values()) {
          if (count > nextMax) nextMax = count
        }
        setIntensity(next)
        setMaxCount(nextMax)
      } catch {
        // IPC errors are non-fatal — keep the last good snapshot so a
        // transient failure doesn't wipe the overlay mid-typing.
      }
    }

    void fetchOnce()
    const handle = setInterval(fetchOnce, pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [uid, layer, enabled, pollIntervalMs, windowMs])

  return { intensityByCell, maxCount }
}
