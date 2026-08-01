// SPDX-License-Identifier: GPL-2.0-or-later
// Row 2 of the Analyze pane's filter row: the per-tab filter controls
// (WPM / Activity / Interval / Ergonomics / Layout Comparison / shared
// Granularity) plus the finger-assignment button. Split out of
// AnalyzePane.tsx (Task-split-analyze-pane).
//
// Renders a FRAGMENT of the exact same label sequence the inline JSX
// used to produce — the parent keeps the CSS grid wrapper div
// (`gridTemplateColumns: repeat(10, max-content)`) so this component's
// output slots into it unchanged; wrapping it in another element here
// would collapse that layout.
//
// The finger-assignment button is NOT included here even though the
// original cut plan grouped it with Row 2: it renders as a flex
// SIBLING of the grid div (`ml-auto` pushes it to the far right of the
// outer flex row), not as one of the grid's own children. Folding it
// into this component's Fragment would place it inside the grid div
// instead and turn it into an 11th grid-template column, which is a
// real (if subtle) layout regression — so it stays inline in
// AnalyzePane.tsx, a deliberate deviation from the line-range grouping.

import { useTranslation } from 'react-i18next'
import {
  ACTIVITY_CALENDAR_MONTHS_TO_SHOW,
  ACTIVITY_CALENDAR_NORMALIZATIONS,
  ACTIVITY_METRICS,
  ACTIVITY_VIEWS,
  ERGONOMICS_LEARNING_PERIODS,
  ERGONOMICS_VIEW_MODES,
  INTERVAL_UNITS,
  INTERVAL_VIEW_MODES,
  WPM_VIEW_MODES,
  type ActivityCalendarMonthsToShow,
  type ActivityCalendarNormalization,
  type ActivityFilters,
  type ActivityMetric,
  type ActivityView,
  type DistributionSection,
  type ErgonomicsFilters,
  type ErgonomicsLearningPeriod,
  type ErgonomicsViewMode,
  type GranularityChoice,
  type IntervalFilters,
  type IntervalUnit,
  type IntervalViewMode,
  type LayoutComparisonFilters,
  type WpmFilters,
  type WpmViewMode,
} from '../../../shared/types/analyze-filters'
import type { AnalyzeFiltersState } from '../../hooks/useAnalyzeFilters'
import type { AnalysisTabKey } from './analyze-types'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'
import { LayoutComparisonSelector } from './LayoutComparisonSelector'
// Sourced from `analyze-bucket` (the same module this table is kept in
// sync with) rather than from AnalyzePane: importing a value back out of
// the parent module would close an import cycle
// (AnalyzePane -> FilterRow -> TabFilters -> AnalyzePane), and this
// module-scope table would then read `DAY_MS` before the parent module
// body has initialized it.
import { DAY_MS } from './analyze-bucket'

const WPM_MIN_SAMPLE_OPTIONS: Array<{ value: number; labelKey: string }> = [
  { value: 30_000, labelKey: 'sec30' },
  { value: 60_000, labelKey: 'min1' },
  { value: 60_000 * 2, labelKey: 'min2' },
  { value: 60_000 * 5, labelKey: 'min5' },
]

// Keep this table in sync with `GRANULARITIES` in analyze-bucket.ts;
// the first entry is the "let the chart decide" pseudo-choice.
const GRANULARITY_OPTIONS: Array<{ value: GranularityChoice; labelKey: string }> = [
  { value: 'auto', labelKey: 'auto' },
  { value: 60_000, labelKey: 'min1' },
  { value: 60_000 * 5, labelKey: 'min5' },
  { value: 60_000 * 10, labelKey: 'min10' },
  { value: 60_000 * 15, labelKey: 'min15' },
  { value: 60_000 * 30, labelKey: 'min30' },
  { value: 3_600_000, labelKey: 'hour1' },
  { value: 3_600_000 * 3, labelKey: 'hour3' },
  { value: 3_600_000 * 6, labelKey: 'hour6' },
  { value: 3_600_000 * 12, labelKey: 'hour12' },
  { value: DAY_MS, labelKey: 'day1' },
  { value: DAY_MS * 3, labelKey: 'day3' },
  { value: DAY_MS * 7, labelKey: 'week1' },
  { value: DAY_MS * 30, labelKey: 'month1' },
]

