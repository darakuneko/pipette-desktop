// SPDX-License-Identifier: GPL-2.0-or-later
// Row-opened detail view for a single run's per-word keystroke timeline
// (see .claude/tasks/backlog/Task-tm-phase5-word-timeline-ui.md). Nests
// inside the History modal (opened from `HistoryTimelineCell`), so its
// own Escape handling must consume the keydown before it can bubble up
// to the History modal's own bubble-phase `useEscapeClose` — this
// mirrors `JsonEditorModal`'s capture-phase + `stopPropagation` handler,
// the established pattern in this codebase for a modal nested inside
// another modal (`useEscapeSwallow` alone would also block THIS view's
// own close, since it swallows unconditionally with no action of its
// own — see its doc comment).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { AnalyzeStatGrid } from '../components/analyze/stat-card'
import type { AnalyzeSummaryItem } from '../components/analyze/analyze-summary-table'
import { TooltipShell, Stat } from '../components/analyze/analyze-tooltip'
import { computeBubblePosition } from '../components/ui/Tooltip'
import { formatDuration, formatPercentLabel, fmtMs } from '../components/analyze/analyze-format'
import { formatWpm } from '../components/analyze/analyze-wpm'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import { useEscapeCloseCapture } from '../hooks/useEscapeClose'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import { buildWordTimeline, buildWordTimelineSummary, type WordTimelineModel, type KeystrokeSegment } from './word-timeline'
import { WordTimelineRow, type HoverTarget } from './word-timeline-row'
import { TIMELINE_LEGEND, type TimelineFillKind } from './word-timeline-colors'

/** Floor for the "fit" zoom level's canvas width — a run with a very
 *  short `maxDisplayMs` (e.g. a single short word) would otherwise
 *  compute a fit width narrower than the modal itself. */
const CANVAS_MIN_WIDTH_PX = 480
/** The zoom slider's max is this many times the fit level — "10x the
 *  whole run visible at once" comfortably reaches individual-keystroke
 *  detail without an unbounded range that makes the slider imprecise. */
const ZOOM_MAX_FACTOR = 10

const LEGEND_ORDER = Object.keys(TIMELINE_LEGEND) as TimelineFillKind[]

