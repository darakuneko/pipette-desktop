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
 * finalizing it for the first time. This is a PERFORMANCE window, not a
 * correctness boundary: correctness comes from retention + full re-send
 * (see {@link RETENTION_MS}) — an entry stays in the map, dirty-tracked,
 * for {@link RETENTION_MS} after its minute ends, so a late arrival past
 * this grace still lands in the same entry and produces one cumulative
 * re-send on the next drain rather than a partial second snapshot.
 *
 * Sized around the renderer's deferred-emit deadline
 * ({@link MAX_TAP_HOLD_DEFER_MS}) plus IPC/timer jitter purely to
 * minimize how often that harmless-but-wasteful re-send happens: a
 * tapping term or timer delay landing inside the grace closes the
 * minute once, cleanly, on the first drain. Landing outside it — a
 * slower straggler, renderer hiccup, whatever — just costs one extra
 * cumulative re-send of that minute; it does not corrupt anything. */
export const DRAIN_CLOSE_GRACE_MS = MAX_TAP_HOLD_DEFER_MS + DRAIN_CLOSE_JITTER_MARGIN_MS

/** How long a finalized entry is kept in memory (dirty-tracked) after its
 * minute ends before being evicted outright. Must comfortably exceed
 * {@link DRAIN_CLOSE_GRACE_MS} — every ordinary late arrival should find
 * its entry still retained, not evicted — while staying short enough
 * that a renderer suspend/crash doesn't hold stale minutes forever. An
 * event whose target minute has aged past this window is dropped by
 * {@link MinuteBuffer.addEvent} instead of starting a fresh partial
 * entry (see there for why: a partial entry for an already-flushed,
 * evicted minute would replace its real totals through the LWW merge). */
