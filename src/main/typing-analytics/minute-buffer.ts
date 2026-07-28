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
import { MAX_TAP_HOLD_DEFER_MS } from '../../shared/qmk-settings-tapping-term'

export const MINUTE_MS = 60_000

/** The longest gap between two keystrokes that still counts as one
 * recorded interval; anything slower never reaches the bigram/trigram
 * accumulators. Mirrors the discard threshold used by the
 * typing-behaviour research the n-gram statistics are modeled on.
 *
 * This replaces SESSION_IDLE_GAP_MS for n-gram eligibility only. That
 * constant still decides when a *session* ends; this one decides which
 * single interval may become an n-gram. They were once the same value
 * and are no longer (5 min vs 5 s) — re-merging them would silently
 * put multi-minute idles back into the interval statistics. */
export const NGRAM_MAX_IKI_MS = 5000

/** Margin added on top of {@link MAX_TAP_HOLD_DEFER_MS} to absorb IPC and
 * timer scheduling jitter between the renderer's deadline firing and the
 * event actually landing in this buffer (invoke round-trip, event-loop
 * queueing, `resolveScope`'s cache-miss I/O). Not itself a bound on
 * deferral — that's the cap; this only covers the trip after it fires. */
const DRAIN_CLOSE_JITTER_MARGIN_MS = 1000

/** Grace period `drainClosed` waits past a minute's wall-clock end before
 * finalizing it. The renderer defers emitting an LT/MT press until it
 * resolves as tap or hold — by its release edge, or by
 * {@link MAX_TAP_HOLD_DEFER_MS} if the key is still held — so an event
 * can still be in flight after its own minute has technically ended.
 * Closing the buffer right at the boundary would land that event in a
 * *second* snapshot for a minute already flushed. That second snapshot
 * does not merge into the first: the flush path applies snapshots
 * through the same last-writer-wins merge sync uses
 * (`mergeMinuteStatsStmt`), so a late arrival *replaces* the minute's
 * recorded totals instead of adding to them. Do not remove this margin
 * to "close minutes sooner" — that reintroduces the overwrite.
 *
 * Derived from the cap (not chosen independently) so the two can never
 * drift apart: the renderer is contractually bounded to
 * MAX_TAP_HOLD_DEFER_MS regardless of the keyboard's configured
 * TAPPING_TERM, so this only needs to cover that cap plus the jitter
 * margin above — not the keyboard's raw (u16, up to 65535 ms) setting. */
export const DRAIN_CLOSE_GRACE_MS = MAX_TAP_HOLD_DEFER_MS + DRAIN_CLOSE_JITTER_MARGIN_MS

/** Per-cell aggregated counts. `count` is the total press count. `tapCount`
 * and `holdCount` break that down for LT/MT presses, classified by
 * release edge or by the renderer's deferred-emit deadline, whichever
 * comes first; non-tap-hold presses leave both at zero and the consumer
 * treats `count` as the fallback intensity. */
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
  /** Per-trigram interval-average values (ms) accumulated within this
   * minute. Triple key format: `${k1}_${k2}_${k3}`. Each value is the
   * average of the two inter-key intervals that make up the triple
   * (`(iki1 + iki2) / 2`), giving trigrams the same "interval speed"
   * semantics as bigrams so the existing histogram bucketing applies
   * unchanged. */
  trigrams: Map<string, number[]>
  /** Active application name observed during this minute, or null when:
   *  - Monitor App is disabled
   *  - the minute observed multiple distinct apps (mixed → null)
   *  - no app was tagged before flush (no flushes hit this scope yet)
   * Computed from the entry's app-set on finalize so the consumer sees
   * a flat string|null and never has to reason about set semantics. */
  appName: string | null
  /** Typing test label observed during this minute, or null when no test
   *  input (ordinary REC) or the minute mixed multiple tests. Same
   *  single-or-null semantics as {@link appName}, but sourced per-event
   *  (each keystroke carries its own `typingTest`) rather than at flush. */
  typingTest: string | null
  /** Individual test run id for this bucket, or '' for non-test (REC)
   *  input. Unlike appName / typingTest this is part of the bucket key
   *  (see {@link MinuteBuffer.addEvent}), so a single minute with two
   *  runs splits into two snapshots instead of collapsing to null — the
   *  run dimension stays exact. */
  runId: string
}

