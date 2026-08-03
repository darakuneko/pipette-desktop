// SPDX-License-Identifier: GPL-2.0-or-later
// Content of the per-run keystroke timeline — unified stat block, legend,
// zoom slider, and the line/word rows with their hover tooltip. Extracted
// out of `WordTimelineView` (see .claude/plans/Plan-completion-timeline-view.md
// PR-A spec point 1) so a later PR can render the identical content
// inline on the typing-test completion screen, not only inside the
// History modal. Deliberately has NO modal-specific assumptions: the
// zoom's DOM-width-write invariant and the horizontal-scroll `overflow-auto`
// wrapper both key off this component's own container width via
// `ResizeObserver`, which works the same whether that container is a
// modal panel or an inline block on another screen.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnalyzeStatGrid } from '../components/analyze/stat-card'
import { TooltipShell, Stat } from '../components/analyze/analyze-tooltip'
import { computeBubblePosition } from '../components/ui/Tooltip'
import { fmtMs } from '../components/analyze/analyze-format'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { KeystrokeSegment } from './word-timeline'
import { WordTimelineRow, type HoverTarget } from './word-timeline-row'
import { LineTimelineRow, type LineHoverTarget } from './LineTimelineRow'
import { TIMELINE_LEGEND, type TimelineFillKind } from './word-timeline-colors'
import { useTimelineModel } from './use-timeline-model'
import { buildTimelineStatItems } from './keystroke-timeline-stats'
import { MissedCharsList, ErrorClassLine, type ErrorClassCounts } from './mistake-summary'

/** Floor for the "fit" zoom level's canvas width — a run with a very
 *  short `maxDisplayMs` (e.g. a single short word) would otherwise
 *  compute a fit width narrower than the panel itself. */
const CANVAS_MIN_WIDTH_PX = 480
/** The zoom slider's max is this many times the fit level — "10x the
 *  whole run visible at once" comfortably reaches individual-keystroke
 *  detail without an unbounded range that makes the slider imprecise. */
const ZOOM_MAX_FACTOR = 10

const LEGEND_ORDER = Object.keys(TIMELINE_LEGEND) as TimelineFillKind[]

interface Props {
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
}

function LegendSwatch({ colorClass, labelKey }: LegendSwatchProps) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-1.5 text-2xs text-content-secondary">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${colorClass}`} aria-hidden="true" />
      {t(labelKey)}
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
function lineLegendLabelKey(kind: TimelineFillKind, displayMode: 'line' | 'word'): string {
  if (displayMode === 'line' && kind === 'blank') return 'editor.typingTest.history.timeline.legend.blankLine'
  if (displayMode === 'line' && kind === 'leadIn') return 'editor.typingTest.history.timeline.legend.leadInLine'
  return TIMELINE_LEGEND[kind].labelKey
}

