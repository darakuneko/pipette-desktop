// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze pane's filter row: Row 1 (the collapsed summary chip +
// optional "open run timeline" button) and Row 2 (the per-tab filter
// controls + the finger-assignment button). Split out of
// AnalyzePane.tsx (Task-split-analyze-pane, mechanical follow-up pass
// to get the pane under the 500-line cap).
//
// A plain flow element (no `position: absolute` / ref-based outside-
// click wiring like the store panel overlay), so it moves cleanly.

import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { AnalysisTabKey } from './analyze-types'
import type {
  ActivityFilters,
  DistributionSection,
  ErgonomicsFilters,
  IntervalFilters,
  LayoutComparisonFilters,
  WpmFilters,
} from '../../../shared/types/analyze-filters'
import type { AnalyzeFiltersState } from '../../hooks/useAnalyzeFilters'
import type { FilterConditionLabels } from './filter-labels'
import { AnalyzeFilterSummaryChip } from './AnalyzeFilterSummaryChip'
import { RunTimelineJumpButton } from './RunTimelineJumpButton'
import { AnalyzePaneTabFilters } from './AnalyzePaneTabFilters'

/** Tabs whose chart consumes `fingerAssignments` (Summary's peak-record
 * finger stat, Ergonomics, Bigrams' finger quadrant, and Layout
 * Comparison's finger-load metric). The Row 2 finger-assignment button
 * shows on all four so the user can jump to the editor from wherever
 * they're looking at finger-derived data, not just Ergonomics. */
const FINGER_ASSIGNMENT_TABS = new Set<AnalysisTabKey>(['summary', 'ergonomics', 'bigrams', 'layoutComparison'])

export interface AnalyzePaneFilterRowProps {
  tid: (id: string) => string
  selected: TypingKeyboardSummary | null
  filtersReady: boolean
  syncingAnalytics: boolean
  chipLabels: FilterConditionLabels
  onOpenFilterModal: () => void
  onOpenRunTimeline?: (runId: string) => void
  runIdScopes: string[]
  isConnectedKeyboard: boolean
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
  effectiveSnapshot: TypingKeymapSnapshot | null
  onOpenFingerModal: () => void
}

export function AnalyzePaneFilterRow({
  tid,
  selected,
  filtersReady,
  syncingAnalytics,
  chipLabels,
  onOpenFilterModal,
  onOpenRunTimeline,
  runIdScopes,
  isConnectedKeyboard,
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
  effectiveSnapshot,
  onOpenFingerModal,
}: AnalyzePaneFilterRowProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      className={`flex min-w-0 shrink-0 flex-col gap-y-2 overflow-x-auto border-b border-edge pb-3 mt-3 ${
        selected !== null && (!filtersReady || syncingAnalytics) ? 'pointer-events-none opacity-60' : ''
      }`}
      data-testid={tid("analyze-filters")}
      aria-busy={selected !== null && (!filtersReady || syncingAnalytics)}
    >
      {/* Row 1: the filter summary chip. */}
      <div className="flex min-w-0 items-center">
        <AnalyzeFilterSummaryChip
          keyboardLabel={chipLabels.keyboardLabel}
          deviceLabel={chipLabels.deviceLabel}
          sourceLabel={chipLabels.sourceLabel}
          periodLabel={chipLabels.periodLabel}
          onClick={onOpenFilterModal}
          testId={tid('analyze-filter-chip')}
        />
        {selected && onOpenRunTimeline && runIdScopes.length === 1 && isConnectedKeyboard && (
          <RunTimelineJumpButton runId={runIdScopes[0]} onOpen={onOpenRunTimeline} testId={tid('analyze-open-run-timeline')} />
        )}
      </div>
      {/* Row 2: tab-specific filters, unchanged by the chip/modal
       * restructure. Its own 10-column max-content grid keeps every
       * row's labels left and values right as the per-tab filter set
       * changes shape across tabs. `min-w-max` on the outer flex
       * keeps the finger-assignment button from squeezing into (or
       * overlapping) the grid when this row's ancestor scrolls
       * horizontally (`overflow-x-auto` above). */}
      {selected && (
        <div className="flex w-full min-w-max items-center">
        <div
          className="grid min-w-0 items-center gap-x-3 gap-y-2"
          style={{ gridTemplateColumns: 'repeat(10, max-content)' }}
        >
          <AnalyzePaneTabFilters
            tid={tid}
            analysisTab={analysisTab}
            wpmFilter={wpmFilter}
            setWpm={setWpm}
            activityFilter={activityFilter}
            setActivity={setActivity}
            intervalFilter={intervalFilter}
            setIntervalFilter={setIntervalFilter}
            effectiveDistributionSection={effectiveDistributionSection}
            availableDistributionSections={availableDistributionSections}
            ergonomicsFilter={ergonomicsFilter}
            setErgonomics={setErgonomics}
            layoutComparisonFilter={layoutComparisonFilter}
            setLayoutComparison={setLayoutComparison}
            showBenchmark={showBenchmark}
            handleShowBenchmarkChange={handleShowBenchmarkChange}
          />
        </div>
        {FINGER_ASSIGNMENT_TABS.has(analysisTab) && effectiveSnapshot !== null && (
          <button
            type="button"
            className="ml-auto shrink-0 rounded-md border border-edge bg-surface px-3 py-1 text-xs text-content-secondary transition-colors hover:border-accent hover:text-content"
            onClick={onOpenFingerModal}
            data-testid="analyze-finger-assignment-open"
          >
            {t('analyze.fingerAssignment.button')}
          </button>
        )}
        </div>
      )}
    </div>
  )
}