interface Props {
  uid: string
  runId: string
  /** The already-displayed History row for this run, when known — reused
   *  for the summary cards so they read identically to the row the user
   *  opened this view from, rather than a second, possibly-divergent
   *  computation over the same run. */
  result?: TypingTestResult
  onClose: () => void
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

export function WordTimelineView({ uid, runId, result, onClose }: Props) {
  const { t } = useTranslation()
  const [log, setLog] = useState<RunKeystrokeLog | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    window.vialAPI.typingRunLogGet(uid, runId)
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) setLog(res.data)
        else setLoadError(true)
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [uid, runId])

  // Nested inside the History modal — consume Escape in the capture
  // phase so History's own bubble-phase useEscapeClose never sees it.
  useEscapeCloseCapture(onClose)

  const model = useMemo<WordTimelineModel | null>(() => (log ? buildWordTimeline(log) : null), [log])
  const summary = useMemo(() => (model ? buildWordTimelineSummary(model) : null), [model])

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [fitPxPerMs, setFitPxPerMs] = useState<number | null>(null)
  // Bumped from the canvas ref callback once the element actually mounts
  // — see the effect below for why this, not just `[model]`, is needed.
  const [canvasMountTick, setCanvasMountTick] = useState(0)
  const setCanvasNode = useCallback((node: HTMLDivElement | null) => {
    canvasRef.current = node
    if (node) setCanvasMountTick((t) => t + 1)
  }, [])

  const applyZoom = useCallback((next: number) => {
    if (!model || !canvasRef.current) return
    canvasRef.current.style.width = `${Math.round(model.maxDisplayMs * next)}px`
  }, [model])

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
    if (!model || model.maxDisplayMs <= 0) return
    const container = containerRef.current
    if (!container) return
    const styles = window.getComputedStyle(container)
    const paddingX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0')
    const width = Math.max(container.clientWidth - paddingX, CANVAS_MIN_WIDTH_PX)
    const fit = width / model.maxDisplayMs
    setFitPxPerMs(fit)
    if (isAtFitRef.current) applyZoom(fit)
  }, [model, applyZoom])

  // Compute the fit level once the model is known AND the canvas has
  // actually mounted. Keying only on `[model]` (the original approach)
  // breaks because `setLog` and `setLoading` flush in separate
  // microtasks: `model` (derived from `log`) can become non-null on a
  // render where `loading` is STILL true, before the JSX gating this
  // section (`!loading && ... && model`) has ever rendered the
  // container/canvas — `containerRef`/`canvasRef` are still null on that
  // render, and the fit falls back to `CANVAS_MIN_WIDTH_PX` regardless of
  // the real container width. Depending on the canvas's own mount
  // (bumped from its ref callback, which fires once loading has actually
  // flipped and the section is in the DOM) instead of just `model`
  // guarantees this runs again once the refs are live.
  useEffect(() => {
    if (!canvasRef.current) return
    computeAndApplyFit()
  }, [canvasMountTick, computeAndApplyFit])

  // Re-fit on window resize (a maximize/restore, or the user dragging the
  // window edge) — the initial-fit effect above only ever runs once per
  // mount/model change, so without this a resize left the canvas at
  // whatever width the ORIGINAL window size computed, either wasting new
  // space or reintroducing the very overflow this fix exists to remove.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !model) return
    const observer = new ResizeObserver(() => computeAndApplyFit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [model, computeAndApplyFit])

  // Live drag: this fires on every tick (React's onChange for a range
  // input maps to the native 'input' event) but only ever touches the
  // DOM directly — no setState, so nothing in the row tree re-renders
  // while dragging (rows are memoized on `word`/`maxDisplayMs`, neither
  // of which this touches).
  const handleZoomInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    isAtFitRef.current = Number(e.target.value) === fitPxPerMs
    applyZoom(Number(e.target.value))
  }, [applyZoom, fitPxPerMs])

  const [hover, setHover] = useState<HoverTarget | null>(null)
  const handleHoverEnd = useCallback(() => setHover(null), [])

  // Tooltip position — measure-then-position, same idiom as
  // `Tooltip.tsx`: read the bubble's own just-rendered size inside a
  // layout effect (runs before paint) so the very first frame the user
  // sees is already the clamped position, never the raw
  // `hover.rect.left/bottom` math (which can render off-screen near the
  // modal's edge at high zoom).
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

  const summaryItems: AnalyzeSummaryItem[] = useMemo(() => {
    if (!summary) return []
    return [
      {
        // `result.wpm` is the run's own WPM (words/min over the whole run,
        // the same figure History's own row shows) — a genuinely
        // different metric from the model-derived `avgPace` (a
        // char-weighted rate over words' own true spans, excluding
        // inter-word time; see WordTimelineSummary.avgPace's doc
        // comment). Distinct label so this card never claims to be
        // "Word Pace" when it's actually showing the run-wide figure.
        labelKey: result
          ? 'editor.typingTest.history.timeline.stats.runWpm'
          : 'editor.typingTest.history.timeline.stats.wordPace',
        value: result ? formatWpm(result.wpm) : (summary.avgPace !== undefined ? formatWpm(summary.avgPace) : EMPTY_STAT_VALUE),
      },
      {
        labelKey: 'editor.typingTest.history.timeline.stats.accuracy',
        value: result
          ? formatPercentLabel(result.accuracy / 100)
          : formatPercentLabel(summary.avgAccuracy !== undefined ? summary.avgAccuracy / 100 : undefined),
      },
      {
        labelKey: 'editor.typingTest.history.timeline.stats.overlap',
        value: formatPercentLabel(summary.avgOverlap),
      },
      {
        labelKey: 'editor.typingTest.history.timeline.stats.duration',
        value: result ? formatDuration(result.durationSeconds) : EMPTY_STAT_VALUE,
      },
    ]
  }, [summary, result])

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="word-timeline-title"
      data-testid="word-timeline-modal"
      // stopPropagation before closing: via the Analyze handoff
      // (HistoryToggle) this view mounts as a DIRECT SIBLING of History's
      // own backdrop div, not nested inside `history-modal` (which stops
      // propagation on its own click handler) — without this, a backdrop
      // click here would bubble up and close History too. The row-opened
      // path (HistoryTimelineCell) never observed this bug only because
      // it happens to nest inside `history-modal`'s own stop, not because
      // this component was doing the right thing itself.
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <div
        className="flex h-modal-80vh w-modal-wide max-w-modal-vw flex-col rounded-2xl border border-edge bg-surface-alt p-6 shadow-xl"
        data-testid="word-timeline-content"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id="word-timeline-title" className="text-lg font-semibold">
            {t('editor.typingTest.history.timeline.modalTitle')}
          </h3>
          <ModalCloseButton testid="word-timeline-close" onClick={onClose} />
        </div>

        {loading && (
          <p className="text-sm text-content-muted" data-testid="word-timeline-loading">
            {t('editor.typingTest.history.timeline.loading')}
          </p>
        )}
        {!loading && loadError && (
          <p className="text-sm text-danger" data-testid="word-timeline-error">
            {t('editor.typingTest.history.timeline.error')}
          </p>
        )}

        {!loading && !loadError && model && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Deliberate exception to the Analyze chart-above-stats rule
                (.claude/tasks/backlog/Task-analyze-section-layout-consistency.md):
                this grid is the modal's summary header, not a chart-adjacent
                stat row — it must sit above the legend/zoom controls and the
                canvas, all of which the user reads top-to-bottom before ever
                reaching the scrollable, flex-grow canvas below. */}
            <AnalyzeStatGrid items={summaryItems} ariaLabelKey="editor.typingTest.history.timeline.modalTitle" />

            {model.charCorrelationUnavailable && (
              <p className="text-2xs text-warning" data-testid="word-timeline-correlation-note">
                {t('editor.typingTest.history.timeline.correlationUnreliable')}
              </p>
            )}

            {/* Legend — color alone never carries meaning elsewhere in
                this view (tooltips spell everything out too), but this
                is the at-a-glance key. */}
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface px-3 py-1.5">
              {LEGEND_ORDER.map((kind) => (
                <LegendSwatch key={kind} colorClass={TIMELINE_LEGEND[kind].swatchClass} labelKey={TIMELINE_LEGEND[kind].labelKey} />
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
                {model.words.map((word) => (
                  <WordTimelineRow
                    key={word.index}
                    word={word}
                    maxDisplayMs={model.maxDisplayMs}
                    onHover={setHover}
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
                    ? keystrokeTooltipBody(hover.word.display, hover.segment, t)
                    : (
                      <TooltipShell>
                        <Stat
                          label={hover.segment.kind === 'blank'
                            ? t('editor.typingTest.history.timeline.legend.blank')
                            : t('editor.typingTest.history.timeline.legend.leadIn')}
                          value={t(
                            hover.segment.kind === 'blank'
                              ? 'editor.typingTest.history.timeline.tooltip.blankDuration'
                              : 'editor.typingTest.history.timeline.tooltip.leadInDuration',
                            { ms: Math.round(hover.segment.trueDurationMs) },
                          )}
                        />
                      </TooltipShell>
                    )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
