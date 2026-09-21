// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { TooltipShell, Stat } from '../components/analyze/analyze-tooltip'
import { Tooltip } from '../components/ui/Tooltip'
import { fmtMs } from '../components/analyze/analyze-format'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { KeystrokeSegment } from './word-timeline'
import { TIMELINE_LEGEND, type TimelineFillKind } from './word-timeline-colors'

/** Floor for the "fit" zoom level's canvas width — a run with a very
 *  short `maxDisplayMs` (e.g. a single short word) would otherwise
 *  compute a fit width narrower than the panel itself. */
export const CANVAS_MIN_WIDTH_PX = 480
/** The zoom slider's max is this many times the fit level — "10x the
 *  whole run visible at once" comfortably reaches individual-keystroke
 *  detail without an unbounded range that makes the slider imprecise. */
export const ZOOM_MAX_FACTOR = 10

export const LEGEND_ORDER = Object.keys(TIMELINE_LEGEND) as TimelineFillKind[]

export interface Props {
  log: RunKeystrokeLog
  /** The already-displayed History row for this run, when known — reused
   *  for the unified stat block so it reads identically to the row the
   *  user opened this view from, rather than a second, possibly-divergent
   *  computation over the same run. */
  result?: TypingTestResult
}

interface LegendSwatchProps {
  colorClass: string
  labelKey: string
  /** When set, the label's former parenthetical explanation — hidden
   *  behind a hover/focus tooltip instead of always-visible inline text.
   *  Rendered PLAIN, no visual affordance on the label itself (no
   *  underline, no special cursor) — same idiom every other tooltip
   *  trigger in this codebase uses (ErrorMixSection's type labels,
   *  CoverageBadge, the Missed table's own bar rows below): the tooltip
   *  showing up on hover/focus IS the affordance, nothing on the trigger
   *  itself hints at it in advance. */
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

/** Collapses a `boolean | undefined` tri-state into one of three i18n
 *  keys — shared shape for "correctness" and "overlap", which were
 *  previously two structurally identical nested ternaries. */
function triLabel(
  value: boolean | undefined,
  yesKey: string,
  noKey: string,
  unknownKey: string,
  t: (key: string) => string,
): string {
  if (value === true) return t(yesKey)
  if (value === false) return t(noKey)
  return t(unknownKey)
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

export function keystrokeTooltipBody(word: string, seg: KeystrokeSegment, t: (key: string, opts?: Record<string, unknown>) => string) {
  const correctnessText = triLabel(
    seg.correct,
    'editor.typingTest.history.timeline.tooltip.correct',
    'editor.typingTest.history.timeline.tooltip.mistake',
    'editor.typingTest.history.timeline.tooltip.unjudged',
    t,
  )
  const overlapText = triLabel(
    seg.overlapped,
    'editor.typingTest.history.timeline.tooltip.overlapYes',
    'editor.typingTest.history.timeline.tooltip.overlapNo',
    'editor.typingTest.history.timeline.tooltip.overlapUnknown',
    t,
  )
  const durationText = seg.openEnded
    ? t('editor.typingTest.history.timeline.tooltip.releaseUnobserved')
    : fmtMs(seg.endMs - seg.startMs)

  return (
    <TooltipShell header={`${word} · ${t('editor.typingTest.history.timeline.tooltip.offset', { ms: Math.round(seg.trueStartMs) })}`}>
      <Stat label={seg.label || EMPTY_STAT_VALUE} value={durationText} />
      <Stat label={t('editor.typingTest.history.timeline.stats.accuracy')} value={correctnessText} />
      <Stat label={t('editor.typingTest.history.timeline.stats.overlap')} value={overlapText} />
    </TooltipShell>
  )
}
