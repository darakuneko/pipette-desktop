// SPDX-License-Identifier: GPL-2.0-or-later
// Per-minute in-memory aggregator: accumulates char/matrix events and raw
// keystroke intervals, then flushes a compact snapshot to the SQLite store
// when a minute rolls over or the service is closed. See
// .claude/plans/typing-analytics.md for the retention/aggregation design.

import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
} from '../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../shared/types/typing-analytics'
import { SESSION_IDLE_GAP_MS } from './session-detector'

export const MINUTE_MS = 60_000

/** Per-cell aggregated counts. `count` is the total press count. `tapCount`
 * and `holdCount` break that down for LT/MT release-edge classifications;
 * non-tap-hold presses leave both at zero and the consumer treats
 * `count` as the fallback intensity. */
export interface MatrixCellCounts {
  row: number
  col: number
  layer: number
  keycode: number
  count: number
  tapCount: number
  holdCount: number
}

export interface MinuteSnapshot {
  scopeId: string
  fingerprint: TypingAnalyticsFingerprint
  minuteTs: number
  keystrokes: number
  activeMs: number
  intervalAvgMs: number | null
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
  charCounts: Map<string, number>
  matrixCounts: Map<string, MatrixCellCounts>
  /** Per-bigram raw inter-key intervals (ms) accumulated within this
   * minute. Pair key format: `${prevKeycode}_${currKeycode}`. The emit
   * layer bucketizes these into a fixed-size histogram before
   * persisting; the snapshot exposes raw IKIs so consumers can choose
   * their own bucketing if needed. */
  bigrams: Map<string, number[]>
  /** Active application name observed during this minute, or null when:
   *  - Monitor App is disabled
   *  - the minute observed multiple distinct apps (mixed → null)
   *  - no app was tagged before flush (no flushes hit this scope yet)
   * Computed from the entry's app-set on finalize so the consumer sees
   * a flat string|null and never has to reason about set semantics. */
  appName: string | null
}

interface Entry {
  scopeId: string
  fingerprint: TypingAnalyticsFingerprint
  minuteTs: number
  charCounts: Map<string, number>
  matrixCounts: Map<string, MatrixCellCounts>
  intervals: number[]
  bigrams: Map<string, number[]>
  keystrokes: number
  firstEventMs: number
  lastEventMs: number
  /** Distinct apps observed across this minute. Populated by
   * {@link MinuteBuffer.markAppName} (called by the analytics service
   * just before each flush). Size>1 collapses to null on finalize so
   * downstream consumers only see "single app" or "mixed/unknown". */
  appSet: Set<string>
}

function floorMinute(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))
  return sorted[idx]
}

function finalize(entry: Entry): MinuteSnapshot {
  // Entry is discarded right after, so in-place sort is safe and avoids a
  // per-keystroke-sized allocation on every flush.
  const sorted = entry.intervals.sort((a, b) => a - b)
  const avg = sorted.length
    ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
    : null
  // appSet semantics:
  //   size === 0 → minute saw no app tag (Monitor App off or never sampled) → null
  //   size === 1 → single app dominated the minute → that app
  //   size  > 1 → mixed minute, app-filtered analytics must skip it → null
  let appName: string | null = null
  if (entry.appSet.size === 1) {
    // Iterator is the only way to peek a Set without copying.
    appName = entry.appSet.values().next().value ?? null
  }
  return {
    scopeId: entry.scopeId,
    fingerprint: entry.fingerprint,
    minuteTs: entry.minuteTs,
    keystrokes: entry.keystrokes,
    activeMs: Math.max(0, entry.lastEventMs - entry.firstEventMs),
    intervalAvgMs: avg,
    intervalMinMs: sorted.length ? sorted[0] : null,
    intervalP25Ms: percentile(sorted, 0.25),
    intervalP50Ms: percentile(sorted, 0.5),
    intervalP75Ms: percentile(sorted, 0.75),
    intervalMaxMs: sorted.length ? sorted[sorted.length - 1] : null,
    charCounts: entry.charCounts,
    matrixCounts: entry.matrixCounts,
    bigrams: entry.bigrams,
    appName,
  }
}

export class MinuteBuffer {
  private readonly buffers = new Map<string, Entry>()
  // Bigram tracking is matrix-only (char events have no keycode). Reset
  // on minute close so cross-minute pairs are dropped per the design
  // (see Plan-analyze-bigram.md — 0.3% loss accepted to keep the flush
  // path simple).
  private previousMatrixKeycode: number | null = null
  private previousMatrixTimestamp: number | null = null

