// SPDX-License-Identifier: GPL-2.0-or-later
// One line's row inside WordTimelineView's line-view mode: a plain-HTML
// header (index badge + line text + optional romaji reading + per-line
// stats) and a single SVG strip — same shape as `word-timeline-row.tsx`'s
// per-word row, just built from `LineTimelineLine` instead of
// `WordTimelineWord`. The SVG deliberately has ZERO text elements, same
// precedent as the word row (see that file's own doc comment) — word
// labels live in the header, word BOUNDARIES render as subtle dividers
// (`WORD_SEPARATOR_FILL`), never as in-SVG text.

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { LineTimelineLine } from './line-timeline'
import type { WordTimelineSegment } from './word-timeline'
import { fillForKeystroke, TIMELINE_FILL, WORD_SEPARATOR_FILL } from './word-timeline-colors'
import { formatPercentLabel } from '../components/analyze/analyze-format'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import { LANE_UNIT_PX } from './word-timeline-row'

const BAR_INSET_PX = 2

/** Per-line duration render — seconds with one decimal (matches the
 *  mockup's "10.4秒"), deliberately NOT `analyze-format`'s
 *  `formatDuration`: that's an mm:ss formatter built for the whole-run
 *  INTEGER `TypingTestResult.durationSeconds` the word view's summary
 *  card feeds it — `seconds % 60` with no rounding, so a line's
 *  fractional true span (typically single-digit seconds) produced
 *  garbage like "0:8.73". `LineTimelineStats.durationSeconds` is never
 *  undefined (unlike `kpm`/`accuracy`/`overlapRate`, which mean "nothing
 *  to show" when absent), so this always renders a real value — "0.0"
 *  for a line with zero measurable span, never `EMPTY_STAT_VALUE`. */
function formatLineDurationSeconds(seconds: number): string {
  return seconds.toFixed(1)
}

export interface LineHoverTarget {
  /** The line's own joined display text — reused as the tooltip header,
   *  same role `HoverTarget.word.display` plays in the per-word row (see
   *  `word-timeline-row.tsx`). */
  lineText: string
  segment: WordTimelineSegment
  rect: DOMRect
}

interface Props {
  line: LineTimelineLine
  maxDisplayMs: number
  /** `RunKeystrokeLog.romajiInput` — shows a second, monospace romaji
   *  row (joined `typed` text) under the line text when true. */
  romajiInput: boolean
  onHover: (target: LineHoverTarget) => void
  onHoverEnd: () => void
}

