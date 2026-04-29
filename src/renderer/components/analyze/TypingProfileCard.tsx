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
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { EMPTY_STAT_VALUE } from './analyze-constants'
import { fetchBigramAggregateForRange, listMinuteStatsForScope } from './analyze-fetch'
import { aggregateFingerPairs } from './analyze-bigram-finger'
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
  daily: ReadonlyArray<TypingDailySummary>
  today: string
  /** Required for the keycode → finger map. When `null`, hand
   * balance / SFB classifications fall back to "unknown" since we
   * can't decode bigram keycodes without a keymap. */
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides: Record<string, FingerType>
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
  daily,
  today,
  snapshot,
  fingerOverrides,
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

  useEffect(() => {
    let cancelled = false
    fetchBigramAggregateForRange(uid, deviceScope, range.fromMs, range.toMs, 'top', { limit: BIGRAM_FETCH_LIMIT }, appScopes)
      .then((res) => {
        if (cancelled) return
        setBigrams(res.view === 'top' ? res.entries : [])
      })
      .catch(() => { if (!cancelled) setBigrams([]) })
    return () => { cancelled = true }
  }, [uid, deviceScope, range, appScopes.join('|')])

  useEffect(() => {
    let cancelled = false
    listMinuteStatsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes)
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

  const items: AnalyzeSummaryItem[] = useMemo(() => [
    {
      labelKey: 'analyze.summary.profile.speedLabel',
      value: speed.label === 'unknown'
        ? EMPTY_STAT_VALUE
        : t(`analyze.summary.profile.speed.${speed.label as Exclude<SpeedLabel, 'unknown'>}`),
      context: speed.label === 'unknown'
        ? t('analyze.summary.profile.insufficient')
        : t('analyze.summary.profile.speedContext', { wpm: formatWpm(speed.wpm) }),
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
  ], [speed, handBalance, sfb, fatigue, t])

  return (
    <section className="flex flex-col gap-2" data-testid="analyze-typing-profile-section">
      <h3 className="text-[13px] font-semibold text-content">
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
