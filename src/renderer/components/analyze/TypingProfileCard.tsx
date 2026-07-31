// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Summary > Typing Profile — labels-only digest of the
// user's last 30 days. Pulls bigram aggregate and minute-stats over
// the same window the daily summary already covers, classifies each
// metric into a discrete bucket, and shows a 4-cell stat grid. No
// recommendations: the card surfaces the bucket and lets the user
// draw their own conclusions.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  TypingBigramTopEntry,
  TypingDailySummary,
  TypingKeymapSnapshot,
  TypingMinuteStatsRow,
} from '../../../shared/types/typing-analytics'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import { typingTestResultMaterialLabel } from '../../typing-test/result-builder'
import { sumErrorClassGroups } from '../../typing-test/error-classify'
import {
  BENCHMARK_WPM,
  BENCHMARK_KSPC,
  BENCHMARK_SUBSTITUTION_RATE_PCT,
  BENCHMARK_OMISSION_RATE_PCT,
  BENCHMARK_INSERTION_RATE_PCT,
} from '../../../shared/typing-benchmarks'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { EMPTY_STAT_VALUE } from './analyze-constants'
import { fetchBigramAggregateForRange, listMinuteStatsForScope } from './analyze-fetch'
import { aggregateFingerPairs } from './analyze-bigram-finger'
import { benchmarkPosition } from './analyze-benchmark'
import { BenchmarkSubline } from './BenchmarkSubline'
import { computeKspc, formatKspc } from '../../../shared/kspc'
import { filterDailyWindow, shiftLocalDate } from './analyze-streak-goal'
import {
  classifyFatigue,
  classifyHandBalanceFromPairs,
  classifySfbFromPairs,
  classifySpeed,
  PROFILE_WINDOW_DAYS,
  type FatigueLabel,
  type HandBalanceLabel,
  type SfbLabel,
  type SpeedLabel,
} from './analyze-typing-profile'
import { formatWpm } from './analyze-wpm'
import type { DeviceScope } from './analyze-types'
import { useKeycodeFingerMap } from './use-keycode-finger-map'

interface Props {
  uid: string
  deviceScope: DeviceScope
  /** App filter — see WpmChart.Props.appScopes. Threaded into the
   * bigram and minute-stats fetches so the per-app summary doesn't
   * blend across the whole 30-day window. */
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  daily: ReadonlyArray<TypingDailySummary>
  today: string
  /** Required for the keycode → finger map. When `null`, hand
   * balance / SFB classifications fall back to "unknown" since we
   * can't decode bigram keycodes without a keymap. */
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides: Record<string, FingerType>
  /** Saved Typing Test History, already sanitized — fetched once by
   * AnalyzePane's own settings effect (~:440) and passed down through
   * SummaryView, rather than this card issuing its own duplicate
   * pipetteSettingsGet. The KSPC cell filters this to its own 30-day
   * window and honours typingTestScopes (material) / runIdScopes itself;
   * unlike every other cell here it deliberately ignores ONLY
   * deviceScope/appScopes (see kspcDesc) since it comes from History,
   * not the recorded keystroke stream, which has no per-device or
   * per-app breakdown to filter against. */
  typingTestResults: TypingTestResult[]
}

/** Cap the bigram aggregate to a wide top-N so the SFB / hand split
 * isn't truncated to just the most frequent pairs. The IPC accepts a
 * limit; tens of thousands of unique bigrams is uncommon, so 5_000
 * captures the long tail without paying for a flat-out scan. */
const BIGRAM_FETCH_LIMIT = 5_000