function LineTimelineRowInner({ line, maxDisplayMs, romajiInput, onHover, onHoverEnd }: Props) {
  const { t } = useTranslation()
  const rowHeight = Math.max(line.laneCount, 1) * LANE_UNIT_PX
  const { stats } = line

  const lineText = line.words.map((w) => w.display).join(' ')
  const romajiText = romajiInput ? line.words.map((w) => w.typed).join(' ') : null

  const statParts: string[] = []
  // Integer, unlike the word view's one-decimal `wordPace` — matches the
  // mockup's "144kpm" (a keystroke COUNT rate, where a fractional digit
  // reads as false precision).
  if (stats.kpm !== undefined) statParts.push(`${t('editor.typingTest.history.timeline.stats.kpm')} ${Math.round(stats.kpm)}`)
  if (stats.accuracy !== undefined) statParts.push(`${t('editor.typingTest.history.timeline.stats.accuracy')} ${formatPercentLabel(stats.accuracy / 100)}`)
  if (stats.overlapRate !== undefined) statParts.push(`${t('editor.typingTest.history.timeline.stats.overlap')} ${formatPercentLabel(stats.overlapRate)}`)
  // No separate "Duration" label — the mockup shows the bare
  // seconds+unit ("10.4秒"), so the whole fragment comes from one
  // interpolated key rather than a label + formatted-value pair like the
  // stats above.
  statParts.push(t('editor.typingTest.history.timeline.stats.durationSeconds', { s: formatLineDurationSeconds(stats.durationSeconds) }))

  const handleSegHover = (seg: WordTimelineSegment) => (e: React.MouseEvent<SVGRectElement>) =>
    onHover({ lineText, segment: seg, rect: e.currentTarget.getBoundingClientRect() })

  return (
    <div className="flex flex-col gap-0.5" data-testid={`line-timeline-row-${line.lineIndex}`}>
      <div className="flex items-baseline gap-2">
        <span
          className="rounded-full bg-surface-dim px-1.5 text-2xs font-semibold text-content-secondary"
          aria-label={t('editor.typingTest.history.timeline.line.indexAria', { n: line.lineIndex + 1 })}
        >
          {line.lineIndex + 1}
        </span>
        <span className="font-mono text-xs text-content">{lineText || EMPTY_STAT_VALUE}</span>
        <span className="text-2xs text-content-muted">{statParts.join(' · ')}</span>
      </div>
      {romajiText !== null && (
        <span
          className="font-mono text-2xs text-content-muted"
          aria-label={t('editor.typingTest.history.timeline.line.romajiAria', { text: romajiText })}
        >
          {romajiText || EMPTY_STAT_VALUE}
        </span>
      )}
      <svg
        width="100%"
        height={rowHeight}
        viewBox={`0 0 ${Math.max(maxDisplayMs, 1)} ${rowHeight}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        data-testid={`line-timeline-svg-${line.lineIndex}`}
      >
        {line.segments.map((seg, i) => {
          if (seg.kind === 'keystroke') {
            return (
              <rect
                key={i}
                data-testid="line-timeline-keystroke"
                x={seg.startMs}
                y={seg.lane * LANE_UNIT_PX + BAR_INSET_PX}
                width={Math.max(seg.endMs - seg.startMs, 1)}
                height={LANE_UNIT_PX - BAR_INSET_PX * 2}
                fill={fillForKeystroke(seg)}
                onMouseEnter={handleSegHover(seg)}
                onMouseLeave={onHoverEnd}
              />
            )
          }
          if (seg.kind === 'blank') {
            return (
              <rect
                key={i}
                data-testid="line-timeline-blank"
                x={seg.startMs}
                y={0}
                width={Math.max(seg.endMs - seg.startMs, 1)}
                height={rowHeight}
                fill={TIMELINE_FILL.blank}
                fillOpacity={0.18}
                onMouseEnter={handleSegHover(seg)}
                onMouseLeave={onHoverEnd}
              />
            )
          }
          // leadInPause — always at the row's own start (a line-crossing
          // pause, never a mid-line one — see `line-timeline.ts`'s
          // `buildLine`).
          return (
            <rect
              key={i}
              data-testid="line-timeline-lead-in"
              x={seg.startMs}
              y={0}
              width={Math.max(seg.endMs - seg.startMs, 1)}
              height={rowHeight}
              fill={TIMELINE_FILL.leadIn}
              fillOpacity={0.28}
              onMouseEnter={handleSegHover(seg)}
              onMouseLeave={onHoverEnd}
            />
          )
        })}
        {/* Word-boundary separators — subtle vertical dividers, never
            text (see the module doc comment). Skips the line's own
            start (index 0 always begins at startMs 0, which needs no
            divider from "nothing"). */}
        {line.words.slice(1).map((w) => (
          <rect
            key={`sep-${w.index}`}
            data-testid="line-timeline-separator"
            x={Math.max(w.startMs - 0.5, 0)}
            y={0}
            width={1}
            height={rowHeight}
            fill={WORD_SEPARATOR_FILL}
          />
        ))}
      </svg>
    </div>
  )
}

// Same memo rationale as `WordTimelineRow` — rows depend only on their
// own line + the shared axis width, never on zoom (a direct DOM
// `style.width` write on the shared canvas ancestor).
export const LineTimelineRow = memo(LineTimelineRowInner)