// Interval > Distribution's section select reuses each section's own
// `sectionTitle` key as its option label — the same string that used to
// sit as an in-body <h3> before the switcher took over labeling (see
// DurationSection.tsx / TappingTermCard.tsx / IntervalChart.tsx's
// distribution branch), so the select and the content it reveals never
// disagree on the section's name.
const DISTRIBUTION_SECTION_LABEL_KEY: Record<DistributionSection, string> = {
  interval: 'analyze.interval.distribution.sectionTitle',
  duration: 'analyze.duration.sectionTitle',
  tappingTerm: 'analyze.tappingTerm.sectionTitle',
}

export interface AnalyzePaneTabFiltersProps {
  tid: (id: string) => string
  analysisTab: AnalysisTabKey
  wpmFilter: AnalyzeFiltersState['wpm']
  setWpm: (patch: Partial<WpmFilters>) => void
  activityFilter: AnalyzeFiltersState['activity']
  setActivity: (patch: Partial<ActivityFilters>) => void
  intervalFilter: AnalyzeFiltersState['interval']
  setIntervalFilter: (patch: Partial<IntervalFilters>) => void
  effectiveDistributionSection: DistributionSection
  availableDistributionSections: readonly DistributionSection[]
  ergonomicsFilter: AnalyzeFiltersState['ergonomics']
  setErgonomics: (patch: Partial<ErgonomicsFilters>) => void
  layoutComparisonFilter: AnalyzeFiltersState['layoutComparison']
  setLayoutComparison: (patch: Partial<LayoutComparisonFilters>) => void
  showBenchmark: boolean
  handleShowBenchmarkChange: (next: boolean) => Promise<void>
}

