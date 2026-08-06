// SPDX-License-Identifier: GPL-2.0-or-later

/** Composite weakness-profile aggregation for Weak Spot Training (see
 *  word-generator/weak-spot-weighting.ts for the sampling side that
 *  consumes the profile this module produces, weak-spot-timing.ts for
 *  the per-run interval extraction, and weak-spot-scoring.ts for the
 *  pure median/shrinkage/weakness-verdict statistics). Scans
 *  `typingTestHistory` for a given language + effective input method
 *  scope, combines its mistake tallies with whatever per-token timing
 *  data the scope's saved run logs provide, and gates biased sampling on
 *  whether at least one token actually came out weak — replacing the
 *  original fixed-200-keystroke gate (2026-08-06 user-approved revision:
 *  200 keystrokes of fast, accurate typing should never activate the
 *  mode; activation must be driven by an actual detected weakness). */

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { TypingTestConfig } from './types'
import { isRomajiInputActive } from './romaji-input'
import { isKanaInputActive } from './kana-input'
import { extractTokenIntervals, mergeTokenIntervals } from './weak-spot-timing'
import { median, computeTokenTimingStats, evaluateTokenWeakness } from './weak-spot-scoring'
import { type WeakSpotDetectionSettings, normalizeWeakSpotDetectionSettingsKey } from './weak-spot-settings'
import type { WeakSpotInputMethod } from './word-generator/weak-spot-weighting'

export type { WeakSpotInputMethod }

export interface MistakeProfile {
  /** Composite weakness score per token, scoped to one language + input
   *  method and already filtered of synthetic decoration keys — WEAK
   *  tokens only (see `evaluateTokenWeakness`); a token that isn't weak
   *  contributes nothing and is simply absent, exactly like a token with
   *  zero matched weight already behaves in `wordWeakSpotScore`. */
  weights: Record<string, number>
  /** Count of weak tokens in this scope — the gate's own trigger (see
   *  `WeakSpotGateInfo`): `>= 1` means at least one weakness was
   *  detected. Equivalent to `Object.keys(weights).length`, kept as its
   *  own field so callers never have to re-derive it via `Object.keys`. */
  weakTokenCount: number
  /** Top 3 weak tokens, score DESC (ties broken by plain string
   *  comparison — never localeCompare, which would make the order
   *  locale-dependent) — computed once here, alongside `weights` itself,
   *  rather than re-sorted by every consumer on every render. Empty when
   *  `weakTokenCount === 0`. See `WeakSpotGateInfo.topWeakTokens`, the
   *  only current consumer. */
  topWeakTokens: string[]
}

/** Live UI-facing gate status for the Option section's toggle/hint —
 *  recomputed from the CURRENT config/language on every render
 *  (useTypingTest's `weakSpotGate`), independent of any in-progress run's
 *  own immutable `TypingTestState.weakSpotProfile` snapshot. `status`
 *  distinguishes three states the hint text must never conflate:
 *  - `'unavailable'`: history hasn't loaded yet (no `getMistakeProfile`
 *    thunk, or it returned undefined) — nothing is known yet, so no hint
 *    is shown at all (claiming "no weak spots" here would be a guess,
 *    not a fact — the data was simply never examined).
 *  - `'no-weak-spots'`: history IS loaded and the scope is real, but no
 *    token cleared any of the three weakness signals — normal sampling,
 *    with a positive ("nothing to fix!") hint.
 *  - `'active'`: at least one weak token was detected — biased sampling
 *    is (or would be, once the toggle is on) in effect. */
export interface WeakSpotGateInfo {
  /** False for every mode but words/time — the toggle itself doesn't
   *  exist elsewhere (see `isWeakSpotTrainingActive`). */
  applicable: boolean
  status: 'unavailable' | 'no-weak-spots' | 'active'
  /** Top detected weak tokens (score DESC), present only when `status ===
   *  'active'` AND the gate was built from a real `MistakeProfile` (see
   *  useTypingTest's `weakSpotGate` memo) — the non-applicable sentinel
   *  `{ applicable: false, status: 'active' }` returned for non-words/time
   *  modes carries no profile at all, so this stays optional rather than
   *  ever defaulting to an empty array there. */
  topWeakTokens?: string[]
  /** Total weak-token count the profile detected (`MistakeProfile.
   *  weakTokenCount`), independent of how many `topWeakTokens` actually
   *  shows — lets the UI compute an accurate "+N" overflow without
   *  hard-coding the shown-token count. Same optionality as
   *  `topWeakTokens` for the same reason. */
  weakTokenCount?: number
}

