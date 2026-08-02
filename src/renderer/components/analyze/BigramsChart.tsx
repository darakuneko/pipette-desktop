// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  primaryDeviceScope,
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramAggregateResult,
  TypingBigramTopEntry,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { fetchBigramAggregateForRange } from './analyze-fetch'
import { useKeycodeFingerMap } from './use-keycode-finger-map'
import { useSnapshotQmkByCode } from './use-snapshot-qmk-by-code'
import { aggregateBigramClasses } from './analyze-bigram-classes'
import { aggregateWordPosition } from './analyze-bigram-word-position'
import { ALL_PAIRS_LIMIT } from './analyze-constants'
import { FILTER_SELECT } from './analyze-filter-styles'
import type { RangeMs } from './analyze-types'
import {
  Quadrant,
  LimitSelect,
  PairIntervalThresholdInput,
  GramToggle,
} from './bigrams-quadrant-ui'
import { TopRanking, SlowRanking } from './BigramsRankingTables'
import { BigramFingerBarChart, type FingerSort } from './BigramsFingerQuadrant'
import { BigramClassesCoverage, BigramClassesTable } from './BigramsClassesQuadrant'

interface BigramsChartProps {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  topLimit: number
  slowLimit: number
  fingerLimit: number
  /** Shared minimum-avgIki filter applied to fingerIki and slow
   * quadrants. `0` disables the filter. The user-facing name is
   * `pairIntervalThresholdMs` (matches `BigramFilters` + i18n); inner
   * components rename this to `minAvgIkiMs` to make the avgIki bucket
   * approximation explicit at the predicate site. */
  pairIntervalThresholdMs: number
  /** 2 = bigram, 3 = trigram — forwarded to the IPC as
   * `options.gram`. The Finger IKI quadrant only exists for bigrams
   * (a 3-key finger-pair isn't a defined concept), so it's hidden
   * whenever `gram === 3`. */
  gram: 2 | 3
  onTopLimitChange: (next: number) => void
  onSlowLimitChange: (next: number) => void
  onFingerLimitChange: (next: number) => void
  onPairIntervalThresholdChange: (next: number) => void
  onGramChange: (next: 2 | 3) => void
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
}

// Stable empty-array reference so the classes aggregate's useMemo dep
// doesn't churn every render while the Classes quadrant is hidden
// (gram === 3) — a fresh `[]` literal would defeat the memo instead of
// skipping the computation.
const EMPTY_CLASSES_ENTRIES: readonly TypingBigramTopEntry[] = []

