// SPDX-License-Identifier: GPL-2.0-or-later
// Polls the main-process typing-analytics heatmap API and exposes a
// hybrid sliding-window + EMA snapshot of the matrix press counts.
//
// The user picks a window length in minutes (e.g. "5 min"). Each
// 5-second poll diff'd against the previous raw fetch is stored as a
// timestamped sample. On every recompute:
//   - samples older than `windowMs` are dropped wholesale (hard cutoff)
//   - the remaining samples are weighted by `exp(-age·ln2/τ)` with
//     τ = windowMs / 5, so a hit fades smoothly as it nears the window
//     edge instead of jumping off
//
// The result is a "data within the last N minutes, fading on the way
// out" overlay that matches the user mental model of "this is what I
// pressed in the last N minutes" without the saturated-forever
// behaviour of pure EMA normalisation.

import { useEffect, useRef, useState } from 'react'
import type { TypingHeatmapCell } from '../../shared/types/typing-analytics'

/** Default window length (minutes) when the AppConfig value hasn't
 * loaded yet. Mirrors DEFAULT_APP_CONFIG.typingHeatmapWindowMin. */
export const TYPING_HEATMAP_DEFAULT_WINDOW_MIN = 5

/** Poll cadence for the heatmap while the typing view is open with
 * recording on. Smaller values make the overlay more responsive at the
 * cost of more DB calls. */
export const TYPING_HEATMAP_POLL_MS = 5_000

/** Internal time constant of the smooth in-window decay. Picked so a
 * sample at the far edge of the window contributes ≈3% of its
 * undecayed weight — close enough to invisible that the hard cutoff
 * isn't perceptible. */
const WINDOW_TO_TAU_RATIO = 5

export interface UseTypingHeatmapOptions {
  uid: string | null
  layer: number | null
  enabled: boolean
  pollIntervalMs?: number
  /** Window length in ms. Hits older than this are removed from the
   * sample buffer; hits within decay smoothly toward the edge. */
  windowMs?: number
}

export interface UseTypingHeatmapResult {
  /** `"row,col"` → `{ total, tap, hold }`. `null` means the hook is
   * disabled (no uid, record off) or has not produced its first result
   * yet. Consumers that only care about the total (non-LT/MT keys) can
   * read `.total`; LT/MT renderers split outer vs inner using `.hold`
   * / `.tap`. */
  cells: Map<string, TypingHeatmapCell> | null
  /** Peak `.total` ever observed in the running counters during this
   * session — used to normalise the single-rect colour ramp on
   * non-tap-hold keys without the "all-keys-decay-together" trap. */
  maxTotal: number
  /** Peak `.tap` ever observed. */
  maxTap: number
  /** Peak `.hold` ever observed. */
  maxHold: number
}

interface Sample {
  tsMs: number
  deltas: Map<string, TypingHeatmapCell>
}