/** A mistake key produced by a synthetic decoration (injectNumbers/
 *  injectPunctuation/capitalization — see word-generator.ts's
 *  `applyOptions`) rather than the language's own text, so it's excluded
 *  from the profile: a user's tendency to fumble a decorated digit/
 *  punctuation/capital-letter slot isn't a "weak spot" in the language's
 *  own characters, and biasing toward it would just mean sampling more
 *  words hoping for another decoration draw (which sampleWords doesn't
 *  even control — decoration is applied AFTER sampling). Applied to BOTH
 *  the mistake-count map and the timing-interval map — a decorated
 *  trailing-punctuation or digit-replaced token can accumulate timing
 *  samples too, not just mistakes. A digit-replaced word's mistake key
 *  is the ENTIRE numeric string (verbatim mode tallies per-position, but
 *  a decorated "number word" is typed as a whole token replacing the
 *  sampled word, so every mismatched digit position contributes its own
 *  single-digit key) — the `/^[0-9]+$/` test catches both a single stray
 *  digit and a longer numeric key. */
function isSyntheticDecorationKey(key: string): boolean {
  return /^(?:[0-9]+|[.,?!]|[A-Z])$/.test(key)
}

/** A history row's own recorded input method — read from the flags
 *  `buildTypingTestResult` already stamps on every saved run
 *  (`romajiInput`/`kanaInput`, mutually exclusive by construction), never
 *  re-derived from the row's language/config: a historical row may have
 *  been recorded under a language the CURRENT run isn't even using, so
 *  only its own stored flags are trustworthy for what it was actually
 *  typed as. */
