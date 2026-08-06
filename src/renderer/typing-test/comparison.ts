// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult, TypingTestComparisonBaseline } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from './types'
import { configKey, deriveMode2, resultKpm } from './result-builder'
import { isRomajiInputActive } from './romaji-input'
import { isKanaInputActive } from './kana-input'
import { isWeakSpotTrainingActive } from './types'

/** Headline metrics of the chosen baseline, compared against the live run. */
export interface ComparisonStats {
  wpm: number
  kpm: number
  accuracy: number
}

/** Stable key identifying the test condition a saved result was run under,
 *  reconstructed entirely from fields already stored on every history entry
 *  — no dedicated field needed, and it works for legacy rows too. This is
 *  the single source of truth for condition grouping:
 *  - fileImport: the imported text id (`mode2`), language-independent
 *  - tatoeba: the sentence-pack language + pattern + active unit (`mode2`,
 *    see `deriveMode2`), word-language-independent
 *  - normal (words/time/quote): mode + params + language + toggles (`configKey`)
 *  Rows missing some of these fields fall back the same way `configKey`
 *  already does for PB grouping, so old history entries group sensibly
 *  without a migration. */
export function resultConditionKey(result: TypingTestResult): string {
  const mode = result.mode ?? 'words'
  if (mode === 'fileImport') return `fileImport|${String(result.mode2 ?? '')}`
  if (mode === 'tatoeba') return `tatoeba|${String(result.mode2 ?? '')}`
  return configKey(result)
}

/** Optional live-signal overrides for {@link conditionKey}/{@link matchingResults}/
 *  {@link computeComparison} — currently just `weakSpotActive`, which lets a
 *  caller sitting on a `useTypingTest` instance (the only kind of caller
 *  that can know this) supply the run's EFFECTIVE bias state instead of
 *  the toggle-only fallback these functions derive on their own when no
 *  override is given (see `conditionKey`'s own doc comment for why the
 *  fallback exists and stays toggle-only). */
export interface ConditionKeyOpts {
  /** Whether the CURRENT (or about-to-start) run actually sampled biased
   *  — i.e. `TypingTestState.weakSpotProfile != null` — as opposed to
   *  merely having the toggle on while the keystroke gate wasn't met (see
   *  weak-spot-profile.ts's `WeakSpotGateInfo`). Persisted results only
   *  ever set `weakSpotTraining: true` for the same reason (see
   *  use-typing-test-result-save.ts), so the live key must match that
   *  same effective signal or a gated (toggle-on, unbiased) run's own
   *  save can never find itself in PB/comparison grouping. */
  weakSpotActive?: boolean
}

/** Stable key identifying the current test condition, used both to group
 *  same-condition history and to remember the per-condition baseline.
 *  Builds a result-shaped partial from the live config and delegates to
 *  {@link resultConditionKey}, so the two definitions can never drift.
 *  This must agree with {@link matchingResults} so the saved baseline and the
 *  pinnable choices stay in lockstep. */