export const RETENTION_MS = 5 * MINUTE_MS

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
  /** Lifecycle relative to what has been reported in a snapshot so far:
   *   - 'open': never finalized — a fresh, still-accumulating minute.
   *   - 'retained': finalized at least once and unchanged since. Kept in
   *     the map (not deleted) only so a later straggler can reopen it —
   *     see {@link RETENTION_MS}.
   *   - 'reopened': finalized at least once, then a later event added
   *     data not yet captured by any snapshot. Needs one more cumulative
   *     finalize, whose result is the complete minute (including
   *     whatever was already reported), not just the delta.
   *
   * Two derived questions every consumer asks reduce to this one field:
   * dirty (needs a finalize) ⇔ `state !== 'retained'`; flushed (has
   * shipped at least one snapshot, so its counts already live in the DB)
   * ⇔ `state !== 'open'`. Collapsing what used to be two independent
   * booleans into one enum makes the fourth, meaningless combination
   * (unflushed yet clean) unrepresentable. */
  state: 'open' | 'retained' | 'reopened'
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
  // The entry is retained after this (see RETENTION_MS), so a later
  // straggler can push more values into entry.intervals and this same
  // array gets re-sorted on the next finalize. In-place sort stays safe
  // either way — re-sorting an already-sorted array plus a few new
  // values is still correct, just not free — and it avoids a
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

  /** True once `minuteTs`'s `windowMs`-past-its-own-end window has fully
   * elapsed as of `nowMs`. The single definition backing both the
   * ultra-late drop check in {@link addEvent} (`windowMs = RETENTION_MS`)
   * and the grace/eviction checks in {@link drainClosed}
   * (`windowMs = DRAIN_CLOSE_GRACE_MS` / `RETENTION_MS`): those two call
   * sites must use the identical comparison shape for the documented "a
   * dropped event's minute would already have been evicted" invariant to
   * hold — one shared definition makes that drift impossible. */
  private minuteAgedPast(minuteTs: number, windowMs: number, nowMs: number): boolean {
    return minuteTs + MINUTE_MS + windowMs <= nowMs
  }

  /** `nowMs` is a real wall-clock timestamp (the service passes
   * `Date.now()`), used only to decide whether an event targeting a
   * minute with no live entry is a genuine new minute or an ultra-late
   * arrival past {@link RETENTION_MS} — never to bucket the event
   * itself, which still buckets by `event.ts`. */
  addEvent(event: TypingAnalyticsEvent, fingerprint: TypingAnalyticsFingerprint, nowMs: number): void {
    const scopeId = canonicalScopeKey(fingerprint)
    const minuteTs = floorMinute(event.ts)
    // run id joins the bucket key so two runs sharing a wall-clock minute
    // land in separate snapshots (exact per-run aggregation). '' is the
    // non-test bucket, identical to the pre-run-tagging behaviour.
    const runId = event.runId ?? ''
    const key = `${scopeId}|${minuteTs}|${runId}`
    let entry = this.buffers.get(key)
    if (!entry) {
      if (this.minuteAgedPast(minuteTs, RETENTION_MS, nowMs)) {
        // No live entry, and this minute is old enough that one would
        // already have been evicted (or never have existed dirty this
        // long). Starting a fresh partial entry here would eventually
        // flush a fragment that, through the LWW merge, replaces
        // whatever complete totals this minute already has on disk.
        // Dropping the keystroke is the safe degradation.
        return
      }
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
        state: 'open',
      }
      this.buffers.set(key, entry)
    } else if (entry.state === 'retained') {
      // Reopens a retained clean entry — this event's data hasn't been
      // captured by any snapshot yet. An already-'open'/'reopened' entry
      // is dirty already and needs no transition.
      entry.state = 'reopened'
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
   * Tags only 'open' entries (across all scope IDs) — see {@link Entry.state}.
   * When multiple keyboards are typing in parallel they share the OS
   * focus, so the same app applies to all of them. A 'retained' or
   * 'reopened' entry's appName was already decided and reported; tagging
   * it from whatever app happens to be focused during a much later flush
   * pass would contaminate that decision with unrelated activity instead
   * of describing the minute that was actually recorded. */
  markAppName(appName: string | null): void {
    if (appName === null) return
    for (const entry of this.buffers.values()) {
      if (entry.state !== 'open') continue
      entry.appSet.add(appName)
    }
  }

  /** Finalize every dirty entry ('open' or 'reopened', see
   * {@link Entry.state}) whose minute ended at least
   * {@link DRAIN_CLOSE_GRACE_MS} ago, then evict any entry whose minute
   * ended more than {@link RETENTION_MS} ago — both checks per entry in a
   * single pass, so an entry due for eviction always gets its finalize
   * check first (retention comfortably exceeds grace), giving a dirty
   * one last cumulative re-send before it is dropped for good. Called on
   * each flush pass.
   *
   * Finalized entries are marked 'retained', not deleted, so a straggler
   * arriving after this call reopens the same entry instead of creating
   * a second partial one — the next drain then re-finalizes the WHOLE
   * entry (cumulative totals) rather than sending a partial that would
   * overwrite the real totals through the LWW merge.
   *
   * `nowMs` is a real wall-clock timestamp, not a floored minute: the
   * grace is a few seconds, so flooring it first would round the margin
   * up to a whole extra minute and hold every minute in memory far
   * longer than the deferred-emission window actually requires.
   * Callers never add the grace themselves — they just pass `Date.now()`. */
  drainClosed(nowMs: number): MinuteSnapshot[] {
    const closed: MinuteSnapshot[] = []
    for (const [key, entry] of this.buffers) {
      if (entry.state !== 'retained' && this.minuteAgedPast(entry.minuteTs, DRAIN_CLOSE_GRACE_MS, nowMs)) {
        closed.push(finalize(entry))
        entry.state = 'retained'
      }
      if (this.minuteAgedPast(entry.minuteTs, RETENTION_MS, nowMs)) {
        this.buffers.delete(key)
      }
    }
    // A 'reopened' entry re-finalizing here triggers this same reset a
    // second time for what is, in wall-clock terms, still one minute —
    // the chain was already reset when this minute first closed, and a
    // later straggler reopening it closes it again. Cost: at most one
    // extra n-gram pair lost from whatever is the live minute at that
    // moment. Not worth conditioning the reset on which specific minutes
    // closed (self-healing next chain, rare in practice) just to avoid
    // this micro-loss.
    if (closed.length > 0) this.resetBigramChain()
    return closed
  }

  /** Finalize every dirty entry — used on explicit flush (record OFF,
   * test finish, before-quit). Entries are retained the same way
   * {@link drainClosed} retains them ('retained' entries stay in the map
   * so a straggler after this flush lands in the retained entry rather
   * than a fresh one); eviction still only happens in {@link drainClosed}.
   * On process exit the retained memory is simply reclaimed by the OS, so
   * not clearing the map here costs nothing in that case. */
  drainAll(): MinuteSnapshot[] {
    const all: MinuteSnapshot[] = []
    for (const entry of this.buffers.values()) {
      if (entry.state === 'retained') continue
      all.push(finalize(entry))
      entry.state = 'retained'
    }
    this.resetBigramChain()
    return all
  }

  /** Flip every 'retained' entry back to 'reopened', so the next drain
   * re-finalizes and re-sends it. Used when a flush pass's persistence
   * step (JSONL append / cache apply) throws AFTER a drain already
   * captured snapshots — since those snapshots were never actually
   * written anywhere, this un-does the "already reported" state that
   * `drainClosed` / `drainAll` had just set, without needing to know
   * which specific entries the failed pass touched: reopening a
   * 'retained' entry that was NOT part of the failed pass is harmless
   * (it just costs one extra, unnecessary cumulative re-send next drain),
   * so this can safely be called unconditionally on any persist failure.
   *
   * Entries already 'open' are untouched (nothing to reopen — they were
   * never finalized in the first place, so they're already covered by
   * the re-queued keystrokes/session data).
   *
   * One loss window this cannot recover: an entry that was BOTH
   * finalized AND evicted within the same failed pass (its minute aged
   * past {@link RETENTION_MS} between the drain and this call) is gone
   * from the map entirely — there's nothing left here to reopen. That
   * requires the persist step to hang for the better part of
   * RETENTION_MS while the wall clock keeps advancing; accepted as a
   * rare boundary case rather than engineered around. */
  reopenAll(): void {
    for (const entry of this.buffers.values()) {
      if (entry.state === 'retained') entry.state = 'reopened'
    }
  }

  private resetBigramChain(): void {
    this.k1Keycode = null
    this.k2Keycode = null
    this.k2Ts = null
    this.prevIki = null
    this.chainKey = null
  }

  /** True only when every entry is 'retained' (see {@link Entry.state}) —
   * i.e. nothing dirty is left to flush. If a 'retained' entry counted as
   * non-empty, doFlushPass's dirty-reschedule check would spin forever
   * once any minute had ever been retained. */
  isEmpty(): boolean {
    for (const entry of this.buffers.values()) {
      if (entry.state !== 'retained') return false
    }
    return true
  }

  /** Read-only view of the in-memory matrix counts matching the given
   * keyboard uid + machine hash + layer. Used by the heatmap service to
   * combine the live (not-yet-flushed) current minute with the DB
   * totals so the UI does not lag ~59 seconds behind actual input.
   * Returns `"row,col"` keyed triples summed across every live minute
   * for the scope. Matching by (uid, machineHash) lets callers query
   * without first resolving the canonical scope key.
   *
   * Only 'open' entries are included (see {@link Entry.state}): a
   * 'retained' or 'reopened' entry's last-reported counts are already in
   * the DB, and this peek is meant to add only what the DB doesn't have
   * yet. A 'reopened' entry's counts are cumulative (include what was
   * already flushed), so including it here would double-count against
   * the DB row until the next drain re-sends the full total and this
   * peek naturally stops needing to cover it. The accepted cost is a
   * transient undercount: a straggler into an already-flushed minute is
   * invisible to the live heatmap until it is re-drained.
   *
   * This is not just a rare-straggler edge case — it has a routine
   * trigger: TYPING_ANALYTICS_FLUSH always runs `final: true`, so
   * drainAll finalizes even the still-open CURRENT minute. Toggling REC
   * off then back on within the same wall-clock minute flushes that
   * minute (marking it 'retained'), and every keystroke typed after
   * re-enabling lands in a 'reopened' entry — excluded from this peek —
   * for up to ~62s (a minute's worth of drainClosed's ~59s window, plus
   * the grace period) until the next drainClosed re-sends it. A routine
   * toggle cycle, not just a rare event; the trade-off stands as
   * documented above regardless. */
  peekMatrixCountsForUid(
    uid: string,
    machineHash: string,
    layer: number,
  ): Map<string, { total: number; tap: number; hold: number }> {
    const result = new Map<string, { total: number; tap: number; hold: number }>()
    for (const entry of this.buffers.values()) {
      if (entry.state !== 'open') continue
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
