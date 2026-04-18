// SPDX-License-Identifier: GPL-2.0-or-later
// Polls the main-process typing-analytics heatmap API and exposes the
// aggregated matrix press counts as a map for the KeyWidget heatmap
// overlay. Only runs when recording is on; pauses/resets otherwise so
// a stale overlay does not linger after the user toggles record off.

import { useEffect, useRef, useState } from 'react'
import type { TypingHeatmapCell } from '../../shared/types/typing-analytics'

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
  /** `"row,col"` → `{ total, tap, hold }`. `null` means the hook is
   * disabled (no uid, record off) or has not produced its first result
   * yet. Consumers that only care about the total (non-LT/MT keys) can
   * read `.total`; LT/MT renderers split outer vs inner using `.hold`
   * / `.tap`. */
  cells: Map<string, TypingHeatmapCell> | null
  /** Peak `.total` across all cells — used to normalise the single-rect
   * colour ramp on non-tap-hold keys. */
  maxTotal: number
  /** Peak `.tap` across all cells — normalises the inner (tap) rect
   * ramp independently of `.hold` so the tap and hold heatmaps each
   * reach full saturation in their own axis. */
  maxTap: number
  /** Peak `.hold` across all cells — normalises the outer (hold) rect
   * ramp. */
  maxHold: number
}

export function useTypingHeatmap({
  uid,
  layer,
  enabled,
  pollIntervalMs = TYPING_HEATMAP_POLL_MS,
  windowMs = TYPING_HEATMAP_WINDOW_MS,
}: UseTypingHeatmapOptions): UseTypingHeatmapResult {
  const [cells, setCells] = useState<Map<string, TypingHeatmapCell> | null>(null)
  const [maxes, setMaxes] = useState<{ total: number; tap: number; hold: number }>({
    total: 0, tap: 0, hold: 0,
  })

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
      setCells(null)
      setMaxes({ total: 0, tap: 0, hold: 0 })
      return
    }

    let cancelled = false

    async function fetchOnce(): Promise<void> {
      try {
        const sinceMs = Date.now() - windowMs
        const heat = await window.vialAPI.typingAnalyticsGetMatrixHeatmap(uid as string, layer as number, sinceMs)
        if (cancelled || !isMountedRef.current) return
        const next = new Map<string, TypingHeatmapCell>(Object.entries(heat))
        let maxTotal = 0
        let maxTap = 0
        let maxHold = 0
        for (const cell of next.values()) {
          if (cell.total > maxTotal) maxTotal = cell.total
          if (cell.tap > maxTap) maxTap = cell.tap
          if (cell.hold > maxHold) maxHold = cell.hold
        }
        setCells(next)
        setMaxes({ total: maxTotal, tap: maxTap, hold: maxHold })
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

  return {
    cells,
    maxTotal: maxes.total,
    maxTap: maxes.tap,
    maxHold: maxes.hold,
  }
}
