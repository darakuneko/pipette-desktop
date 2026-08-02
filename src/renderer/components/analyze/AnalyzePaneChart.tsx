// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze pane's chart area: the 10-way tab switch that renders
// whichever chart matches the active `analysisTab`. Split out of
// AnalyzePane.tsx (Task-split-analyze-pane).
//
// The wrapper div (`data-testid={tid("analyze-chart")}`) STAYS in
// AnalyzePane — wpm-screenshot.ts depends on the recharts legend being
// a descendant of that exact node — so this component renders only its
// contents, unwrapped.

import { useTranslation } from 'react-i18next'
import type { TypingKeymapSnapshot, TypingKeyboardSummary } from '../../../shared/types/typing-analytics'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type {
  AnalysisTabKey,
  ConnectedTappingTerm,
  RangeMs,
} from './analyze-types'
import type {
  ActivityFilters,
  BigramFilters,
  DeviceScope,
  DistributionSection,
  HeatmapFilters,
  LayerFilters,
} from '../../../shared/types/analyze-filters'
import type { AnalyzeFiltersState } from '../../hooks/useAnalyzeFilters'
import { ActivityChart } from './ActivityChart'
import { BigramsChart } from './BigramsChart'
import { ErgonomicsChart } from './ErgonomicsChart'
import { LayoutComparisonView } from './LayoutComparisonView'
import { IntervalChart } from './IntervalChart'
import { RolloverSection } from './RolloverSection'
import { DurationSection } from './DurationSection'
import { TappingTermCard } from './TappingTermCard'
import { KeyHeatmapChart } from './KeyHeatmapChart'
import { LayerUsageChart } from './LayerUsageChart'
import { SummaryView } from './SummaryView'
import { WpmChart } from './WpmChart'
import { WpmByAppChart } from './WpmByAppChart'
import { AppUsageChart } from './AppUsageChart'
import { shiftLocalMonth } from './analyze-streak-goal'

export interface AnalyzePaneChartProps {
  // Identity / range / scopes — which chart tab and keyboard, the active
  // time window, and the device/app/test/run scope filters.
  tid: (id: string) => string
  analysisTab: AnalysisTabKey
  selected: TypingKeyboardSummary
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  // Snapshot-derived values — keymap snapshot, per-finger assignment, and
  // typing-test results resolved for the current scope.
  effectiveSnapshot: TypingKeymapSnapshot | null
  fingerAssignments: Record<string, FingerType>
  typingTestResults: TypingTestResult[]
  // Filter state + setters — per-chart filter values (with setters where the
  // chart can mutate them), plus the snapshot/connection status flags and the
  // current-time value some of these filters read.
  wpmFilter: AnalyzeFiltersState['wpm']
  showBenchmark: boolean
  intervalFilter: AnalyzeFiltersState['interval']
  effectiveDistributionSection: DistributionSection
  snapshotLoading: boolean
  isConnectedKeyboard: boolean
  connectedTappingTerm?: ConnectedTappingTerm | null
  activityFilter: AnalyzeFiltersState['activity']
  setActivity: (patch: Partial<ActivityFilters>) => void
  nowMs: number
  heatmapFilter: AnalyzeFiltersState['heatmap']
  setHeatmap: (patch: Partial<HeatmapFilters>) => void
  ergonomicsFilter: AnalyzeFiltersState['ergonomics']
  bigramsFilter: AnalyzeFiltersState['bigrams']
  setBigrams: (patch: Partial<BigramFilters>) => void
  layoutComparisonFilter: AnalyzeFiltersState['layoutComparison']
  // Callback — notifies the parent when the Skip% derived from the active
  // filter changes.
  onSkipPercentChange?: (percent: number | null) => void
  layerFilter: AnalyzeFiltersState['layer']
  setLayer: (patch: Partial<LayerFilters>) => void
}