function resultInputMethod(r: TypingTestResult): WeakSpotInputMethod {
  if (r.romajiInput) return 'romaji'
  if (r.kanaInput) return 'kana'
  return 'direct'
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The newest N rows of `scoped`, or the list unchanged when
 *  `missWindow === 'all'` (or `scoped` doesn't even exceed the window —
 *  nothing to trim). Trusts `scoped` to already be newest-first rather
 *  than re-sorting by `date` on every call: `history` (this function's
 *  ultimate source, via `computeWeaknessProfile`'s scope filter, which
 *  preserves relative order) is `typingTestHistory`, built by prepending
 *  each newly saved result — `[result, ...prev]`, see
 *  use-typing-test-prefs.ts's save path — so a plain `slice(0, N)` already
 *  picks the newest N. Applied identically to BOTH the miss and timing
 *  signals below (one shared row set, not two independently-sized
 *  windows — see `WeakSpotDetailSettings.missWindow`'s own doc comment). */
function windowedRows(
  scoped: readonly TypingTestResult[], missWindow: WeakSpotDetectionSettings['missWindow'],
): readonly TypingTestResult[] {
  if (missWindow === 'all' || scoped.length <= missWindow) return scoped
  return scoped.slice(0, missWindow)
}

/** Floors an epoch-ms timestamp to its UTC calendar-day index — the exact
 *  granularity `MistakeProfileCache`'s own day bucket keys on (see its doc
 *  comment), so a row's decayed age and the cache's invalidation boundary
 *  always change at the same instant. */
function floorUtcDay(ms: number): number {
  return Math.floor(ms / MS_PER_DAY)
}

/** Time-decay weight for one row's miss contribution:
 *  `0.5^(ageDays/halfLife)`, or 1 (no decay) when `decayHalfLifeDays ===
 *  'none'`. `ageDays` is the difference between `nowMs`'s and `dateIso`'s
 *  own UTC CALENDAR day (both via `floorUtcDay`), not a fractional/
 *  elapsed-ms division — a miss recorded minutes ago must land at EXACTLY
 *  weight 1.0, not 0.998, or a just-typed run's own miss count could
 *  silently slip under an integer `missThreshold` (codex-flagged
 *  calibration concern during design review: "the 2 misses I just typed
 *  shouldn't evaporate before I've even finished the run"). Calendar-day
 *  flooring (rather than "24h elapsed") is also what keeps this in
 *  lockstep with the cache's own day bucket: a row recorded 2 minutes
 *  before UTC midnight ages by a full day the INSTANT the calendar day
 *  rolls over — the same instant the cache bucket changes and the profile
 *  gets recomputed — instead of an elapsed-ms floor, which would have kept
 *  it at ageDays=0 for another ~24h, so the freshly-recomputed profile
 *  would still silently carry yesterday's weight. A malformed/unparseable
 *  `date` degrades to full weight (1) rather than dropping the row
 *  entirely — same "malformed field degrades gracefully" treatment every
 *  other optional field on a persisted result gets elsewhere in this
 *  codebase. */
function decayWeight(
  dateIso: string, decayHalfLifeDays: WeakSpotDetectionSettings['decayHalfLifeDays'], nowMs: number,
): number {
  if (decayHalfLifeDays === 'none') return 1
  const rowMs = Date.parse(dateIso)
  if (!Number.isFinite(rowMs)) return 1
  const ageDays = Math.max(0, floorUtcDay(nowMs) - floorUtcDay(rowMs))
  return Math.pow(0.5, ageDays / decayHalfLifeDays)
}

/** Decay-weighted mistake-count aggregation across `rows` — the
 *  time-decay-aware sibling of `MistakeRankingSection.tsx`'s plain
 *  `aggregateMistakeTotals` (that one powers the always-undecayed History
 *  ranking UI; this one feeds weakness DETECTION, which decay (B) is
 *  meant to affect). Synthetic decoration keys are filtered directly here
 *  rather than in a second caller-side pass. The `'none'` (default) path
 *  is its own loop, entirely skipping `Date.now()`/`decayWeight` per row —
 *  every call on the far more common decay-off path would otherwise pay
 *  for a per-row weight computation whose result is always exactly 1. */
function aggregateDecayedMistakeTotals(
  rows: readonly TypingTestResult[], decayHalfLifeDays: WeakSpotDetectionSettings['decayHalfLifeDays'],
): Record<string, number> {
  const totals: Record<string, number> = {}
  if (decayHalfLifeDays === 'none') {
    for (const r of rows) {
      if (!r.mistakes) continue
      for (const [key, count] of Object.entries(r.mistakes)) {
        if (isSyntheticDecorationKey(key)) continue
        totals[key] = (totals[key] ?? 0) + count
      }
    }
    return totals
  }
  const nowMs = Date.now()
  for (const r of rows) {
    if (!r.mistakes) continue
    const weight = decayWeight(r.date, decayHalfLifeDays, nowMs)
    for (const [key, count] of Object.entries(r.mistakes)) {
      if (isSyntheticDecorationKey(key)) continue
      totals[key] = (totals[key] ?? 0) + count * weight
    }
  }
  return totals
}

/** Composite aggregation: scope-filters `history`, limits it to the
 *  configured rolling window (A — see `windowedRows`), sums decay-weighted
 *  mistake counts (B — see `aggregateDecayedMistakeTotals`) and merges
 *  whatever timing data the WINDOWED scope's available run logs provide (a
 *  row with no `runId`, or one `runLogs` doesn't have — recording consent
 *  was off, the run predates the log feature, or retention evicted it —
 *  simply contributes no timing data; mistakes-only weakness still
 *  applies for it, per the plan's explicit "log absent -> mistakes-only"
 *  rule; timing itself is never decayed — see
 *  `WeakSpotDetailSettings.decayHalfLifeDays`'s own doc comment for why).
 *  Every token appearing in EITHER source is evaluated once via
 *  `evaluateTokenWeakness`; only weak tokens make it into the returned
 *  `weights`. `settings` is required — every real call site already
 *  resolves the current config's settings before calling in (see
 *  weak-spot-settings.ts's `resolveWeakSpotDetectionSettings`); a test
 *  that wants the built-in defaults passes
 *  `DEFAULT_WEAK_SPOT_DETECTION_SETTINGS` explicitly. */
function computeWeaknessProfile(
  history: readonly TypingTestResult[],
  runLogs: ReadonlyMap<string, RunKeystrokeLog>,
  language: string,
  inputMethod: WeakSpotInputMethod,
  settings: WeakSpotDetectionSettings,
): MistakeProfile {
  const scoped = history.filter((r) => (r.language ?? '') === language && resultInputMethod(r) === inputMethod)
  const windowed = windowedRows(scoped, settings.missWindow)

  const missCounts = aggregateDecayedMistakeTotals(windowed, settings.decayHalfLifeDays)

  const perLogIntervals: Map<string, number[]>[] = []
  for (const r of windowed) {
    if (!r.runId) continue
    const log = runLogs.get(r.runId)
    if (!log) continue
    perLogIntervals.push(extractTokenIntervals(log, inputMethod))
  }
  const mergedIntervals = mergeTokenIntervals(perLogIntervals)
  // Deleting the current/already-visited key mid-iteration is well-defined
  // for a Map (unlike an array) — no intermediate `[...keys()]` snapshot
  // needed.
  for (const key of mergedIntervals.keys()) {
    if (isSyntheticDecorationKey(key)) mergedIntervals.delete(key)
  }

  const allValidIntervals: number[] = []
  for (const intervals of mergedIntervals.values()) allValidIntervals.push(...intervals)
  const scopeMedianMs = median(allValidIntervals)

  const weights: Record<string, number> = {}
  let weakTokenCount = 0
  const allTokens = new Set([...Object.keys(missCounts), ...mergedIntervals.keys()])
  for (const token of allTokens) {
    const missCount = missCounts[token] ?? 0
    const timing = computeTokenTimingStats(mergedIntervals.get(token) ?? [], scopeMedianMs, settings)
    const verdict = evaluateTokenWeakness(missCount, timing, scopeMedianMs, settings)
    if (!verdict.isWeak) continue
    weakTokenCount++
    weights[token] = verdict.score
  }

  // Score DESC; ties broken by plain string comparison (not localeCompare,
  // which would make the order locale-dependent) — computed once here
  // rather than re-sorted by every consumer (see `MistakeProfile.
  // topWeakTokens`'s own doc comment).
  const topWeakTokens = Object.entries(weights)
    .sort(([tokenA, scoreA], [tokenB, scoreB]) => scoreB - scoreA || (tokenA < tokenB ? -1 : 1))
    .slice(0, 3)
    .map(([token]) => token)

  return { weights, weakTokenCount, topWeakTokens }
}

/** The effective input method a words/time run under `config`/`language`
 *  would actually use — matches `comparison.ts`'s `conditionKey` in
 *  passing `undefined` for `textRomajiCapable` (words/time's own branch
 *  never reads it, only fileImport's does — see isRomajiCapable). Callers
 *  restrict this to words/time modes themselves (Weak Spot Training's own
 *  scope); calling it for another mode isn't meaningful but isn't guarded
 *  here since every caller already checks the mode first. */
export function effectiveWeakSpotInputMethod(config: TypingTestConfig, language: string): WeakSpotInputMethod {
  if (isRomajiInputActive(config, language, undefined)) return 'romaji'
  if (isKanaInputActive(config, language, undefined)) return 'kana'
  return 'direct'
}

/** Memoized profile lookup, keyed by the `history`/`runLogs` references
 *  plus a `language|inputMethod|<normalized detection settings>` scope
 *  key — a fresh cache instance per consumer (see useInputModes.ts, which
 *  owns one via `useRef`) so repeated calls against the SAME (unchanged)
 *  history/logs/settings never re-scan them from scratch. Two independent
 *  call sites hit the same scope during ordinary use: `useTypingTest`'s
 *  live `weakSpotGate` (recomputed on config/language changes — including
 *  a Weak Spot Settings modal edit, which is itself a config change) and
 *  `resolveWeakSpotProfileArg` (at every run-start decision point) —
 *  without this cache each would rescan on its own. Note this is NOT what
 *  makes a single run's sampling immutable across time-mode refills —
 *  `refillTimeModeWords` never calls back into this cache at all; it
 *  reuses the frozen `TypingTestState.weakSpotProfile` object threaded
 *  through since the run started (see run-state.ts's
 *  `freshState`/`advanceAfterWord`). Invalidated wholesale the moment
 *  EITHER `history` or `runLogs` changes reference (a new result was
 *  saved, or another run log finished fetching); a `settings` change
 *  instead lands a distinct entry alongside the old one (never wholesale
 *  invalidation — a settings edit is far more frequent than a
 *  history/runLogs change, so keeping the old entries around costs little
 *  and avoids discarding profiles for scopes the edit didn't touch).
 *  `biasRatio` is deliberately excluded from `settings`/the key — it's a
 *  SAMPLING-side knob (word-generator.ts's mixture ratio) that never
 *  changes which tokens get detected as weak, only how heavily biasing
 *  favors them once detected; keying on it would invalidate/duplicate
 *  cache entries for a change that can't actually affect this function's
 *  output. When decay is enabled, a UTC epoch-day bucket (via
 *  `floorUtcDay` — the exact granularity `decayWeight` itself now floors
 *  row ages to) is folded into the key too, so the memoized profile is
 *  recomputed with fresh decay weights the instant a UTC calendar-day
 *  boundary passes, even if the app has stayed open the whole time and
 *  neither `history` nor `runLogs` ever changed. Capped at
 *  `MAX_CACHED_PROFILES` entries per history/runLogs generation, evicted
 *  true LEAST-RECENTLY-USED on overflow — a HIT re-inserts its key
 *  (delete + set) before returning, so `Map` iteration order tracks actual
 *  recency of use rather than merely insertion order, and the entry named
 *  by `cache.keys().next()` on overflow is always the real LRU victim, not
 *  just the oldest-inserted one. Without this a settings edit landing a
 *  fresh entry alongside old ones (see above) would otherwise grow the
 *  entry count unbounded across a long session of parameter tweaking, AND
 *  a frequently-reused entry (e.g. the current live `weakSpotGate` scope)
 *  could get evicted purely for being old rather than unused. `settings`
 *  is required — see
 *  `computeWeaknessProfile`'s own doc comment for why an implicit default
 *  here would only mask a caller that forgot to resolve/thread it. */
export interface MistakeProfileCache {
  get(
    history: readonly TypingTestResult[],
    runLogs: ReadonlyMap<string, RunKeystrokeLog>,
    language: string,
    inputMethod: WeakSpotInputMethod,
    settings: WeakSpotDetectionSettings,
  ): MistakeProfile
}

const MAX_CACHED_PROFILES = 8

export function createMistakeProfileCache(): MistakeProfileCache {
  let cachedHistory: readonly TypingTestResult[] | undefined
  let cachedRunLogs: ReadonlyMap<string, RunKeystrokeLog> | undefined
  let cache = new Map<string, MistakeProfile>()
  return {
    get(history, runLogs, language, inputMethod, settings) {
      if (cachedHistory !== history || cachedRunLogs !== runLogs) {
        cachedHistory = history
        cachedRunLogs = runLogs
        cache = new Map()
      }
      const dayBucket = settings.decayHalfLifeDays === 'none' ? '' : `|day:${floorUtcDay(Date.now())}`
      const key = `${language}|${inputMethod}|${normalizeWeakSpotDetectionSettingsKey(settings)}${dayBucket}`
      const cached = cache.get(key)
      if (cached) {
        // Refresh recency on a HIT — delete + re-set moves this key to the
        // end of Map iteration order, so the entry the overflow branch
        // below evicts is always the true least-recently-USED one, not
        // merely the oldest-inserted one (see this interface's own doc
        // comment).
        cache.delete(key)
        cache.set(key, cached)
        return cached
      }
      const result = computeWeaknessProfile(history, runLogs, language, inputMethod, settings)
      cache.set(key, result)
      if (cache.size > MAX_CACHED_PROFILES) {
        const oldestKey = cache.keys().next().value
        if (oldestKey !== undefined) cache.delete(oldestKey)
      }
      return result
    },
  }
}
