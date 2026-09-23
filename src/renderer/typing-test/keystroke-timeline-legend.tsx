// SPDX-License-Identifier: GPL-2.0-or-later
// Keystroke timeline legend: entry order, the LegendSwatch component, and
// the line/word-mode label and tooltip key lookups.

import { useTranslation } from 'react-i18next'
import { Tooltip } from '../components/ui/Tooltip'
import { TIMELINE_LEGEND, type TimelineFillKind } from './word-timeline-colors'

export const LEGEND_ORDER = Object.keys(TIMELINE_LEGEND) as TimelineFillKind[]

interface LegendSwatchProps {
  colorClass: string
  labelKey: string
  /** When set, the label's parenthetical explanation — hidden
   *  behind a hover/focus tooltip instead of always-visible inline text.
   *  Rendered PLAIN, no visual affordance on the label itself (no
   *  underline, no special cursor) — same idiom every other tooltip
   *  trigger in this codebase uses (ErrorMixSection's type labels,
   *  CoverageBadge, the Missed table's own bar rows (`MissedTable` in
   *  mistake-summary.tsx)): the tooltip showing up on hover/focus IS
   *  the affordance, nothing on the trigger itself hints at it in
   *  advance. */
  tooltipKey?: string
}

export function LegendSwatch({ colorClass, labelKey, tooltipKey }: LegendSwatchProps) {
  const { t } = useTranslation()
  const label = tooltipKey
    ? (
      <Tooltip content={t(tooltipKey)}>
        <span>{t(labelKey)}</span>
      </Tooltip>
    )
    : t(labelKey)
  return (
    <span className="flex items-center gap-1.5 text-2xs text-content-secondary">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${colorClass}`} aria-hidden="true" />
      {label}
    </span>
  )
}

/** The legend's `blank`/`leadIn` entries carry a line-view specific
 *  meaning (250ms cut, "before this line") distinct from the word view's
 *  (1000ms cut, "before this word") — every other legend entry (normal,
 *  mistake, overlap, unjudged) means the same thing in both modes. */
export function lineLegendLabelKey(kind: TimelineFillKind, displayMode: 'line' | 'word'): string {
  if (displayMode === 'line' && kind === 'blank') return 'editor.typingTest.history.timeline.legend.blankLine'
  if (displayMode === 'line' && kind === 'leadIn') return 'editor.typingTest.history.timeline.legend.leadInLine'
  return TIMELINE_LEGEND[kind].labelKey
}

/** Sibling of `lineLegendLabelKey` for the tooltip half of the split —
 *  `blank`'s line-mode variant (`blankLine`) carries a different cutoff
 *  (250ms vs the word view's 1000ms) in its own tooltip text, same as the
 *  label swap above. `leadIn` has no tooltip in either mode (its label
 *  never carried a parenthetical to begin with). */
export function lineLegendTooltipKey(kind: TimelineFillKind, displayMode: 'line' | 'word'): string | undefined {
  if (displayMode === 'line' && kind === 'blank') return 'editor.typingTest.history.timeline.legend.blankLineTooltip'
  return TIMELINE_LEGEND[kind].tooltipKey
}
