// SPDX-License-Identifier: GPL-2.0-or-later
// Closed-state summary for the Analyze filter row (Plan-analyze-filter-
// modal). Replaces the old always-expanded keyboard/device/source grid
// with a single "keyboard · device · source · period" chip; clicking it
// opens `AnalyzeFilterModal` for the full staged editor. The Keymap
// snapshot quick-selector stays outside this chip (rendered as a sibling
// by `AnalyzePane`) since it has its own always-visible quick-pick UX.

import { useTranslation } from 'react-i18next'
import { ChevronDown, Filter } from 'lucide-react'
import { ICON_SM, ICON_XS } from '../../constants/ui-tokens'

interface Props {
  keyboardLabel: string
  deviceLabel: string
  sourceLabel: string
  periodLabel: string
  onClick: () => void
  testId?: string
}

const SEGMENT_CLASS = 'max-w-filter-chip-segment min-w-0 truncate'

export function AnalyzeFilterSummaryChip({
  keyboardLabel,
  deviceLabel,
  sourceLabel,
  periodLabel,
  onClick,
  testId = 'analyze-filter-chip',
}: Props) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-1.5 text-xs text-content transition-colors hover:bg-surface-dim focus:border-accent focus:outline-none"
      onClick={onClick}
      title={`${keyboardLabel} · ${deviceLabel} · ${sourceLabel} · ${periodLabel}`}
      data-testid={testId}
    >
      {/* The visible segment text is the accessible name; the sr-only
        * hint appends the action ("edit filter conditions") for
        * assistive tech without an aria-label overriding the labels. */}
      <span className="sr-only">{t('analyze.filters.chipAriaLabel')}</span>
      <Filter size={ICON_SM} className="shrink-0 text-content-muted" aria-hidden="true" />
      <span className={SEGMENT_CLASS} data-testid={`${testId}-keyboard`}>{keyboardLabel}</span>
      <span className="shrink-0 text-content-muted" aria-hidden="true">·</span>
      <span className={SEGMENT_CLASS} data-testid={`${testId}-device`}>{deviceLabel}</span>
      <span className="shrink-0 text-content-muted" aria-hidden="true">·</span>
      <span className={SEGMENT_CLASS} data-testid={`${testId}-source`}>{sourceLabel}</span>
      <span className="shrink-0 text-content-muted" aria-hidden="true">·</span>
      <span className={SEGMENT_CLASS} data-testid={`${testId}-period`}>{periodLabel}</span>
      <ChevronDown size={ICON_XS} className="shrink-0 text-content-muted" aria-hidden="true" />
    </button>
  )
}