export function BigramsChart({
  uid,
  range,
  deviceScopes,
  appScopes,
  typingTestScopes,
  runIdScopes,
  topLimit,
  slowLimit,
  fingerLimit,
  pairIntervalThresholdMs,
  gram,
  onTopLimitChange,
  onSlowLimitChange,
  onFingerLimitChange,
  onPairIntervalThresholdChange,
  onGramChange,
  snapshot,
  fingerOverrides,
}: BigramsChartProps): JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<TypingBigramAggregateResult>({ view: 'top', entries: [], truncated: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Finger interval sort direction. Local UI state only — defaults to
  // `desc` (slowest first) so the bar chart leads with the most stressed
  // pairs, matching the historical ordering.
  const [fingerSort, setFingerSort] = useState<FingerSort>('desc')

  const scope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(scope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchBigramAggregateForRange(uid, scope, range.fromMs, range.toMs, 'top', {
      limit: ALL_PAIRS_LIMIT,
      gram,
    }, appScopes, typingTestScopes, runIdScopes)
      .then((next) => {
        if (cancelled) return
        setResult(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('BigramsChart: typingAnalyticsGetBigramAggregateForRange failed', err)
        setError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // scope is captured inside the effect via closure but not listed —
    // scopeKey is the stable identity proxy.
  }, [uid, range.fromMs, range.toMs, scopeKey, appScopes.join('|'), gram])

  const entries = result.entries

  // The server truncates `view:'top'` to the count-ranked top
  // `ALL_PAIRS_LIMIT` distinct n-grams. When the period has that many
  // distinct pairs/triples, low-frequency-but-slow entries can fall
  // outside the fetched set — Top pairs stays accurate (it's count
  // order), but Pair interval and Finger IKI (which re-rank by avgIki)
  // may be missing entries. `result.truncated` is computed server-side
  // from the full pair universe, so this reads the real signal instead
  // of guessing from `entries.length` (which false-positives whenever
  // the period has exactly `ALL_PAIRS_LIMIT` distinct pairs).
  const cappedNoticeText = t('analyze.bigrams.cappedNotice', { limit: ALL_PAIRS_LIMIT })
  const cappedNotice = (testId: string): React.ReactNode =>
    result.truncated ? (
      <div className="text-xs text-content-muted" data-testid={testId}>
        {cappedNoticeText}
      </div>
    ) : undefined

  // Finger IKI has no defined meaning for trigrams (a 3-key finger pair
  // isn't a thing), so gram === 3 renders Top + Slow only. Dropping to a
  // single row keeps the two quadrants full-height instead of leaving an
  // empty grid cell where Finger IKI used to sit.
  const showFingerIki = gram === 2
  const gridClass = showFingerIki
    ? 'grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-3'
    : 'grid h-full min-h-0 grid-cols-2 grid-rows-1 gap-3'

  // Classes (hand-usage) aggregate — computed once here rather than
  // separately inside BigramClassesCoverage and BigramClassesTable,
  // which used to each run useKeycodeFingerMap + aggregateBigramClasses
  // on their own, doubling the work whenever either sibling quadrant
  // re-rendered. Both `snapshot` and `entries` fall back to a stable
  // empty value while the quadrant is hidden (gram === 3) so the memo
  // below settles on an empty aggregate instead of doing the fold for a
  // quadrant nobody sees.
  const classesFingerMap = useKeycodeFingerMap(showFingerIki ? snapshot : null, fingerOverrides)
  const classesEntries = showFingerIki ? entries : EMPTY_CLASSES_ENTRIES

  // Snapshot's own `code -> qmkId` map — threaded into Top/Slow pair
  // labels below so they resolve from the snapshot's own recorded
  // keymap strings instead of the session's `RAWCODES_MAP` (see
  // analyze-snapshot-codes.ts / Task-speed-ranking-snapshot-labels.md).
  const qmkByCode = useSnapshotQmkByCode(snapshot)
  const classesAggregate = useMemo(
    () => aggregateBigramClasses(classesEntries, classesFingerMap),
    [classesEntries, classesFingerMap],
  )

  // Word-position (initiation / in-word) aggregate — same "1
  // calculation, N consumers" treatment as `classesAggregate` above,
  // but with no finger map dependency: it only compares keycodes
  // against a fixed separator set, so it doesn't need a snapshot.
  // The snapshot is passed for its `vialProtocol` alone, not for a
  // keymap: it decides whether dual-role (LT/MT/SH_T) space keys can be
  // unwrapped safely. Without a snapshot the rows still render, just
  // counting bare KC_SPACE / KC_ENTER — see `aggregateWordPosition`.
  const wordPositionAggregate = useMemo(
    () => aggregateWordPosition(classesEntries, snapshot?.vialProtocol),
    [classesEntries, snapshot],
  )

  const body = loading ? (
    <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-bigrams-loading">
      {t('analyze.bigrams.loading')}
    </div>
  ) : error ? (
    <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-bigrams-error">
      {t('analyze.bigrams.error')}
    </div>
  ) : entries.length === 0 ? (
    <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-bigrams-empty">
      {t('analyze.bigrams.empty')}
    </div>
  ) : (
    <div className={gridClass} data-testid="analyze-bigrams-content">
      <Quadrant
        title={t('analyze.bigrams.quadrant.top')}
        controls={
          <LimitSelect
            value={topLimit}
            onChange={onTopLimitChange}
            testId="analyze-bigrams-top-limit-select"
          />
        }
      >
        <TopRanking entries={entries} listLimit={topLimit} gram={gram} qmkByCode={qmkByCode} vialProtocol={snapshot?.vialProtocol} />
      </Quadrant>
      {showFingerIki && (
        <Quadrant
          title={t('analyze.bigrams.quadrant.fingerIki')}
          notice={cappedNotice('analyze-bigrams-finger-capped-notice')}
          controls={
            <>
              <PairIntervalThresholdInput
                value={pairIntervalThresholdMs}
                onChange={onPairIntervalThresholdChange}
                testId="analyze-bigrams-finger-threshold-input"
              />
              <select
                value={fingerSort}
                onChange={(e) => setFingerSort(e.target.value as FingerSort)}
                className={FILTER_SELECT}
                data-testid="analyze-bigrams-finger-sort-select"
                aria-label={t('analyze.bigrams.fingerIki.sortLabel')}
              >
                <option value="desc">{t('analyze.bigrams.fingerIki.sort.desc')}</option>
                <option value="asc">{t('analyze.bigrams.fingerIki.sort.asc')}</option>
              </select>
              <LimitSelect
                value={fingerLimit}
                onChange={onFingerLimitChange}
                testId="analyze-bigrams-finger-limit-select"
              />
            </>
          }
        >
          <BigramFingerBarChart
            entries={entries}
            snapshot={snapshot}
            fingerOverrides={fingerOverrides}
            listLimit={fingerLimit}
            sort={fingerSort}
            minAvgIkiMs={pairIntervalThresholdMs}
          />
        </Quadrant>
      )}
      <Quadrant
        title={t('analyze.bigrams.quadrant.slow')}
        notice={cappedNotice('analyze-bigrams-slow-capped-notice')}
        controls={
          <>
            <PairIntervalThresholdInput
              value={pairIntervalThresholdMs}
              onChange={onPairIntervalThresholdChange}
              testId="analyze-bigrams-slow-threshold-input"
            />
            <LimitSelect
              value={slowLimit}
              onChange={onSlowLimitChange}
              testId="analyze-bigrams-slow-limit-select"
            />
          </>
        }
      >
        <SlowRanking
          entries={entries}
          listLimit={slowLimit}
          minAvgIkiMs={pairIntervalThresholdMs}
          gram={gram}
          qmkByCode={qmkByCode}
          vialProtocol={snapshot?.vialProtocol}
        />
      </Quadrant>
      {showFingerIki && (
        <Quadrant
          title={t('analyze.bigrams.quadrant.classes')}
          notice={
            <>
              {cappedNotice('analyze-bigrams-classes-capped-notice')}
              <BigramClassesCoverage aggregate={classesAggregate} hasSnapshot={snapshot !== null} />
            </>
          }
        >
          <BigramClassesTable
            aggregate={classesAggregate}
            wordPositionAggregate={wordPositionAggregate}
            hasSnapshot={snapshot !== null}
          />
        </Quadrant>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="analyze-bigrams-root">
      <div className="flex shrink-0 justify-end">
        <GramToggle value={gram} onChange={onGramChange} />
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  )
}
