// SPDX-License-Identifier: GPL-2.0-or-later
// Polls the main-process typing-analytics heatmap API and exposes an
// exponential-moving-average (EMA) of the matrix press counts. Each
// poll multiplies every key's running total by exp(-Δt·ln2/τ) and adds
// the hits observed since the previous poll, so the overlay decays
// smoothly instead of snapping off a sliding window boundary.

import { useEffect, useRef, useState } from 'react'
import type { TypingHeatmapCell } from '../../shared/types/typing-analytics'

/** Default half-life (minutes) when the AppConfig value hasn't loaded
 * yet. Mirrors DEFAULT_APP_CONFIG.typingHeatmapHalfLifeMin. */
export const TYPING_HEATMAP_DEFAULT_HALF_LIFE_MIN = 5

/** Poll cadence for the heatmap while the typing view is open with
 * recording on. Every poll decays the running counters by
 * `exp(-pollMs·ln2/τ)` then adds the hits observed since the previous
 * tick, so smaller values make the overlay more responsive at the
 * cost of more DB calls. */
export const TYPING_HEATMAP_POLL_MS = 5_000

/** Bootstrap span = 5 half-lives. Past that, the weight any earlier
 * hit contributes to the EMA is below 3%, so pre-filling the counters
 * with the raw sum over that range is indistinguishable from having
 * run the decay loop for 5τ and converges on the next poll. */
const BOOTSTRAP_HALF_LIVES = 5

export interface UseTypingHeatmapOptions {
  uid: string | null
  layer: number | null
  enabled: boolean
  pollIntervalMs?: number
  /** Half-life in ms controlling how fast press counts decay. */
  halfLifeMs?: number
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
  halfLifeMs = TYPING_HEATMAP_DEFAULT_HALF_LIFE_MIN * 60 * 1_000,
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
    // is off. Clear any stale overlay so the UI does not show stale
    // data when the user flips record back on.
    if (!enabled || !uid || layer === null) {
      setCells(null)
      setMaxes({ total: 0, tap: 0, hold: 0 })
      return
    }

    // Running EMA counters + the per-key totals observed on the last
    // fetch. Deltas are taken against `previousObserved`, not a
    // wall-clock tail, because the main-process query rounds `sinceMs`
    // to minute boundaries and includes the full live-minute buffer on
    // every call. Subtracting the previous raw total gives us the
    // true new-hit count between polls; a falling raw total (old
    // minute rolled out of the fetch window) is clamped to zero so we
    // don't accidentally subtract from the EMA.
    const counters = new Map<string, TypingHeatmapCell>()
    const previousObserved = new Map<string, TypingHeatmapCell>()
    let lastPollMs = Date.now()
    let cancelled = false

    const applyDecay = (dtMs: number): void => {
      if (dtMs <= 0 || counters.size === 0) return
      const factor = Math.exp(-dtMs * Math.LN2 / halfLifeMs)
      const EPS = 1e-3
      for (const [k, cell] of counters) {
        const next = { total: cell.total * factor, tap: cell.tap * factor, hold: cell.hold * factor }
        if (next.total < EPS && next.tap < EPS && next.hold < EPS) {
          counters.delete(k)
        } else {
          counters.set(k, next)
        }
      }
    }

    const mergeObserved = (hits: Record<string, TypingHeatmapCell>): void => {
      for (const [k, hit] of Object.entries(hits)) {
        const prev = previousObserved.get(k) ?? { total: 0, tap: 0, hold: 0 }
        const delta = {
          total: Math.max(0, hit.total - prev.total),
          tap: Math.max(0, hit.tap - prev.tap),
          hold: Math.max(0, hit.hold - prev.hold),
        }
        previousObserved.set(k, hit)
        if (delta.total === 0 && delta.tap === 0 && delta.hold === 0) continue
        const existing = counters.get(k) ?? { total: 0, tap: 0, hold: 0 }
        counters.set(k, {
          total: existing.total + delta.total,
          tap: existing.tap + delta.tap,
          hold: existing.hold + delta.hold,
        })
      }
    }

    const publish = (): void => {
      if (cancelled || !isMountedRef.current) return
      let maxTotal = 0, maxTap = 0, maxHold = 0
      for (const cell of counters.values()) {
        if (cell.total > maxTotal) maxTotal = cell.total
        if (cell.tap > maxTap) maxTap = cell.tap
        if (cell.hold > maxHold) maxHold = cell.hold
      }
      setCells(new Map(counters))
      setMaxes({ total: maxTotal, tap: maxTap, hold: maxHold })
    }

    async function bootstrap(): Promise<void> {
      try {
        // Pre-fill counters from the last 5·τ span so the overlay
        // looks populated the moment the user enters the view. The
        // raw totals are recorded as the initial `previousObserved`
        // snapshot — subsequent polls treat any increase above this
        // as "new hits since bootstrap".
        const sinceMs = Date.now() - halfLifeMs * BOOTSTRAP_HALF_LIVES
        const heat = await window.vialAPI.typingAnalyticsGetMatrixHeatmap(uid as string, layer as number, sinceMs)
        if (cancelled || !isMountedRef.current) return
        for (const [k, hit] of Object.entries(heat)) {
          counters.set(k, { total: hit.total, tap: hit.tap, hold: hit.hold })
          previousObserved.set(k, hit)
        }
        lastPollMs = Date.now()
        publish()
      } catch {
        /* non-fatal; next poll will retry */
      }
    }

    async function poll(): Promise<void> {
      try {
        const now = Date.now()
        applyDecay(now - lastPollMs)
        // Always fetch the same 5·τ span (not `lastPollMs`) so the
        // delta vs `previousObserved` cancels the main-process query's
        // minute-boundary rounding and live-buffer double counting.
        const sinceMs = now - halfLifeMs * BOOTSTRAP_HALF_LIVES
        const heat = await window.vialAPI.typingAnalyticsGetMatrixHeatmap(uid as string, layer as number, sinceMs)
        if (cancelled || !isMountedRef.current) return
        mergeObserved(heat)
        lastPollMs = now
        publish()
      } catch {
        // Keep the last good snapshot on transient failures.
      }
    }

    void bootstrap()
    const handle = setInterval(poll, pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [uid, layer, enabled, pollIntervalMs, halfLifeMs])

  return {
    cells,
    maxTotal: maxes.total,
    maxTap: maxes.tap,
    maxHold: maxes.hold,
  }
}
