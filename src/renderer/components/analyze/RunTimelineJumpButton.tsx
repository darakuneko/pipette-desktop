// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze -> Typing Test handoff: rendered by AnalyzePane next to the
// filter summary chip only when exactly one run is selected in the
// run filter AND that run belongs to the live connected keyboard (see
// AnalyzePane's own `connectedTappingTerm` gating, reused here so the
// destination view — the typing test — actually exists to re-enter).
// Leaves Analyze, re-enters the typing test view, opens History, and
// opens the keystroke timeline for this run — mirrors the row-level
// affordance `HistoryTimelineCell` already offers inside History
// itself, reachable straight from the Analyze run filter instead.

import { useTranslation } from 'react-i18next'
import { ChartNoAxesGantt } from 'lucide-react'
import { ICON_SM } from '../../constants/ui-tokens'
import { CHIP_BUTTON_CLASS } from './AnalyzeFilterSummaryChip'

interface Props {
  runId: string
  onOpen: (runId: string) => void
  testId: string
}

export function RunTimelineJumpButton({ runId, onOpen, testId }: Props) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={`${CHIP_BUTTON_CLASS} shrink-0 text-content-secondary hover:text-content`}
      onClick={() => onOpen(runId)}
      data-testid={testId}
    >
      <ChartNoAxesGantt size={ICON_SM} aria-hidden="true" />
      {t('analyze.filters.openRunTimeline')}
    </button>
  )
}
