// SPDX-License-Identifier: GPL-2.0-or-later
// Shared state keys for the Analyze tab. Kept here so the chart
// components can import them without the whole view.
//
// Literal unions that also need to round-trip through the main-process
// validator (PipetteSettings.analyze.filters) live in
// `src/shared/types/analyze-filters.ts`; this file re-exports them so
// existing renderer imports keep working.

export type {
  ActivityCalendarMonthsToShow,
  ActivityCalendarNormalization,
  ActivityMetric,
  ActivityView,
  DeviceScope,
  ErgonomicsLearningPeriod,
  ErgonomicsViewMode,
  GranularityChoice,
  HeatmapNormalization,
  IntervalUnit,
  IntervalViewMode,
  LayerViewMode,
  WpmViewMode,
} from '../../../shared/types/analyze-filters'

export type AnalysisTabKey = 'summary' | 'wpm' | 'interval' | 'activity' | 'keyHeatmap' | 'ergonomics' | 'bigrams' | 'layoutComparison' | 'layer' | 'byApp'

/** Inclusive-lower, exclusive-upper millisecond range used by every
 * Analyze chart. `toMs` is the wall-clock the page was opened at and
 * the chart UI caps it to "now" so the user cannot pick the future. */
export interface RangeMs {
  fromMs: number
  toMs: number
}