interface Entry {
  scopeId: string
  fingerprint: TypingAnalyticsFingerprint
  minuteTs: number
  /** Run id for this bucket ('' = non-test input). Part of the bucket
   *  key, so every event in this entry shares it. */
  runId: string
  charCounts: Map<string, number>
  matrixCounts: Map<string, MatrixCellCounts>
  intervals: number[]
  bigrams: Map<string, number[]>
  trigrams: Map<string, number[]>
  keystrokes: number
  firstEventMs: number
  lastEventMs: number
  /** Distinct apps observed across this minute. Populated by
   * {@link MinuteBuffer.markAppName} (called by the analytics service
   * just before each flush). Size>1 collapses to null on finalize so
   * downstream consumers only see "single app" or "mixed/unknown". */
  appSet: Set<string>
  /** Distinct typing-test labels observed across this minute, populated
   * per-event in {@link MinuteBuffer.addEvent}. Same size→value/null
   * collapse as {@link appSet} on finalize. */
  typingTestSet: Set<string>
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
  let typingTest: string | null = null
  if (entry.typingTestSet.size === 1) {
    typingTest = entry.typingTestSet.values().next().value ?? null
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
    trigrams: entry.trigrams,
    appName,
    typingTest,
    runId: entry.runId,
  }
}

export class MinuteBuffer {
  private readonly buffers = new Map<string, Entry>()
  // Bigram/trigram tracking is matrix-only (char events have no
  // keycode) and shares a single 2-deep chain of the last two matrix
  // events: k1 (older) -> k2 (newer, the bigram "previous") -> the
  // incoming event closes the pair/triple. `prevIki` caches the
  // already-validated k1->k2 interval so a trigram emit never has to
  // recompute or re-check it — see recordNgramChain. Reset on minute
  // close so cross-minute pairs are dropped per the design (see
  // Plan-analyze-bigram.md — 0.3% loss accepted to keep the flush path
  // simple), and also reset on a tap-hold `hold` event so its neighbours
  // are never joined into a pair through it (see addEvent).
  private k1Keycode: number | null = null
  private k2Keycode: number | null = null
  private k2Ts: number | null = null
  private prevIki: number | null = null
  // `${scopeId}|${runId}` the chain currently belongs to. Two keyboards
  // typing in parallel (or a run boundary inside one minute) interleave
  // events from different scopes/runs; pairing across them would record
  // phantom n-grams into whichever entry the newer event lands in, so a
  // mismatch restarts the chain from the incoming event. minuteTs is
  // deliberately not part of this key — minute boundaries reset through
  // the existing drain/resetBigramChain path.
  private chainKey: string | null = null

