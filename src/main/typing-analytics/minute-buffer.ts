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

export const MINUTE_MS = 60_000

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
  matrixCounts: Map<string, { row: number; col: number; layer: number; keycode: number; count: number }>
}

interface Entry {
  scopeId: string
  fingerprint: TypingAnalyticsFingerprint
  minuteTs: number
  charCounts: Map<string, number>
  matrixCounts: Map<string, { row: number; col: number; layer: number; keycode: number; count: number }>
  intervals: number[]
  keystrokes: number
  firstEventMs: number
  lastEventMs: number
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
  }
}

export class MinuteBuffer {
  private readonly buffers = new Map<string, Entry>()

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
        keystrokes: 0,
        firstEventMs: event.ts,
        lastEventMs: event.ts,
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
      entry.matrixCounts.set(mKey, {
        row: event.row,
        col: event.col,
        layer: event.layer,
        keycode: event.keycode,
        count: (existing?.count ?? 0) + 1,
      })
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
    return closed
  }

  /** Finalize every entry — used on explicit flush (record OFF, before-quit). */
  drainAll(): MinuteSnapshot[] {
    const all: MinuteSnapshot[] = []
    for (const entry of this.buffers.values()) {
      all.push(finalize(entry))
    }
    this.buffers.clear()
    return all
  }

  isEmpty(): boolean {
    return this.buffers.size === 0
  }
}
