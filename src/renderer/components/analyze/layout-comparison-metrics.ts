// SPDX-License-Identifier: GPL-2.0-or-later
// Phase 1 metrics shared by `LayoutComparisonView` (live chart) and
// `analyze-csv-builders` (CSV export). Hoisted into its own module so
// the two consumers can never drift apart — adding a metric here
// updates both call sites at once.

import type { LayoutComparisonMetric } from '../../../shared/types/typing-analytics'

export const LAYOUT_COMPARISON_PHASE_1_METRICS: readonly LayoutComparisonMetric[] = [
  'fingerLoad',
  'handBalance',
  'rowDist',
  'homeRow',
]