  addEvent(event: TypingAnalyticsEvent, fingerprint: TypingAnalyticsFingerprint): void {
    const scopeId = canonicalScopeKey(fingerprint)
    const minuteTs = floorMinute(event.ts)
    // run id joins the bucket key so two runs sharing a wall-clock minute
    // land in separate snapshots (exact per-run aggregation). '' is the
    // non-test bucket, identical to the pre-run-tagging behaviour.
    const runId = event.runId ?? ''
    const key = `${scopeId}|${minuteTs}|${runId}`
    let entry = this.buffers.get(key)
    if (!entry) {
      entry = {
        scopeId,
        fingerprint,
        minuteTs,
        runId,
        charCounts: new Map(),
        matrixCounts: new Map(),
        intervals: [],
        bigrams: new Map(),
        trigrams: new Map(),
        keystrokes: 0,
        firstEventMs: event.ts,
        lastEventMs: event.ts,
        appSet: new Set<string>(),
        typingTestSet: new Set<string>(),
      }
      this.buffers.set(key, entry)
    }

    if (event.typingTest) entry.typingTestSet.add(event.typingTest)

    if (entry.keystrokes > 0) {
      const gap = event.ts - entry.lastEventMs
      if (gap >= 0) entry.intervals.push(gap)
    }
    // A late-arriving event still counts as a keystroke, but must not walk
    // lastEventMs backwards (which would corrupt activeMs) or leave
    // firstEventMs above the real outer window. Intervals from out-of-order
    // events are intentionally dropped — reconstructing them would require
    // re-sorting every flush. This guard is no longer expected to fire for
    // tap-hold keys once the renderer emits in press order; it stays as the
    // correct fallback for whatever genuinely out-of-order arrival still
    // reaches here (e.g. IPC scheduling jitter), not as the normal path.
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

      if (event.action === 'hold') {
        // A hold is the user reaching for a layer or modifier, not a
        // character in the typing stream — it must still count toward
        // keystrokes/matrix/holdCount above, but it cannot become a link
        // in the n-gram chain. The tempting shortcut is to just skip it
        // and let its neighbours pair directly (letter -> letter across
        // the hold), but that would fabricate a pair that was never
        // typed consecutively: the user's actual sequence was
        // letter -> [reach for Ctrl/Shift/LT] -> letter, not
        // letter -> letter. So the chain resets to empty instead of
        // skipping through — the next event starts a fresh chain with
        // nothing to pair against yet.
        this.resetBigramChain()
      } else {
        this.recordNgramChain(entry, `${scopeId}|${runId}`, event.keycode, event.ts)
      }
    }
  }

  /** Advance the shared bigram/trigram chain by one matrix event and
   * emit any pair/triple the new event completes. `k2` is the bigram
   * "previous"; `k1` is the event before that, so the incoming event
   * (`curr`) closes the pair `k2_curr` and, when `k1` is also present,
   * the triple `k1_k2_curr`.
   *
   * Eligibility (`0 < iki <= NGRAM_MAX_IKI_MS`) is checked once for
   * the `k2 -> curr` interval and reused for both emissions — the
   * trigram value additionally needs `prevIki`, the already-validated
   * `k1 -> k2` interval cached from the previous call, so it never
   * re-derives or re-checks that older interval.
   *
   * A tied/out-of-order event (`iki <= 0`) is discarded without
   * disturbing the chain. Otherwise the chain always advances on a
   * strictly-forward event, even when the interval exceeds
   * NGRAM_MAX_IKI_MS — too slow an interval just means `prevIki` (and
   * therefore any trigram through it) reads as invalid until two
   * consecutive eligible intervals rebuild it; the bigram side never
   * depended on `k1` and is unaffected.
   *
   * `chainKey` scopes the chain to one `${scopeId}|${runId}` stream: an
   * event from a different keyboard or test run restarts the chain from
   * itself instead of pairing against the other stream's keys. */
  private recordNgramChain(entry: Entry, chainKey: string, currKeycode: number, ts: number): void {
    if (this.k2Ts === null || this.chainKey !== chainKey) {
      // First matrix event this chain has seen, or the event belongs to
      // a different scope/run than the current chain — nothing valid to
      // pair against.
      this.k1Keycode = null
      this.prevIki = null
      this.k2Keycode = currKeycode
      this.k2Ts = ts
      this.chainKey = chainKey
      return
    }
    const iki = ts - this.k2Ts
    if (iki <= 0) {
      // Tie / out-of-order: discard this event, chain unchanged.
      return
    }
    const eligible = iki <= NGRAM_MAX_IKI_MS
    if (eligible) {
      const pairKey = `${this.k2Keycode}_${currKeycode}`
      let ikis = entry.bigrams.get(pairKey)
      if (!ikis) {
        ikis = []
        entry.bigrams.set(pairKey, ikis)
      }
      ikis.push(iki)
      if (this.k1Keycode !== null && this.prevIki !== null) {
        const tripleKey = `${this.k1Keycode}_${this.k2Keycode}_${currKeycode}`
        let ikis3 = entry.trigrams.get(tripleKey)
        if (!ikis3) {
          ikis3 = []
          entry.trigrams.set(tripleKey, ikis3)
        }
        ikis3.push((this.prevIki + iki) / 2)
      }
    }
    this.k1Keycode = this.k2Keycode
    this.prevIki = eligible ? iki : null
    this.k2Keycode = currKeycode
    this.k2Ts = ts
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

  /** Finalize and return every buffer entry whose minute ended at least
   * {@link DRAIN_CLOSE_GRACE_MS} ago. Called on each event so closed
   * minutes don't linger in memory.
   *
   * `nowMs` is a real wall-clock timestamp, not a floored minute: the
   * grace is a few seconds, so flooring it first would round the margin
   * up to a whole extra minute and hold every minute in memory far
   * longer than the deferred-emission window actually requires.
   * Callers never add the grace themselves — they just pass `Date.now()`. */
  drainClosed(nowMs: number): MinuteSnapshot[] {
    const closed: MinuteSnapshot[] = []
    for (const [key, entry] of this.buffers) {
      if (entry.minuteTs + MINUTE_MS + DRAIN_CLOSE_GRACE_MS <= nowMs) {
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
    this.k1Keycode = null
    this.k2Keycode = null
    this.k2Ts = null
    this.prevIki = null
    this.chainKey = null
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