  addEvent(event: TypingAnalyticsEvent, fingerprint: TypingAnalyticsFingerprint): void {
    const scopeId = canonicalScopeKey(fingerprint)
    const minuteTs = floorMinute(event.ts)
    const key = `${scopeId}|${minuteTs}`
    let entry = this.buffers.get(key)
    if (!entry) {
      entry = {
        scopeId,
        fingerprint,
        minuteTs,
        charCounts: new Map(),
        matrixCounts: new Map(),
        intervals: [],
        bigrams: new Map(),
        keystrokes: 0,
        firstEventMs: event.ts,
        lastEventMs: event.ts,
        appSet: new Set<string>(),
      }
      this.buffers.set(key, entry)
    }

    if (entry.keystrokes > 0) {
      const gap = event.ts - entry.lastEventMs
      if (gap >= 0) entry.intervals.push(gap)
    }
    // A late-arriving event still counts as a keystroke, but must not walk
    // lastEventMs backwards (which would corrupt activeMs) or leave
    // firstEventMs above the real outer window. Intervals from out-of-order
    // events are intentionally dropped — reconstructing them would require
    // re-sorting every flush.
    if (event.ts > entry.lastEventMs) entry.lastEventMs = event.ts
    if (event.ts < entry.firstEventMs) entry.firstEventMs = event.ts
    entry.keystrokes += 1

    if (event.kind === 'char') {
      entry.charCounts.set(event.key, (entry.charCounts.get(event.key) ?? 0) + 1)
    } else {
      const mKey = `${event.row},${event.col},${event.layer}`
      const existing = entry.matrixCounts.get(mKey)
      const tapDelta = event.action === 'tap' ? 1 : 0
      const holdDelta = event.action === 'hold' ? 1 : 0
      entry.matrixCounts.set(mKey, {
        row: event.row,
        col: event.col,
        layer: event.layer,
        keycode: event.keycode,
        count: (existing?.count ?? 0) + 1,
        tapCount: (existing?.tapCount ?? 0) + tapDelta,
        holdCount: (existing?.holdCount ?? 0) + holdDelta,
      })

      this.recordBigram(entry, event.keycode, event.ts)
    }
  }

  private recordBigram(entry: Entry, currKeycode: number, ts: number): void {
    if (
      this.previousMatrixKeycode !== null &&
      this.previousMatrixTimestamp !== null
    ) {
      const iki = ts - this.previousMatrixTimestamp
      // Forward-time only (out-of-order matches the existing intervals
      // policy of dropping rather than reconstructing) and within session
      // gap (cross-session pairs are noise, not typing rhythm).
      if (iki > 0 && iki <= SESSION_IDLE_GAP_MS) {
        const pairKey = `${this.previousMatrixKeycode}_${currKeycode}`
        let ikis = entry.bigrams.get(pairKey)
        if (!ikis) {
          ikis = []
          entry.bigrams.set(pairKey, ikis)
        }
        ikis.push(iki)
      }
    }
    // Strict forward only — matches the `iki > 0` filter above. Ties
    // (same ts as prev) shouldn't have emitted a bigram and likewise
    // shouldn't advance the chain, otherwise the next event would pair
    // against the tied keycode rather than the older one we kept.
    if (
      this.previousMatrixTimestamp === null ||
      ts > this.previousMatrixTimestamp
    ) {
      this.previousMatrixKeycode = currKeycode
      this.previousMatrixTimestamp = ts
    }
  }

  /** Tag every currently-open buffer entry with an observed application
   * name. Called once per flush from typing-analytics-service after it
   * resolves the active app via app-monitor. Null appName is a no-op:
   * we can't distinguish "no observation" from "observed-as-mixed" by
   * adding null to the set, so the absence of any add is what signals
   * "no app observed" downstream (size === 0 in finalize → null).
   *
   * Tags every live entry (across all scope IDs). When multiple
   * keyboards are typing in parallel they share the OS focus, so the
   * same app applies to all of them. */
  markAppName(appName: string | null): void {
    if (appName === null) return
    for (const entry of this.buffers.values()) {
      entry.appSet.add(appName)
    }
  }

  /** Finalize and return every buffer entry whose minute is strictly older
   * than the given boundary. Called on each event so closed minutes don't
   * linger in memory. */
  drainClosed(cutoffMinuteTs: number): MinuteSnapshot[] {
    const closed: MinuteSnapshot[] = []
    for (const [key, entry] of this.buffers) {
      if (entry.minuteTs < cutoffMinuteTs) {
        closed.push(finalize(entry))
        this.buffers.delete(key)
      }
    }
    if (closed.length > 0) this.resetBigramChain()
    return closed
  }

  /** Finalize every entry — used on explicit flush (record OFF, before-quit). */
  drainAll(): MinuteSnapshot[] {
    const all: MinuteSnapshot[] = []
    for (const entry of this.buffers.values()) {
      all.push(finalize(entry))
    }
    this.buffers.clear()
    this.resetBigramChain()
    return all
  }

  private resetBigramChain(): void {
    this.previousMatrixKeycode = null
    this.previousMatrixTimestamp = null
  }

  isEmpty(): boolean {
    return this.buffers.size === 0
  }

  /** Read-only view of the in-memory matrix counts matching the given
   * keyboard uid + machine hash + layer. Used by the heatmap service to
   * combine the live (not-yet-flushed) current minute with the DB
   * totals so the UI does not lag ~59 seconds behind actual input.
   * Returns `"row,col"` keyed triples summed across every live minute
   * for the scope. Matching by (uid, machineHash) lets callers query
   * without first resolving the canonical scope key. */
  peekMatrixCountsForUid(
    uid: string,
    machineHash: string,
    layer: number,
  ): Map<string, { total: number; tap: number; hold: number }> {
    const result = new Map<string, { total: number; tap: number; hold: number }>()
    for (const entry of this.buffers.values()) {
      if (entry.fingerprint.keyboard.uid !== uid) continue
      if (entry.fingerprint.machineHash !== machineHash) continue
      for (const cell of entry.matrixCounts.values()) {
        if (cell.layer !== layer) continue
        const key = `${cell.row},${cell.col}`
        const existing = result.get(key)
        if (existing) {
          existing.total += cell.count
          existing.tap += cell.tapCount
          existing.hold += cell.holdCount
        } else {
          result.set(key, { total: cell.count, tap: cell.tapCount, hold: cell.holdCount })
        }
      }
    }
    return result
  }
}