export function conditionKey(config: TypingTestConfig, language: string, opts?: ConditionKeyOpts): string {
  const hasToggles = config.mode === 'words' || config.mode === 'time'
  // resultConditionKey only reads these 7 fields (configKey appends
  // `|kana`/`|weakspot` segments ONLY when kanaInput/weakSpotTraining are
  // true — see its own doc comment for why that's asymmetric rather than
  // an unconditional segment), so a config-shaped partial is enough.
  // romajiInput/kanaInput must be the effective active state
  // (isRomajiInputActive/isKanaInputActive), not the raw config fields —
  // buildTypingTestResult records romajiActive/kanaActive (same
  // derivation), and the two need to land on the same key for a
  // default-ON kana word-language pack run to group with its own saved
  // result. weakSpotTraining needs the same "effective, not raw" treatment
  // for the identical reason — `opts.weakSpotActive` carries it in when the
  // caller has a live run to read it from (see ConditionKeyOpts); when
  // omitted (e.g. this module's own unit tests constructing a bare config
  // with no run behind it), falls back to the toggle alone
  // (isWeakSpotTrainingActive) — a reasonable best-effort default that
  // matches every pre-existing caller/test's expectations unchanged.
  // `undefined` for textRomajiCapable is exact here: hasToggles restricts
  // this to words/time, whose isRomajiCapable/isKanaCapable branch never
  // reads it.
  const weakSpotActive = opts?.weakSpotActive ?? isWeakSpotTrainingActive(config)
  return resultConditionKey({
    mode: config.mode,
    mode2: deriveMode2(config),
    language,
    punctuation: hasToggles ? config.punctuation : undefined,
    numbers: hasToggles ? config.numbers : undefined,
    romajiInput: hasToggles ? isRomajiInputActive(config, language, undefined) : undefined,
    kanaInput: hasToggles ? isKanaInputActive(config, language, undefined) : undefined,
    weakSpotTraining: hasToggles ? weakSpotActive : undefined,
  } as TypingTestResult)
}

/** Results from the pool sharing the current test's condition — same
 *  grouping as {@link resultConditionKey}/{@link conditionKey} (see those for
 *  the exact per-mode rules, including `opts.weakSpotActive`). `beforeMs`,
 *  when given, drops results at/after that time so the in-flight run
 *  (saved on finish) never compares against itself. */
export function matchingResults<T extends TypingTestResult>(
  pool: T[],
  config: TypingTestConfig,
  language: string,
  beforeMs?: number,
  opts?: ConditionKeyOpts,
): T[] {
  const currentKey = conditionKey(config, language, opts)
  return pool.filter((r) => {
    if (beforeMs != null && new Date(r.date).getTime() >= beforeMs) return false
    return resultConditionKey(r) === currentKey
  })
}

function statsOf(r: TypingTestResult): ComparisonStats {
  return { wpm: r.wpm, kpm: resultKpm(r), accuracy: r.accuracy }
}

/** The baseline metrics to compare the live run against, or `null` when the
 *  baseline is off / unresolved (no matching history, pinned result gone).
 *  `opts.weakSpotActive` is forwarded to `matchingResults`/`conditionKey`
 *  unchanged — see `ConditionKeyOpts`. */
export function computeComparison(
  pool: TypingTestResult[],
  config: TypingTestConfig,
  language: string,
  baseline: TypingTestComparisonBaseline,
  beforeMs?: number,
  opts?: ConditionKeyOpts,
): ComparisonStats | null {
  if (baseline.kind === 'off') return null

  // A pinned result is a fixed, condition-independent baseline keyed by `date`.
  if (baseline.kind === 'pinned') {
    if (!baseline.pinnedDate) return null
    const pinned = pool.find((r) => r.date === baseline.pinnedDate)
    return pinned ? statsOf(pinned) : null
  }

  const matches = matchingResults(pool, config, language, beforeMs, opts)
  if (matches.length === 0) return null

  if (baseline.kind === 'average') {
    const n = matches.length
    const sum = matches.reduce(
      (acc, r) => ({ wpm: acc.wpm + r.wpm, kpm: acc.kpm + resultKpm(r), accuracy: acc.accuracy + r.accuracy }),
      { wpm: 0, kpm: 0, accuracy: 0 },
    )
    return { wpm: Math.round(sum.wpm / n), kpm: Math.round(sum.kpm / n), accuracy: Math.round(sum.accuracy / n) }
  }

  // 'previous' = most recent matching run; 'best' = highest WPM.
  const chosen = baseline.kind === 'best'
    ? matches.reduce((a, b) => (b.wpm > a.wpm ? b : a))
    : matches.reduce((a, b) => (new Date(b.date).getTime() > new Date(a.date).getTime() ? b : a))
  return statsOf(chosen)
}