export function useTypingHeatmap({
  uid,
  layer,
  enabled,
  pollIntervalMs = TYPING_HEATMAP_POLL_MS,
  windowMs = TYPING_HEATMAP_DEFAULT_WINDOW_MIN * 60 * 1_000,
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
    if (!enabled || !uid || layer === null) {
      setCells(null)
      setMaxes({ total: 0, tap: 0, hold: 0 })
      return
    }

    const tauMs = windowMs / WINDOW_TO_TAU_RATIO
    // Time-stamped per-poll deltas. The recompute step drops samples
    // older than `windowMs` and re-weights the rest, so we never need
    // to incrementally subtract an aged contribution from a long-lived
    // counter — the recompute is naturally consistent.
    const samples: Sample[] = []
    // Per-key raw totals from the last fetch. Deltas are taken against
    // these because the main-process query rounds `sinceMs` to a
    // minute boundary and folds the live-minute buffer in on every
    // call — the diff cancels both sources of double-counting.
    const previousObserved = new Map<string, TypingHeatmapCell>()
    // Strictly non-decreasing peak per axis so the colour ratio shrinks
    // when the counter does. Without it, the "max counter / max counter"
    // ratio would stay at 1.0 forever and the hottest key would never
    // fade.
    const peak = { total: 0, tap: 0, hold: 0 }
    let cancelled = false

    const dropExpired = (now: number): void => {
      const cutoff = now - windowMs
      while (samples.length > 0 && samples[0].tsMs < cutoff) {
        samples.shift()
      }
    }

    const recomputeCounters = (now: number): Map<string, TypingHeatmapCell> => {
      const counters = new Map<string, TypingHeatmapCell>()
      for (const sample of samples) {
        const age = Math.max(0, now - sample.tsMs)
        const weight = Math.exp(-age * Math.LN2 / tauMs)
        for (const [k, d] of sample.deltas) {
          const c = counters.get(k) ?? { total: 0, tap: 0, hold: 0 }
          c.total += d.total * weight
          c.tap += d.tap * weight
          c.hold += d.hold * weight
          counters.set(k, c)
        }
      }
      for (const c of counters.values()) {
        if (c.total > peak.total) peak.total = c.total
        if (c.tap > peak.tap) peak.tap = c.tap
        if (c.hold > peak.hold) peak.hold = c.hold
      }
      return counters
    }

    const computeDelta = (heat: Record<string, TypingHeatmapCell>): Map<string, TypingHeatmapCell> => {
      const seen = new Set<string>()
      const delta = new Map<string, TypingHeatmapCell>()
      for (const [k, hit] of Object.entries(heat)) {
        seen.add(k)
        const prev = previousObserved.get(k) ?? { total: 0, tap: 0, hold: 0 }
        const d = {
          total: Math.max(0, hit.total - prev.total),
          tap: Math.max(0, hit.tap - prev.tap),
          hold: Math.max(0, hit.hold - prev.hold),
        }
        previousObserved.set(k, hit)
        if (d.total > 0 || d.tap > 0 || d.hold > 0) delta.set(k, d)
      }
      // Drop the cached raw totals for keys that fell out of the query
      // window so a later re-appearance is treated as a fresh delta
      // rather than compared against a stale per-key peak.
      for (const k of Array.from(previousObserved.keys())) {
        if (!seen.has(k)) previousObserved.delete(k)
      }
      return delta
    }

    const publish = (counters: Map<string, TypingHeatmapCell>): void => {
      if (cancelled || !isMountedRef.current) return
      setCells(counters)
      setMaxes({ total: peak.total, tap: peak.tap, hold: peak.hold })
    }

    async function bootstrap(): Promise<void> {
      try {
        // Treat the bootstrap snapshot as a single sample anchored to
        // `now`, so it gets a full window of life from the moment the
        // user opens the view (even though those hits actually came
        // earlier — we don't have per-hit timestamps to do better).
        const sinceMs = Date.now() - windowMs
        const heat = await window.vialAPI.typingAnalyticsGetMatrixHeatmap(uid as string, layer as number, sinceMs)
        if (cancelled || !isMountedRef.current) return
        const now = Date.now()
        const initial = new Map<string, TypingHeatmapCell>()
        for (const [k, hit] of Object.entries(heat)) {
          if (hit.total > 0 || hit.tap > 0 || hit.hold > 0) {
            initial.set(k, { ...hit })
            previousObserved.set(k, hit)
          }
        }
        if (initial.size > 0) samples.push({ tsMs: now, deltas: initial })
        publish(recomputeCounters(now))
      } catch {
        /* non-fatal; next poll will retry */
      }
    }

    async function poll(): Promise<void> {
      try {
        const now = Date.now()
        dropExpired(now)
        const sinceMs = now - windowMs
        const heat = await window.vialAPI.typingAnalyticsGetMatrixHeatmap(uid as string, layer as number, sinceMs)
        if (cancelled || !isMountedRef.current) return
        const delta = computeDelta(heat)
        if (delta.size > 0) samples.push({ tsMs: now, deltas: delta })
        publish(recomputeCounters(now))
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
  }, [uid, layer, enabled, pollIntervalMs, windowMs])

  return {
    cells,
    maxTotal: maxes.total,
    maxTap: maxes.tap,
    maxHold: maxes.hold,
  }
}