export function AnalyzePaneChart({
  tid,
  analysisTab,
  selected,
  range,
  deviceScopes,
  appScopes,
  typingTestScopes,
  runIdScopes,
  effectiveSnapshot,
  fingerAssignments,
  typingTestResults,
  wpmFilter,
  showBenchmark,
  intervalFilter,
  effectiveDistributionSection,
  snapshotLoading,
  isConnectedKeyboard,
  connectedTappingTerm,
  activityFilter,
  setActivity,
  nowMs,
  heatmapFilter,
  setHeatmap,
  ergonomicsFilter,
  bigramsFilter,
  setBigrams,
  layoutComparisonFilter,
  onSkipPercentChange,
  layerFilter,
  setLayer,
}: AnalyzePaneChartProps): JSX.Element | null {
  const { t } = useTranslation()

  return (
    <>
      {analysisTab === 'summary' ? (
        <SummaryView
          uid={selected.uid}
          deviceScope={deviceScopes[0]}
          appScopes={appScopes}
          typingTestScopes={typingTestScopes}
          runIdScopes={runIdScopes}
          snapshot={effectiveSnapshot}
          fingerOverrides={fingerAssignments}
          typingTestResults={typingTestResults}
        />
      ) : analysisTab === 'wpm' ? (
        <WpmChart
          uid={selected.uid}
          range={range}
          deviceScopes={deviceScopes}
          appScopes={appScopes}
          typingTestScopes={typingTestScopes}
          runIdScopes={runIdScopes}
          granularity={wpmFilter.granularity}
          viewMode={wpmFilter.viewMode}
          minActiveMs={wpmFilter.minActiveMs}
          showBenchmark={showBenchmark}
        />
      ) : analysisTab === 'interval' ? (
        // Flex column so IntervalChart and RolloverSection share
        // the tab's height in timeSeries mode instead of
        // IntervalChart's own `h-full` root claiming the whole
        // viewport and pushing RolloverSection below the fold.
        // `flex-1 min-h-0` lets the chart shrink to make room;
        // `shrink-0` keeps RolloverSection at its natural height
        // rather than getting squeezed (the #328 contract).
        //
        // Distribution mode is structurally different: instead
        // of stacking IntervalChart / DurationSection /
        // TappingTermCard (which forced a scroll — the whole
        // reason a section picker exists), the filter row's
        // "Section" select (next to View/Display, see the
        // controls row below) picks exactly one of the three to
        // mount at a time, each at its own natural (`shrink-0`-
        // friendly) height — see `distributionSection` persisted
        // alongside `viewMode`.
        <div className="flex h-full min-h-0 flex-col gap-3">
          {intervalFilter.viewMode === 'timeSeries' && (
            <div className="min-h-0 flex-1">
              <IntervalChart
                uid={selected.uid}
                range={range}
                deviceScopes={deviceScopes}
                appScopes={appScopes}
                typingTestScopes={typingTestScopes}
                runIdScopes={runIdScopes}
                unit={intervalFilter.unit}
                granularity={wpmFilter.granularity}
                viewMode={intervalFilter.viewMode}
                showBenchmark={showBenchmark}
              />
            </div>
          )}
          {intervalFilter.viewMode === 'timeSeries' && (
            <div className="shrink-0">
              <RolloverSection
                uid={selected.uid}
                range={range}
                deviceScopes={deviceScopes}
                appScopes={appScopes}
                typingTestScopes={typingTestScopes}
                runIdScopes={runIdScopes}
                granularity={wpmFilter.granularity}
                showBenchmark={showBenchmark}
              />
            </div>
          )}
          {intervalFilter.viewMode === 'distribution' && (
            <div className="shrink-0 flex flex-col gap-3">
              {effectiveDistributionSection === 'interval' && (
                <IntervalChart
                  uid={selected.uid}
                  range={range}
                  deviceScopes={deviceScopes}
                  appScopes={appScopes}
                  typingTestScopes={typingTestScopes}
                  runIdScopes={runIdScopes}
                  unit={intervalFilter.unit}
                  granularity={wpmFilter.granularity}
                  viewMode={intervalFilter.viewMode}
                  showBenchmark={showBenchmark}
                />
              )}
              {effectiveDistributionSection === 'duration' && (
                <DurationSection
                  uid={selected.uid}
                  range={range}
                  deviceScopes={deviceScopes}
                  appScopes={appScopes}
                  typingTestScopes={typingTestScopes}
                  runIdScopes={runIdScopes}
                />
              )}
              {effectiveDistributionSection === 'tappingTerm' && (
                <TappingTermCard
                  uid={selected.uid}
                  range={range}
                  appScopes={appScopes}
                  typingTestScopes={typingTestScopes}
                  runIdScopes={runIdScopes}
                  snapshot={effectiveSnapshot}
                  snapshotLoading={snapshotLoading}
                  connectedTappingTerm={isConnectedKeyboard && connectedTappingTerm ? connectedTappingTerm : null}
                />
              )}
            </div>
          )}
        </div>
      ) : analysisTab === 'activity' ? (
        <ActivityChart
          uid={selected.uid}
          range={range}
          deviceScope={deviceScopes[0]}
          appScopes={appScopes}
          typingTestScopes={typingTestScopes}
          runIdScopes={runIdScopes}
          metric={activityFilter.metric}
          view={activityFilter.view}
          minActiveMs={wpmFilter.minActiveMs}
          calendarFilter={activityFilter.calendar}
          nowMs={nowMs}
          onShiftCalendarMonth={(delta) => setActivity({ calendar: { endMonthIso: shiftLocalMonth(activityFilter.calendar.endMonthIso, delta) } })}
        />
      ) : analysisTab === 'keyHeatmap' ? (
        effectiveSnapshot !== null ? (
          <KeyHeatmapChart
            uid={selected.uid}
            range={range}
            deviceScope={deviceScopes[0]}
            appScopes={appScopes}
            typingTestScopes={typingTestScopes}
            runIdScopes={runIdScopes}
            snapshot={effectiveSnapshot}
            heatmap={heatmapFilter}
            onHeatmapChange={setHeatmap}
          />
        ) : (
          <div className="py-4 text-center text-sm text-content-muted" data-testid={tid("analyze-keyheatmap-empty")}>
            {t('analyze.keyHeatmap.noSnapshot')}
          </div>
        )
      ) : analysisTab === 'ergonomics' ? (
        effectiveSnapshot !== null ? (
          <ErgonomicsChart
            uid={selected.uid}
            range={range}
            deviceScopes={deviceScopes}
            appScopes={appScopes}
            typingTestScopes={typingTestScopes}
            runIdScopes={runIdScopes}
            snapshot={effectiveSnapshot}
            fingerOverrides={fingerAssignments}
            viewMode={ergonomicsFilter.viewMode}
            period={ergonomicsFilter.period}
            learningMinSampleKeystrokes={ergonomicsFilter.minSampleKeystrokes}
          />
        ) : (
          <div className="py-4 text-center text-sm text-content-muted" data-testid={tid("analyze-ergonomics-no-snapshot")}>
            {t('analyze.ergonomics.noSnapshot')}
          </div>
        )
      ) : analysisTab === 'bigrams' ? (
        <BigramsChart
          uid={selected.uid}
          range={range}
          deviceScopes={deviceScopes}
          appScopes={appScopes}
          typingTestScopes={typingTestScopes}
          runIdScopes={runIdScopes}
          topLimit={bigramsFilter.topLimit}
          slowLimit={bigramsFilter.slowLimit}
          fingerLimit={bigramsFilter.fingerLimit}
          pairIntervalThresholdMs={bigramsFilter.pairIntervalThresholdMs}
          gram={bigramsFilter.gram}
          onTopLimitChange={(topLimit) => setBigrams({ topLimit })}
          onSlowLimitChange={(slowLimit) => setBigrams({ slowLimit })}
          onFingerLimitChange={(fingerLimit) => setBigrams({ fingerLimit })}
          onPairIntervalThresholdChange={(pairIntervalThresholdMs) => setBigrams({ pairIntervalThresholdMs })}
          onGramChange={(gram) => setBigrams({ gram })}
          snapshot={effectiveSnapshot}
          fingerOverrides={fingerAssignments}
        />
      ) : analysisTab === 'layoutComparison' ? (
        <LayoutComparisonView
          uid={selected.uid}
          range={range}
          deviceScopes={deviceScopes}
          appScopes={appScopes}
          typingTestScopes={typingTestScopes}
          runIdScopes={runIdScopes}
          snapshot={effectiveSnapshot}
          filter={layoutComparisonFilter}
          fingerOverrides={fingerAssignments}
          onSkipPercentChange={onSkipPercentChange}
        />
      ) : analysisTab === 'layer' ? (
        // Two columns side-by-side, each scrolling independently.
        // Layers can run up to ~32, so a single shared scroll
        // would force the user to scroll past one chart to read
        // the other. `min-h-0` lets the inner overflow take
        // effect; `min-w-0` keeps the recharts measurement from
        // pushing either column wider than its grid track.
        <div className="grid h-full min-h-0 grid-cols-2 gap-4">
          <div className="min-w-0 overflow-y-auto pr-1">
            <LayerUsageChart
              uid={selected.uid}
              range={range}
              deviceScopes={deviceScopes}
              appScopes={appScopes}
              typingTestScopes={typingTestScopes}
              runIdScopes={runIdScopes}
              snapshot={effectiveSnapshot}
              viewMode="keystrokes"
              baseLayer={layerFilter.baseLayer}
            />
          </div>
          <div className="min-w-0 overflow-y-auto pr-1">
            <LayerUsageChart
              uid={selected.uid}
              range={range}
              deviceScopes={deviceScopes}
              appScopes={appScopes}
              typingTestScopes={typingTestScopes}
              runIdScopes={runIdScopes}
              snapshot={effectiveSnapshot}
              viewMode="activations"
              baseLayer={layerFilter.baseLayer}
              onBaseLayerChange={(baseLayer) => setLayer({ baseLayer })}
            />
          </div>
        </div>
      ) : analysisTab === 'byApp' ? (
        // Dedicated tab that groups every per-app cross-section
        // chart. Both views aggregate _across_ apps regardless
        // of the App filter at the top of the panel — picking a
        // single app would collapse them to one slice / bar,
        // which is the opposite of what these views are meant
        // to show.
        <div className="flex flex-col gap-6">
          <AppUsageChart
            uid={selected.uid}
            range={range}
            deviceScopes={deviceScopes}
          />
          <WpmByAppChart
            uid={selected.uid}
            range={range}
            deviceScopes={deviceScopes}
          />
        </div>
      ) : null}
    </>
  )
}
