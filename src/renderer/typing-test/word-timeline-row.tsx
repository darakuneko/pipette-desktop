// SPDX-License-Identifier: GPL-2.0-or-later
// One word's row inside WordTimelineView: a plain-HTML header (word text
// + per-word stats + partial badge) and a single SVG strip. The SVG
// deliberately has ZERO text elements — every label lives in the header
// or the shared hover tooltip — so zoom (a non-uniform width-only scale
// via `preserveAspectRatio="none"`) never distorts a glyph and no new
// fill ever needs a `FILL_INVERT_TABLE` entry.

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { WordTimelineWord, WordTimelineSegment } from './word-timeline'
import { fillForKeystroke, TIMELINE_FILL } from './word-timeline-colors'
import { formatWpm } from '../components/analyze/analyze-wpm'
import { formatPercentLabel, fmtMs } from '../components/analyze/analyze-format'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'

/** Pixel height of one lane, and (numerically, since `preserveAspectRatio`
 * is "none" with a matching viewBox height) also its SVG user-space unit
 * — a word's row height is simply `laneCount * LANE_UNIT_PX`. */
export const LANE_UNIT_PX = 18
const BAR_INSET_PX = 2

export interface HoverTarget {
  word: WordTimelineWord
  segment: WordTimelineSegment
  rect: DOMRect
}

interface Props {
  word: WordTimelineWord
  maxDisplayMs: number
  onHover: (target: HoverTarget) => void
  onHoverEnd: () => void
}

function WordTimelineRowInner({ word, maxDisplayMs, onHover, onHoverEnd }: Props) {
  const { t } = useTranslation()
  const rowHeight = Math.max(word.laneCount, 1) * LANE_UNIT_PX
  const { stats } = word

  const statParts: string[] = []
  if (stats.wordPace !== undefined) statParts.push(`${t('editor.typingTest.history.timeline.stats.wordPace')} ${formatWpm(stats.wordPace)}`)
  if (stats.accuracy !== undefined) statParts.push(`${t('editor.typingTest.history.timeline.stats.accuracy')} ${formatPercentLabel(stats.accuracy / 100)}`)
  if (stats.overlapRate !== undefined) statParts.push(`${t('editor.typingTest.history.timeline.stats.overlap')} ${formatPercentLabel(stats.overlapRate)}`)
  statParts.push(`${t('editor.typingTest.history.timeline.stats.duration')} ${fmtMs(stats.durationMs)}`)

  return (
    <div className="flex flex-col gap-0.5" data-testid={`word-timeline-row-${word.index}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-content">{word.display || EMPTY_STAT_VALUE}</span>
        {word.partial && (
          <span className="rounded bg-warning/20 px-1 text-2xs font-semibold text-warning">
            {t('editor.typingTest.history.timeline.partialBadge')}
          </span>
        )}
        <span className="text-2xs text-content-muted">{statParts.join(' · ')}</span>
      </div>
      <svg
        width="100%"
        height={rowHeight}
        viewBox={`0 0 ${Math.max(maxDisplayMs, 1)} ${rowHeight}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        data-testid={`word-timeline-svg-${word.index}`}
      >
        {word.segments.map((seg, i) => {
          if (seg.kind === 'keystroke') {
            return (
              <rect
                key={i}
                data-testid="word-timeline-keystroke"
                x={seg.startMs}
                y={seg.lane * LANE_UNIT_PX + BAR_INSET_PX}
                width={Math.max(seg.endMs - seg.startMs, 1)}
                height={LANE_UNIT_PX - BAR_INSET_PX * 2}
                fill={fillForKeystroke(seg)}
                onMouseEnter={(e) => onHover({ word, segment: seg, rect: e.currentTarget.getBoundingClientRect() })}
                onMouseLeave={onHoverEnd}
              />
            )
          }
          if (seg.kind === 'blank') {
            return (
              <rect
                key={i}
                data-testid="word-timeline-blank"
                x={seg.startMs}
                y={0}
                width={Math.max(seg.endMs - seg.startMs, 1)}
                height={rowHeight}
                fill={TIMELINE_FILL.blank}
                fillOpacity={0.18}
                onMouseEnter={(e) => onHover({ word, segment: seg, rect: e.currentTarget.getBoundingClientRect() })}
                onMouseLeave={onHoverEnd}
              />
            )
          }
          // leadInPause — always at the row's own start.
          return (
            <rect
              key={i}
              data-testid="word-timeline-lead-in"
              x={seg.startMs}
              y={0}
              width={Math.max(seg.endMs - seg.startMs, 1)}
              height={rowHeight}
              fill={TIMELINE_FILL.leadIn}
              fillOpacity={0.28}
              onMouseEnter={(e) => onHover({ word, segment: seg, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={onHoverEnd}
            />
          )
        })}
      </svg>
    </div>
  )
}

// Rows only ever depend on their own word + the shared axis width — never
// on zoom (a direct `style.width` write on the shared canvas ancestor,
// see WordTimelineView's `applyZoom`, not a re-render-triggering prop) —
// so memoizing here means dragging the zoom slider re-renders nothing
// under this component at all.
export const WordTimelineRow = memo(WordTimelineRowInner)