export function AnalyzePaneTabFilters({
  tid,
  analysisTab,
  wpmFilter,
  setWpm,
  activityFilter,
  setActivity,
  intervalFilter,
  setIntervalFilter,
  effectiveDistributionSection,
  availableDistributionSections,
  ergonomicsFilter,
  setErgonomics,
  layoutComparisonFilter,
  setLayoutComparison,
  showBenchmark,
  handleShowBenchmarkChange,
}: AnalyzePaneTabFiltersProps): JSX.Element {
  const { t } = useTranslation()

  // Shared between the WPM and Interval controls rows — both charts'
  // reference lines are bound to the one persisted flag, so flipping
  // this checkbox in either tab affects both.
  const benchmarkToggle = (
    <label className={FILTER_LABEL}>
      <span>{t('analyze.benchmark.referenceLineLabel')}</span>
      <input
        type="checkbox"
        className="cursor-pointer"
        checked={showBenchmark}
        onChange={(e) => void handleShowBenchmarkChange(e.target.checked)}
        aria-label={t('analyze.benchmark.toggleAria')}
        data-testid={tid("analyze-filter-benchmark-toggle")}
      />
    </label>
  )

  // Activity's per-tab filters render in two places: alongside Period
  // on Row 2 in split mode, or on Row 3 in single mode. Extracted so
  // the JSX stays in one place. Order: View → Range size + cursor
  // (calendar only) → Metric → view-specific extras (calendar
  // normalize, or grid WPM min-sample).
  const activityFilters = (
    <>
      <label className={FILTER_LABEL}>
        <span>{t('analyze.filters.activityView')}</span>
        <select
          className={FILTER_SELECT}
          value={activityFilter.view}
          onChange={(e) => setActivity({ view: e.target.value as ActivityView })}
          data-testid={tid("analyze-filter-activity-view")}
        >
          {ACTIVITY_VIEWS.map((key) => (
            <option key={key} value={key}>
              {t(`analyze.filters.activityViewOption.${key}`)}
            </option>
          ))}
        </select>
      </label>
      {activityFilter.view === 'calendar' && (
        <>
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.calendarRange')}</span>
            <select
              className={FILTER_SELECT}
              value={String(activityFilter.calendar.monthsToShow)}
              onChange={(e) => setActivity({ calendar: { monthsToShow: Number.parseInt(e.target.value, 10) as ActivityCalendarMonthsToShow } })}
              data-testid={tid("analyze-filter-calendar-range")}
            >
              {ACTIVITY_CALENDAR_MONTHS_TO_SHOW.map((n) => (
                <option key={n} value={String(n)}>
                  {t(`analyze.filters.calendarRangeOption.${n}`)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className={FILTER_LABEL}>
        <span>{t('analyze.filters.activityMetric')}</span>
        <select
          className={FILTER_SELECT}
          value={activityFilter.metric}
          onChange={(e) => setActivity({ metric: e.target.value as ActivityMetric })}
          data-testid={tid("analyze-filter-activity-metric")}
        >
          {ACTIVITY_METRICS.map((key) => (
            <option key={key} value={key}>
              {t(`analyze.filters.activityMetricOption.${key}`)}
            </option>
          ))}
        </select>
      </label>
      {activityFilter.view === 'grid' && activityFilter.metric === 'wpm' && (
        <label className={FILTER_LABEL}>
          <span>{t('analyze.filters.wpmMinSample')}</span>
          <select
            className={FILTER_SELECT}
            value={String(wpmFilter.minActiveMs)}
            onChange={(e) => setWpm({ minActiveMs: Number.parseInt(e.target.value, 10) })}
            data-testid={tid("analyze-filter-activity-min-sample")}
          >
            {WPM_MIN_SAMPLE_OPTIONS.map((opt) => (
              <option key={opt.labelKey} value={String(opt.value)}>
                {t(`analyze.filters.wpmMinSampleOption.${opt.labelKey}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {activityFilter.view === 'calendar' && (
        <label className={FILTER_LABEL}>
          <span>{t('analyze.filters.calendarNormalization')}</span>
          <select
            className={FILTER_SELECT}
            value={activityFilter.calendar.normalization}
            onChange={(e) => setActivity({ calendar: { normalization: e.target.value as ActivityCalendarNormalization } })}
            data-testid={tid("analyze-filter-calendar-normalization")}
          >
            {ACTIVITY_CALENDAR_NORMALIZATIONS.map((key) => (
              <option key={key} value={key}>
                {t(`analyze.filters.calendarNormalizationOption.${key}`)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )

  return (
    <>
      {analysisTab === 'wpm' && (
        <>
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.wpmViewMode')}</span>
            <select
              className={FILTER_SELECT}
              value={wpmFilter.viewMode}
              onChange={(e) => setWpm({ viewMode: e.target.value as WpmViewMode })}
              data-testid={tid("analyze-filter-wpm-view-mode")}
            >
              {WPM_VIEW_MODES.map((key) => (
                <option key={key} value={key}>
                  {t(`analyze.filters.wpmViewModeOption.${key}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.wpmMinSample')}</span>
            <select
              className={FILTER_SELECT}
              value={String(wpmFilter.minActiveMs)}
              onChange={(e) => setWpm({ minActiveMs: Number.parseInt(e.target.value, 10) })}
              data-testid={tid("analyze-filter-wpm-min-sample")}
            >
              {WPM_MIN_SAMPLE_OPTIONS.map((opt) => (
                <option key={opt.labelKey} value={String(opt.value)}>
                  {t(`analyze.filters.wpmMinSampleOption.${opt.labelKey}`)}
                </option>
              ))}
            </select>
          </label>
          {wpmFilter.viewMode === 'timeSeries' && benchmarkToggle}
        </>
      )}
      {analysisTab === 'activity' && activityFilters}
      {analysisTab === 'interval' && (
        <>
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.intervalViewMode')}</span>
            <select
              className={FILTER_SELECT}
              value={intervalFilter.viewMode}
              onChange={(e) => setIntervalFilter({ viewMode: e.target.value as IntervalViewMode })}
              data-testid={tid("analyze-filter-interval-view-mode")}
            >
              {INTERVAL_VIEW_MODES.map((key) => (
                <option key={key} value={key}>
                  {t(`analyze.filters.intervalViewModeOption.${key}`)}
                </option>
              ))}
            </select>
          </label>
          {intervalFilter.viewMode === 'distribution' && (
            <label className={FILTER_LABEL}>
              <span>{t('analyze.filters.intervalDistributionSection')}</span>
              <select
                className={FILTER_SELECT}
                value={effectiveDistributionSection}
                onChange={(e) => setIntervalFilter({ distributionSection: e.target.value as DistributionSection })}
                data-testid={tid("analyze-filter-interval-distribution-section")}
              >
                {availableDistributionSections.map((section) => (
                  <option key={section} value={section}>
                    {t(DISTRIBUTION_SECTION_LABEL_KEY[section])}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.unit')}</span>
            <select
              className={FILTER_SELECT}
              value={intervalFilter.unit}
              onChange={(e) => setIntervalFilter({ unit: e.target.value as IntervalUnit })}
              data-testid={tid("analyze-filter-unit")}
            >
              {INTERVAL_UNITS.map((key) => (
                <option key={key} value={key}>
                  {t(`analyze.filters.unitOption.${key}`)}
                </option>
              ))}
            </select>
          </label>
          {intervalFilter.viewMode === 'timeSeries' && benchmarkToggle}
        </>
      )}
      {analysisTab === 'ergonomics' && (
        <>
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.ergonomicsViewMode')}</span>
            <select
              className={FILTER_SELECT}
              value={ergonomicsFilter.viewMode}
              onChange={(e) => setErgonomics({ viewMode: e.target.value as ErgonomicsViewMode })}
              data-testid={tid("analyze-filter-ergonomics-view-mode")}
            >
              {ERGONOMICS_VIEW_MODES.map((key) => (
                <option key={key} value={key}>
                  {t(`analyze.filters.ergonomicsViewModeOption.${key}`)}
                </option>
              ))}
            </select>
          </label>
          {ergonomicsFilter.viewMode === 'learning' && (
            <label className={FILTER_LABEL}>
              <span>{t('analyze.filters.ergonomicsPeriod')}</span>
              <select
                className={FILTER_SELECT}
                value={ergonomicsFilter.period}
                onChange={(e) => setErgonomics({ period: e.target.value as ErgonomicsLearningPeriod })}
                data-testid={tid("analyze-filter-ergonomics-period")}
              >
                {ERGONOMICS_LEARNING_PERIODS.map((key) => (
                  <option key={key} value={key}>
                    {t(`analyze.filters.ergonomicsPeriodOption.${key}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {analysisTab === 'layoutComparison' && (
        <LayoutComparisonSelector
          sourceLayoutId={layoutComparisonFilter.sourceLayoutId}
          targetLayoutId={layoutComparisonFilter.targetLayoutId}
          onSourceChange={(sourceLayoutId) => setLayoutComparison({ sourceLayoutId })}
          onTargetChange={(targetLayoutId) => setLayoutComparison({ targetLayoutId })}
        />
      )}
      {((analysisTab === 'wpm' && wpmFilter.viewMode === 'timeSeries') || (analysisTab === 'interval' && intervalFilter.viewMode === 'timeSeries')) && (
        <label className={FILTER_LABEL}>
          <span>{t('analyze.filters.granularity')}</span>
          <select
            className={FILTER_SELECT}
            value={typeof wpmFilter.granularity === 'number' ? String(wpmFilter.granularity) : 'auto'}
            onChange={(e) => {
              const v = e.target.value
              setWpm({ granularity: v === 'auto' ? 'auto' : Number.parseInt(v, 10) })
            }}
            data-testid={tid("analyze-filter-granularity")}
          >
            {GRANULARITY_OPTIONS.map((opt) => (
              <option key={opt.labelKey} value={typeof opt.value === 'number' ? String(opt.value) : 'auto'}>
                {t(`analyze.filters.granularityOption.${opt.labelKey}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Layer tab: filters live inside the chart sections —
       * the base-layer select rides next to the activations
       * heading instead of in this global filter row. */}
    </>
  )
}