export function TypingProfileCard({
  uid,
  deviceScope,
  appScopes,
  typingTestScopes,
  runIdScopes,
  daily,
  today,
  snapshot,
  fingerOverrides,
  typingTestResults,
}: Props) {
  const { t } = useTranslation()
  const [bigrams, setBigrams] = useState<TypingBigramTopEntry[]>([])
  const [minuteStats, setMinuteStats] = useState<TypingMinuteStatsRow[]>([])

  const range = useMemo(() => {
    const fromDate = shiftLocalDate(today, -(PROFILE_WINDOW_DAYS - 1))
    const fromMs = Date.parse(`${fromDate}T00:00:00`)
    const toMs = Date.parse(`${today}T23:59:59`)
    return { fromMs, toMs }
  }, [today])

  // Exclusive next-local-day-00:00 bound for the KSPC memo's own per-result
  // filter below. `range.toMs` (23:59:59.000, handed to the bigram/minute-
  // stats IPC fetches above as their inclusive upper bound) would drop a
  // saved result's own timestamp for the day's last 999ms if reused as
  // `ts > range.toMs` here — this is the exact boundary a saved
  // TypingTestResult's Date.parse(date) can land on, unlike the
  // server-side minute buckets those other fetches query.
  const nextDayStartMs = useMemo(() => Date.parse(`${shiftLocalDate(today, 1)}T00:00:00`), [today])

  useEffect(() => {
    let cancelled = false
    fetchBigramAggregateForRange(uid, deviceScope, range.fromMs, range.toMs, 'top', { limit: BIGRAM_FETCH_LIMIT }, appScopes, typingTestScopes, runIdScopes)
      .then((res) => {
        if (cancelled) return
        setBigrams(res.view === 'top' ? res.entries : [])
      })
      .catch(() => { if (!cancelled) setBigrams([]) })
    return () => { cancelled = true }
  }, [uid, deviceScope, range, appScopes.join('|')])

  useEffect(() => {
    let cancelled = false
    listMinuteStatsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes)
      .then((rows) => { if (!cancelled) setMinuteStats(rows) })
      .catch(() => { if (!cancelled) setMinuteStats([]) })
    return () => { cancelled = true }
  }, [uid, deviceScope, range, appScopes.join('|')])

  const keycodeFinger = useKeycodeFingerMap(snapshot, fingerOverrides)

  // Filter daily to the same 30-day window so the speed bucket reads
  // the same span the bigram / fatigue classifiers use.
  const dailyWindow = useMemo(
    () => filterDailyWindow(daily, shiftLocalDate(today, -(PROFILE_WINDOW_DAYS - 1)), today),
    [daily, today],
  )

  // Aggregate bigram → finger pairs once and feed both classifiers off
  // the same Map so we don't traverse the entries twice per render.
  const fingerPairs = useMemo(
    () => (keycodeFinger.size === 0 ? new Map() : aggregateFingerPairs(bigrams, keycodeFinger)),
    [bigrams, keycodeFinger],
  )

  const speed = useMemo(() => classifySpeed(dailyWindow), [dailyWindow])
  // Population reference for the speed cell only — the paper (see
  // shared/typing-benchmarks.ts) has no counterpart stat for hand
  // balance or SFB, so those cells stay as-is. `null` when the speed
  // bucket itself is 'unknown' (not enough data to trust a WPM figure).
  const speedBenchmark = useMemo(
    () => (speed.label === 'unknown' ? null : benchmarkPosition(speed.wpm, BENCHMARK_WPM)),
    [speed],
  )
  const handBalance = useMemo(
    () => (keycodeFinger.size === 0
      ? { label: 'unknown' as HandBalanceLabel, leftRatio: null, leftCount: 0, rightCount: 0 }
      : classifyHandBalanceFromPairs(fingerPairs)),
    [fingerPairs, keycodeFinger],
  )
  const sfb = useMemo(
    () => (keycodeFinger.size === 0
      ? { label: 'unknown' as SfbLabel, rate: null, sfbCount: 0, totalCount: 0 }
      : classifySfbFromPairs(fingerPairs)),
    [fingerPairs, keycodeFinger],
  )
  const fatigue = useMemo(() => classifyFatigue(minuteStats, range), [minuteStats, range])

  // Shared eligibility gate for the KSPC and Error mix cells below — both
  // read from saved History (not the recorded keystroke stream) and
  // apply the same four conditions before their own per-field checks:
  //  - the window itself (today's local-day-aware [fromMs, nextDayStartMs)).
  //  - romajiInput results: excluded from both. For KSPC, romaji's ratio
  //    is algebraically 1+rejectRate (denominator = accepted keystrokes
  //    only, a different unit than verbatim mode's confirmed-character
  //    count), so pooling it against the English-transcription
  //    BENCHMARK_KSPC would misread as "far below average" for a
  //    perfectly normal romaji run (see kspcDesc). For Error mix, a
  //    romaji run's committed text is always one of the accepted
  //    spellings for its target, so there's no target/typed difference
  //    left to classify (see error-classify.ts's module header).
  //  - runIdScopes (when a run filter is active): a result without its
  //    own runId can never match a specific run, so it drops out rather
  //    than silently ignoring the filter.
  //  - typingTestScopes (when a material filter is active): matched via
  //    typingTestResultMaterialLabel, the same join key the recording
  //    side and the run filter itself use, so this stays byte-identical
  //    to how every other cell's material filter resolves.
  // One filtered list feeds both memos below so the two cells can't
  // drift into subtly different eligibility rules.
  const windowResults = useMemo(() => typingTestResults.filter((r) => {
    const ts = Date.parse(r.date)
    if (!Number.isFinite(ts) || ts < range.fromMs || ts >= nextDayStartMs) return false
    if (r.romajiInput) return false
    if (runIdScopes.length > 0 && (!r.runId || !runIdScopes.includes(r.runId))) return false
    if (typingTestScopes.length > 0 && !typingTestScopes.includes(typingTestResultMaterialLabel(r))) return false
    return true
  }), [typingTestResults, range, nextDayStartMs, runIdScopes, typingTestScopes])

  // Char-weighted KSPC over windowResults: Σkeystrokes / Σchars across
  // every qualifying result, never a plain average of each run's own
  // ratio (a bare average would let a handful of tiny runs skew the
  // figure as much as one long session). Only results carrying both raw
  // fields (see TypingTestResult.kspcKeystrokes) qualify; a legacy result
  // missing them is silently excluded, not treated as 0. Ratio and
  // position are folded into one memo (a finite ratio against
  // BENCHMARK_KSPC's fixed, positive-SD constants always yields a
  // position, so there's exactly one null check below — not a separate
  // ratio-null check plus a redundant benchmark-null one).
  const kspc = useMemo(() => {
    let keystrokes = 0
    let chars = 0
    for (const r of windowResults) {
      if (r.kspcKeystrokes === undefined || r.kspcChars === undefined) continue
      keystrokes += r.kspcKeystrokes
      chars += r.kspcChars
    }
    const ratio = computeKspc(keystrokes, chars)
    if (ratio === null) return null
    return { ratio, position: benchmarkPosition(ratio, BENCHMARK_KSPC) }
  }, [windowResults])

  // Char-weighted (Σ/Σ) error-class rates over windowResults — see
  // sumErrorClassGroups for the per-result all-or-nothing read and the
  // fold (shared with ErrorMixSection's History summary), and
  // windowResults above for why romaji is excluded. No position labels
  // here — the three population rate constants have no transcribed SD
  // (see BenchmarkMeanStat's doc comment), so only the mean is shown, as
  // plain context text rather than through BenchmarkSubline (which
  // requires a position).
  const errorMix = useMemo(() => {
    const totals = sumErrorClassGroups(windowResults)
    if (!totals) return null
    return {
      substitutionPct: (totals.substitutions / totals.targetChars) * 100,
      omissionPct: (totals.omissions / totals.targetChars) * 100,
      insertionPct: (totals.insertions / totals.targetChars) * 100,
    }
  }, [windowResults])

  const items: AnalyzeSummaryItem[] = useMemo(() => [
    {
      labelKey: 'analyze.summary.profile.speedLabel',
      value: speed.label === 'unknown'
        ? EMPTY_STAT_VALUE
        : t(`analyze.summary.profile.speed.${speed.label as Exclude<SpeedLabel, 'unknown'>}`),
      context: speed.label === 'unknown'
        ? t('analyze.summary.profile.insufficient')
        : (
          <>
            {t('analyze.summary.profile.speedContext', { wpm: formatWpm(speed.wpm) })}
            {speedBenchmark && (
              <BenchmarkSubline
                populationAverageKey="analyze.benchmark.populationAverage"
                value={formatWpm(BENCHMARK_WPM.mean)}
                position={speedBenchmark}
                leadingBreak
              />
            )}
          </>
        ),
      descriptionKey: 'analyze.summary.profile.speedDesc',
    },
    {
      labelKey: 'analyze.summary.profile.handBalanceLabel',
      value: handBalance.label === 'unknown'
        ? EMPTY_STAT_VALUE
        : t(`analyze.summary.profile.handBalance.${handBalance.label as Exclude<HandBalanceLabel, 'unknown'>}`),
      context: handBalance.leftRatio === null
        ? t('analyze.summary.profile.insufficient')
        : t('analyze.summary.profile.handBalanceContext', {
          leftPct: (handBalance.leftRatio * 100).toFixed(1),
          rightPct: ((1 - handBalance.leftRatio) * 100).toFixed(1),
        }),
      descriptionKey: 'analyze.summary.profile.handBalanceDesc',
    },
    {
      labelKey: 'analyze.summary.profile.sfbLabel',
      value: sfb.label === 'unknown'
        ? EMPTY_STAT_VALUE
        : t(`analyze.summary.profile.sfb.${sfb.label as Exclude<SfbLabel, 'unknown'>}`),
      context: sfb.rate === null
        ? t('analyze.summary.profile.insufficient')
        : t('analyze.summary.profile.sfbContext', { pct: (sfb.rate * 100).toFixed(2) }),
      descriptionKey: 'analyze.summary.profile.sfbDesc',
    },
    {
      labelKey: 'analyze.summary.profile.fatigueLabel',
      value: fatigue.label === 'unknown'
        ? EMPTY_STAT_VALUE
        : t(`analyze.summary.profile.fatigue.${fatigue.label as Exclude<FatigueLabel, 'unknown'>}`),
      context: fatigue.dropPct === null
        ? t('analyze.summary.profile.insufficient')
        : t('analyze.summary.profile.fatigueContext', { pct: fatigue.dropPct.toFixed(1) }),
      descriptionKey: 'analyze.summary.profile.fatigueDesc',
    },
    {
      labelKey: 'analyze.summary.profile.kspcLabel',
      value: kspc === null ? EMPTY_STAT_VALUE : formatKspc(kspc.ratio),
      context: kspc === null
        ? t('analyze.summary.profile.insufficient')
        : kspc.position && (
          <BenchmarkSubline
            populationAverageKey="analyze.benchmark.populationAverageKspc"
            value={formatKspc(BENCHMARK_KSPC.mean)}
            position={kspc.position}
          />
        ),
      descriptionKey: 'analyze.summary.profile.kspcDesc',
    },
    {
      labelKey: 'analyze.summary.profile.errorMixLabel',
      // The headline value repeats the substitution rate (also the first
      // figure in the context line below) so the cell reads consistently
      // with every other cell here (value = the primary figure, context
      // = supporting detail) rather than leaving the value unlabeled.
      value: errorMix === null ? EMPTY_STAT_VALUE : `${formatKspc(errorMix.substitutionPct)}%`,
      context: errorMix === null
        ? t('analyze.summary.profile.insufficient')
        : t('analyze.summary.profile.errorMixContext', {
          subPct: formatKspc(errorMix.substitutionPct),
          subAvg: formatKspc(BENCHMARK_SUBSTITUTION_RATE_PCT.mean),
          omPct: formatKspc(errorMix.omissionPct),
          omAvg: formatKspc(BENCHMARK_OMISSION_RATE_PCT.mean),
          insPct: formatKspc(errorMix.insertionPct),
          insAvg: formatKspc(BENCHMARK_INSERTION_RATE_PCT.mean),
        }),
      descriptionKey: 'analyze.summary.profile.errorMixDesc',
    },
  ], [speed, speedBenchmark, handBalance, sfb, fatigue, kspc, errorMix, t])

  return (
    <section className="flex flex-col gap-2" data-testid="analyze-typing-profile-section">
      <h3 className="text-sm font-semibold text-content">
        {t('analyze.summary.profile.sectionTitle', { days: PROFILE_WINDOW_DAYS })}
      </h3>
      <AnalyzeStatGrid
        items={items}
        ariaLabelKey="analyze.summary.profile.ariaLabel"
        testId="analyze-typing-profile"
      />
    </section>
  )
}