function keystrokeTooltipBody(word: string, seg: KeystrokeSegment, t: (key: string, opts?: Record<string, unknown>) => string) {
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

export function KeystrokeTimelinePanel({ log, result }: Props) {
  const { t } = useTranslation()
  const { displayMode, wordModel, lineModel, summary, activeMaxDisplayMs, activeCharCorrelationUnavailable } = useTimelineModel(log)

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [fitPxPerMs, setFitPxPerMs] = useState<number | null>(null)
  // Bumped from the canvas ref callback once the element actually mounts
  // — see the effect below for why this, not just `[displayMode]`, is
  // needed.
  const [canvasMountTick, setCanvasMountTick] = useState(0)
  const setCanvasNode = useCallback((node: HTMLDivElement | null) => {
    canvasRef.current = node
    if (node) setCanvasMountTick((t) => t + 1)
  }, [])

  const applyZoom = useCallback((next: number) => {
    if (!displayMode || !canvasRef.current) return
    canvasRef.current.style.width = `${Math.round(activeMaxDisplayMs * next)}px`
  }, [displayMode, activeMaxDisplayMs])

  // Whether the canvas is still at the "fit whole run in view" width —
  // true from mount until the user first drags the slider away from it
  // (see `handleZoomInput`). Read by the resize-driven recompute below so
  // a window resize only ever re-applies a new fit width automatically
  // while the user hasn't already chosen a different zoom level; once
  // they have, a resize still refreshes `fitPxPerMs` (so the slider's own
  // `min` stays accurate) without silently yanking their chosen zoom.
  const isAtFitRef = useRef(true)

  // Recompute the "fit whole run in view" zoom level from the
  // container's actual available width — subtracting its own horizontal
  // padding (`getComputedStyle`, not a hardcoded pixel guess) since the
  // canvas renders as a direct, unpadded child: using the container's
  // raw `clientWidth` (which INCLUDES its own padding) sized the canvas
  // 16px too wide, so the container always showed a horizontal
  // scrollbar even for a run that fit. Falls back to `CANVAS_MIN_WIDTH_PX`
  // when the resulting width would be narrower than that floor (a run
  // with very little content, or — in tests — jsdom's `clientWidth`
  // always reading 0 since it never implements layout).
  const computeAndApplyFit = useCallback(() => {
    if (!displayMode || activeMaxDisplayMs <= 0) return
    const container = containerRef.current
    if (!container) return
    const styles = window.getComputedStyle(container)
    const paddingX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0')
    const width = Math.max(container.clientWidth - paddingX, CANVAS_MIN_WIDTH_PX)
    const fit = width / activeMaxDisplayMs
    setFitPxPerMs(fit)
    if (isAtFitRef.current) applyZoom(fit)
  }, [displayMode, activeMaxDisplayMs, applyZoom])

  // Compute the fit level once the model is known AND the canvas has
  // actually mounted. Keying only on `[displayMode]` (the original
  // approach) breaks because the log/model can resolve on a render where
  // the section gating the canvas hasn't yet painted it — `containerRef`/
  // `canvasRef` are still null on that render, and the fit falls back to
  // `CANVAS_MIN_WIDTH_PX` regardless of the real container width.
  // Depending on the canvas's own mount (bumped from its ref callback)
  // instead of just `displayMode` guarantees this runs again once the
  // refs are live.
  useEffect(() => {
    if (!canvasRef.current) return
    computeAndApplyFit()
  }, [canvasMountTick, computeAndApplyFit])

  // Re-fit on container resize (a maximize/restore, or the user dragging
  // the window edge) — the initial-fit effect above only ever runs once
  // per mount/model change, so without this a resize left the canvas at
  // whatever width the ORIGINAL size computed, either wasting new space
  // or reintroducing the very overflow this fix exists to remove.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !displayMode) return
    const observer = new ResizeObserver(() => computeAndApplyFit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [displayMode, computeAndApplyFit])

  // Live drag: this fires on every tick (React's onChange for a range
  // input maps to the native 'input' event) but only ever touches the
  // DOM directly — no setState, so nothing in the row tree re-renders
  // while dragging (rows are memoized on `word`/`maxDisplayMs`, neither
  // of which this touches).
  const handleZoomInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    isAtFitRef.current = Number(e.target.value) === fitPxPerMs
    applyZoom(Number(e.target.value))
  }, [applyZoom, fitPxPerMs])

  // Discriminated union: word rows report a `WordTimelineWord`, line rows
  // report the line's own joined text — the two modes are mutually
  // exclusive (see `displayMode`), so only one branch is ever set, but
  // both need distinct handlers to stay type-safe without threading a
  // `word.display`-shaped fake through the line path.
  type Hover = ({ kind: 'word' } & HoverTarget) | ({ kind: 'line' } & LineHoverTarget)
  const [hover, setHover] = useState<Hover | null>(null)
  const handleWordHover = useCallback((t: HoverTarget) => setHover({ kind: 'word', ...t }), [])
  const handleLineHover = useCallback((t: LineHoverTarget) => setHover({ kind: 'line', ...t }), [])
  const handleHoverEnd = useCallback(() => setHover(null), [])

  // Tooltip position — measure-then-position, same idiom as
  // `Tooltip.tsx`: read the bubble's own just-rendered size inside a
  // layout effect (runs before paint) so the very first frame the user
  // sees is already the clamped position, never the raw
  // `hover.rect.left/bottom` math (which can render off-screen near the
  // container's edge at high zoom).
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!hover || !tooltipRef.current) { setTooltipPos(null); return }
    setTooltipPos(computeBubblePosition(
      hover.rect,
      tooltipRef.current.getBoundingClientRect(),
      'bottom',
      'start',
      6,
      { width: window.innerWidth, height: window.innerHeight },
    ))
  }, [hover])

  const summaryItems = useMemo(() => buildTimelineStatItems(result, summary, log), [result, summary, log])

  // Both-or-neither, mirroring `TypingTestResult.errorSubstitutions`
  // et al.'s own storage contract — a result saved before error-class
  // tracking existed (or a romaji/no-finalized-word run) has none of the
  // three fields, and this reads that as "omit the line entirely" rather
  // than fabricating a partial breakdown.
  const errorClasses: ErrorClassCounts | null = result
    && result.errorSubstitutions !== undefined
    && result.errorOmissions !== undefined
    && result.errorInsertions !== undefined
    ? { substitutions: result.errorSubstitutions, omissions: result.errorOmissions, insertions: result.errorInsertions }
    : null

  if (!displayMode) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Deliberate exception to the Analyze chart-above-stats rule
          (.claude/tasks/backlog/Task-analyze-section-layout-consistency.md):
          this grid is the panel's summary header, not a chart-adjacent
          stat row — it must sit above the legend/zoom controls and the
          canvas, all of which the user reads top-to-bottom before ever
          reaching the scrollable, flex-grow canvas below. */}
      <AnalyzeStatGrid items={summaryItems} ariaLabelKey="editor.typingTest.history.timeline.modalTitle" />

      {/* Missed characters / error-mix — result-only (see the module doc
          comment): reconstructing either from the raw log would re-derive
          scoring rules run-state.ts already owns. Both components render
          nothing when their data is absent/empty, same convention the
          completion screen (`TypingTestStatsRow`) already follows. */}
      <MissedCharsList mistakes={result?.mistakes ?? {}} />
      {errorClasses && <ErrorClassLine errorClasses={errorClasses} />}

      {activeCharCorrelationUnavailable && (
        <p className="text-2xs text-warning" data-testid="word-timeline-correlation-note">
          {t('editor.typingTest.history.timeline.correlationUnreliable')}
        </p>
      )}

      {/* Legend — color alone never carries meaning elsewhere in
          this view (tooltips spell everything out too), but this
          is the at-a-glance key. Line-mode overrides the blank/
          lead-in wording to the line-view's own meaning (a 250ms
          cut and "before this line", not the word view's 1000ms /
          "before this word") — every other entry, and the word
          view's own wording, stays unchanged. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface px-3 py-1.5">
        {LEGEND_ORDER.map((kind) => (
          <LegendSwatch key={kind} colorClass={TIMELINE_LEGEND[kind].swatchClass} labelKey={lineLegendLabelKey(kind, displayMode)} />
        ))}
      </div>
      <p className="text-2xs text-content-muted">{t('editor.typingTest.history.timeline.legend.correctedNote')}</p>
      <p className="text-2xs text-content-muted">{t('editor.typingTest.history.timeline.axisNote')}</p>

      {/* Zoom — same row shape as RGBConfigurator's brightness
          slider (the only existing range-input precedent). The
          slider only mounts once `fitPxPerMs` is known, so its
          (uncontrolled) `defaultValue` is always correct at
          first paint — no remount-on-resolve hack needed. The
          WHOLE row (including its label) is gated on `fitPxPerMs`,
          not just the input — a log with zero drawable content
          (`maxDisplayMs <= 0`) never computes a fit level, and an
          orphan "Zoom" label with no control under it read as
          broken rather than as "nothing to zoom". */}
      {fitPxPerMs !== null && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-content-secondary">{t('editor.typingTest.history.timeline.zoom.label')}</label>
          <input
            type="range"
            data-testid="word-timeline-zoom"
            aria-label={t('editor.typingTest.history.timeline.zoom.aria')}
            min={fitPxPerMs}
            max={fitPxPerMs * ZOOM_MAX_FACTOR}
            step={fitPxPerMs / 20}
            defaultValue={fitPxPerMs}
            onChange={handleZoomInput}
            className="flex-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
      )}

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-surface p-2">
        <div ref={setCanvasNode} data-testid="word-timeline-canvas" className="flex flex-col gap-2">
          {displayMode === 'line' && lineModel
            ? lineModel.lines.map((line) => (
              <LineTimelineRow
                key={line.lineIndex}
                line={line}
                maxDisplayMs={lineModel.maxDisplayMs}
                romajiInput={log.romajiInput === true}
                onHover={handleLineHover}
                onHoverEnd={handleHoverEnd}
              />
            ))
            : wordModel?.words.map((word) => (
              <WordTimelineRow
                key={word.index}
                word={word}
                maxDisplayMs={wordModel.maxDisplayMs}
                onHover={handleWordHover}
                onHoverEnd={handleHoverEnd}
              />
            ))}
        </div>

        {hover && (
          <div
            ref={tooltipRef}
            className="pointer-events-none fixed z-70"
            style={{ left: tooltipPos?.left ?? hover.rect.left, top: tooltipPos?.top ?? hover.rect.bottom + 6 }}
            data-testid="word-timeline-tooltip"
          >
            {hover.segment.kind === 'keystroke'
              ? keystrokeTooltipBody(hover.kind === 'word' ? hover.word.display : hover.lineText, hover.segment, t)
              : (
                <TooltipShell>
                  <Stat
                    label={t(lineLegendLabelKey(hover.segment.kind === 'blank' ? 'blank' : 'leadIn', hover.kind === 'line' ? 'line' : 'word'))}
                    value={t(
                      hover.segment.kind === 'blank'
                        ? 'editor.typingTest.history.timeline.tooltip.blankDuration'
                        : (hover.kind === 'line'
                          ? 'editor.typingTest.history.timeline.tooltip.leadInLineDuration'
                          : 'editor.typingTest.history.timeline.tooltip.leadInDuration'),
                      { ms: Math.round(hover.segment.trueDurationMs) },
                    )}
                  />
                </TooltipShell>
              )}
          </div>
        )}
      </div>
    </div>
  )
}
