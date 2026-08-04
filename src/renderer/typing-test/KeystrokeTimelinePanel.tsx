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
import { Info } from 'lucide-react'
import { AnalyzeStatGrid } from '../components/analyze/stat-card'
import { TooltipShell, Stat } from '../components/analyze/analyze-tooltip'
import { Tooltip, computeBubblePosition } from '../components/ui/Tooltip'
import { fmtMs } from '../components/analyze/analyze-format'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import { ICON_SM } from '../constants/ui-tokens'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { KeystrokeSegment } from './word-timeline'
import { WordTimelineRow, type HoverTarget } from './word-timeline-row'
import { LineTimelineRow, type LineHoverTarget } from './LineTimelineRow'
import { TIMELINE_LEGEND, type TimelineFillKind } from './word-timeline-colors'
import { useTimelineModel } from './use-timeline-model'
import { buildTimelineStatItems } from './keystroke-timeline-stats'
import { MissedTable } from './mistake-summary'
import { buildMissedDetails } from './missed-details'

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

function LegendSwatch({ colorClass, labelKey, tooltipKey }: LegendSwatchProps) {
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
function lineLegendLabelKey(kind: TimelineFillKind, displayMode: 'line' | 'word'): string {
  if (displayMode === 'line' && kind === 'blank') return 'editor.typingTest.history.timeline.legend.blankLine'
  if (displayMode === 'line' && kind === 'leadIn') return 'editor.typingTest.history.timeline.legend.leadInLine'
  return TIMELINE_LEGEND[kind].labelKey
}

/** Sibling of `lineLegendLabelKey` for the tooltip half of the split —
 *  `blank`'s line-mode variant (`blankLine`) carries a different cutoff
 *  (250ms vs the word view's 1000ms) in its own tooltip text, same as the
 *  label swap above. `leadIn` has no tooltip in either mode (its label
 *  never carried a parenthetical to begin with). */
function lineLegendTooltipKey(kind: TimelineFillKind, displayMode: 'line' | 'word'): string | undefined {
  if (displayMode === 'line' && kind === 'blank') return 'editor.typingTest.history.timeline.legend.blankLineTooltip'
  return TIMELINE_LEGEND[kind].tooltipKey
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

  // Substitution/Omission/Insertion now render as three more stat cards in
  // `summaryItems` (see keystroke-timeline-stats.ts), not as their own
  // line below — see the module's own doc comment for the fallback rule.
  const summaryItems = useMemo(() => buildTimelineStatItems(result, summary, log), [result, summary, log])
  // Per-key detail for the Missed table below — derived from this run's
  // own raw log (see buildMissedDetails's own doc comment for why this is
  // computed at input time, not by replaying the log after the fact).
  const missedDetails = useMemo(() => buildMissedDetails(log), [log])
  // Gates the Missed section's own bordered wrapper below — `MissedTable`
  // itself renders nothing when there are no mistakes (see its own doc
  // comment), but a wrapper `div` around it would still paint an empty
  // bordered box if left unconditional. Mirrors `MissedTable`'s own
  // `entries.length === 0` check without duplicating its sort.
  const hasMistakes = Object.keys(result?.mistakes ?? {}).length > 0

  // The legend's info icon tooltip content — both former standalone note
  // paragraphs (corrected-mistake markers, compressed-pause axis), joined
  // with a newline so BUBBLE_BASE's `whitespace-pre-line` renders them as
  // two lines rather than one run-on sentence.
  const legendNotes = `${t('editor.typingTest.history.timeline.legend.correctedNote')}\n${t('editor.typingTest.history.timeline.axisNote')}`

  if (!displayMode) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Correctness-markers-unreliable warning — sits at the VERY TOP of
          the panel (above the stat-card grid, coordinator-requested layout
          tweak from a real-device screenshot review), since it qualifies
          EVERY figure below it (the stat cards' own correctness-derived
          values, and the timeline's own mistake/overlap markers), not just
          the timeline box specifically. */}
      {activeCharCorrelationUnavailable && (
        <p className="text-2xs text-warning" data-testid="word-timeline-correlation-note">
          {t('editor.typingTest.history.timeline.correlationUnreliable')}
        </p>
      )}

      {/* Deliberate exception to the Analyze chart-above-stats rule
          (.claude/tasks/backlog/Task-analyze-section-layout-consistency.md):
          this grid is the panel's summary header, not a chart-adjacent
          stat row — it must sit above the legend/zoom controls and the
          canvas, all of which the user reads top-to-bottom before ever
          reaching the scrollable, flex-grow canvas below. */}
      <AnalyzeStatGrid items={summaryItems} ariaLabelKey="editor.typingTest.history.timeline.modalTitle" />

      {/* Single bordered box: Title, Zoom, Legend, rows scrollport — the
          box's own `rounded-md border border-edge bg-surface` is the
          same styling the legend row and the rows scrollport used to
          each carry independently (generalized up to this one wrapper so
          the four pieces read as one card instead of two separately
          bordered boxes stacked on top of each other). The box itself
          participates in the flex-height chain (`flex-1 min-h-0
          flex-col`) so the rows scrollport inside it can still absorb
          all the remaining height — title/zoom/legend keep their natural
          height, same as before.

          HEIGHT PRIORITY (polish item: in a bounded ancestor — the
          History modal's `h-modal-80vh` — this box and the Missed box
          below both compete for the SAME leftover space, and the Missed
          box used to win: it was `shrink-0` (flex-shrink: 0) with its own
          internal scroll capped at ~8-10 rows (`MISSED_TABLE_MAX_HEIGHT`),
          so its natural height was reserved OFF THE TOP, non-negotiably,
          before this box's `flex-1` ever saw the remainder — a run with
          many distinct mistake keys could squeeze this box down to a
          single visible row.

          FLAGGED DEAD END: a `min-h-64` floor on THIS box (an earlier
          version of this fix) does guarantee dominance whenever both
          boxes fit, but doesn't actually prevent overflow — a `min-height`
          is a hard floor, not a suggestion, so on a short enough window
          (verified via the panel-polish E2E script's 800px case) the
          Missed box's own `shrink-0` rigidity plus this floor together
          summed to MORE than the available space, and — since neither
          box had anywhere left to give — their rendered content visually
          OVERLAPPED the finished-state controls row below instead of
          properly stacking. A hard floor can only ever win a fixed-sum
          contest against an equally rigid sibling; it can't make the
          sibling actually yield.

          FIX: make the Missed box wrapper (below) properly shrinkable
          instead — drop its `shrink-0` for `min-h-0` (default
          `flex-shrink: 1` already applies; `min-h-0` is what lets it
          shrink below its own natural content size instead of hard-
          flooring there, same reason every OTHER link in this flex chain
          already carries `min-h-0`). With both boxes now genuinely
          shrinkable, a real space deficit gets distributed
          PROPORTIONALLY between them (flexbox's default shrink algorithm,
          weighted by each box's own content size) instead of one box
          refusing to give at all — which naturally keeps this box (whose
          content is usually taller — timeline rows vs a handful of Missed
          rows) LARGER post-shrink too, without ever risking overflow: a
          `min-h-0` box can always still compress toward 0 rather than
          spill past its container. The Missed table's own scrollport cap
          is ALSO tightened for this call site (`max-h-40` vs the
          component's own `max-h-56` default, see the `MissedTable` call
          below) so it claims less of the ROOMY-window case too, biasing
          the split toward this box even when nothing is actually
          squeezed. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 rounded-md border border-edge bg-surface p-3"
        data-testid="typing-test-timeline-box"
      >
        <h3 data-testid="typing-test-timeline-title" className="text-xs font-semibold uppercase tracking-widest text-content-muted">
          {t('editor.typingTest.history.timeline.modalTitle')}
        </h3>

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
          <div className="flex items-center gap-3" data-testid="word-timeline-zoom-row">
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

        {/* Legend — color alone never carries meaning elsewhere in
            this view (tooltips spell everything out too), but this
            is the at-a-glance key. Every item shows only its head
            word ("Overlapped" / "Unjudged" / "Pause") — the former
            parenthetical explanation moved into a per-item hover
            tooltip (`LegendSwatch`'s own `tooltipKey`), rendered PLAIN
            with no visual affordance on the label itself (matching every
            other tooltip trigger in this codebase — ErrorMixSection's
            row labels, CoverageBadge, the Missed table's own bar rows —
            none of which carry an underline or a special cursor; the
            tooltip appearing on hover/focus is the only signal) so the
            row stays a compact single line instead of wrapping under
            long inline text.
            "Normal keystroke" / "Mistake" / "Pause before this
            word(/line)" never carried a parenthetical, so those three
            have no tooltip. Line-mode overrides the blank/lead-in
            wording (both label AND tooltip) to the line-view's own
            meaning (a 250ms cut and "before this line", not the word
            view's 1000ms / "before this word") — every other entry, and
            the word view's own wording, stays unchanged. The two
            longer-form notes (corrected-mistake markers, compressed-
            pause axis) used to render as their own paragraph lines below
            the legend — collapsed into this single info glyph (`ml-auto`,
            right end of the row) so the legend reads as one compact
            line; both notes still live in the tooltip, joined with a
            newline (BUBBLE_BASE's `whitespace-pre-line` renders it as
            two lines), same idiom as ErrorMixSection's row-label
            tooltip. Rendered as a plain, non-interactive `<span>` (not a
            `<button>`) for the same reason the legend labels above are
            plain — this codebase's `button:not(:disabled) { cursor:
            pointer }` global rule (style.css) would otherwise put an
            interactive-looking cursor on a glyph that does nothing on
            click, same inconsistency CoverageBadge's plain-span trigger
            already avoids. `aria-label` still supplies its accessible
            name (the `Info` icon itself is `aria-hidden`); like
            CoverageBadge/ErrorMixSection's own triggers, this means
            hover discovers it but Tab does not — no `tabIndex` is added,
            since none of this codebase's other non-button tooltip
            triggers add one either. */}
        <div className="flex flex-wrap items-center gap-3" data-testid="word-timeline-legend">
          {LEGEND_ORDER.map((kind) => (
            <LegendSwatch
              key={kind}
              colorClass={TIMELINE_LEGEND[kind].swatchClass}
              labelKey={lineLegendLabelKey(kind, displayMode)}
              tooltipKey={lineLegendTooltipKey(kind, displayMode)}
            />
          ))}
          <Tooltip content={legendNotes} className="max-w-xs">
            <span
              data-testid="word-timeline-legend-info"
              aria-label={t('editor.typingTest.history.timeline.legend.infoAriaLabel')}
              className="ml-auto rounded p-1 text-content-muted hover:text-content transition-colors"
            >
              <Info size={ICON_SM} aria-hidden="true" />
            </span>
          </Tooltip>
        </div>

        {/* `keystroke-timeline-scrollport` (style.css) opts this scroll
            container into `container-type: inline-size` — the LINE view's
            per-row header pins itself to this container's own visible
            width via `100cqw` (see LineTimelineRow.tsx and
            .line-timeline-header-sticky's own doc comment), independent of
            how wide the zoomed canvas inside it grows. `overflow-auto`
            already covers BOTH axes — a many-row run scrolls vertically
            within this same element, not just horizontally on zoom; the
            sticky header's `left: 0` pin is horizontal-axis only, so it is
            unaffected by (and stays correctly positioned through) vertical
            scrolling here.
            `flex-1 min-h-0` is what makes that vertical scroll trigger AT
            ALL — it relies entirely on an unbroken flex-height chain from
            this element up through the box above to a real bounded
            ancestor (the editor's own overflow-auto content pane). A fixed
            viewport-relative max-height cap used to live here for the
            completion screen specifically (which lacked that chain), but a
            fixed vh figure can't adapt to how much OTHER chrome
            (Lines/Font sidebar controls, an IME-composition warning, the
            Missed table, ...) a given run actually has above/below it — it
            either wastes space or (on a shorter window, or a run with more
            of that chrome) still overflows the pane. TypingTestView.tsx
            now instead extends this same flex chain up through its own
            finished-state wrapper, so this scrollport ends up correctly
            sized without any cap at all, in both the modal and the
            completion-screen contexts alike — see TypingTestView.tsx's own
            "Completion screen" comment for the exact chain. */}
        <div
          ref={containerRef}
          className="keystroke-timeline-scrollport relative min-h-0 flex-1 overflow-auto p-2"
        >
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

      {/* Missed table — result-only (see the module doc comment):
          reconstructing it from the raw log would re-derive scoring rules
          run-state.ts already owns. Renders nothing when the result has
          no mistakes, same convention the completion screen
          (`TypingTestStatsRow`) already follows for its own copy of this
          list. Substitution/Omission/Insertion render above, as stat
          cards in `summaryItems`, not here. Stays in the same position it
          held as a chip list (below the timeline box) so the timeline
          itself reads first.

          `min-h-0` (NOT `shrink-0` — see the timeline box's own
          HEIGHT PRIORITY comment for why that flip matters) lets this box
          shrink below its own natural content size in a bounded ancestor
          instead of hard-flooring there; the DEFAULT `flex-shrink: 1`
          (unset, so this is just the browser default) is what actually
          does the shrinking once space runs short, proportional to this
          box's own content size vs the timeline box's — which keeps the
          timeline box bigger post-shrink too, without either box ever
          overflowing its container.

          Wrapped in the SAME bordered-box treatment as the timeline box
          above (`rounded-md border border-edge bg-surface p-3`,
          coordinator-requested layout tweak) — but only at THIS call
          site. `MissedTable` itself stays unwrapped: it's also rendered
          by `MistakeRankingSection` (History's Analysis tab "Most missed"
          section, which sits among unboxed section-heading siblings —
          ACCURACY TREND / ERROR MIX — and must stay that way), so the box
          is added here around the render, not inside `MissedTable`.

          `maxHeightClass="max-h-40"` (vs `MissedTable`'s own `max-h-56`
          default) and `bordered={false}` are this call site's own polish
          tweaks: a tighter cap biases the ROOMY-window case toward the
          timeline box too (less reserved by Missed even when nothing is
          actually squeezed), and `bordered={false}` drops the
          scrollport's inner border since THIS wrapper already frames the
          whole section — the two together used to double-stack a border
          around the same content. Neither prop is passed at
          `MistakeRankingSection`'s call site, which keeps `MissedTable`'s
          unbounded defaults (`max-h-56`, its own border) since that
          section has no competing sibling and no outer box of its own. */}
      {hasMistakes && (
        <div className="min-h-0 rounded-md border border-edge bg-surface p-3" data-testid="typing-test-missed-box">
          <MissedTable
            mistakes={result?.mistakes ?? {}}
            details={missedDetails}
            maxHeightClass="max-h-40"
            bordered={false}
          />
        </div>
      )}
    </div>
  )
}
