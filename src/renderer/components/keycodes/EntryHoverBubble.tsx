// SPDX-License-Identifier: GPL-2.0-or-later
//
// The entry hover bubble: a title plus every field of the hovered macro,
// Tap Dance, Combo, Key Override or Alt Repeat Key entry, in full (content
// from `hover-entry-content.ts`). It follows the shared-bubble contract of
// `Tooltip.tsx` (`BUBBLE_BASE`, an 8px offset, `role="tooltip"`) except for
// its placement (below), and is portaled to `document.body`, so no scroll
// container clips it.
//
// The bubble is `pointer-events-none`, so it can't scroll. Its size is
// capped at the viewport instead, and content taller than the viewport
// flows into more columns: a macro list through CSS columns, the other
// kinds' "field | value" table by splitting its rows into side-by-side
// tables so the field names stay aligned. Long values wrap and keep their
// spaces and line breaks.
//
// Placement keeps the hovered key or tile visible: the bubble goes right
// above, below, right or left of it (`entry-bubble-placement.ts`). When the
// column count sized for the viewport leaves it too tall for any of those,
// more columns are tried against the taller of the spaces above and below
// the anchor; when that doesn't help either, the bubble goes back to the
// viewport-sized columns and the shared top-center placement, which may
// cover the anchor.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { BUBBLE_BASE, computeBubblePosition } from '../ui/Tooltip'
import { placeBesideAnchor, tallestSpaceBesideAnchor } from './entry-bubble-placement'
import { buildHoverContent } from './hover-entry-content'
import type { EntryHoverBubbleState } from './use-entry-hover'

/** Same margin as `Tooltip.tsx`'s viewport clamping. */
const VIEWPORT_MARGIN = 8
const BUBBLE_OFFSET = 8
export const MAX_ENTRY_BUBBLE_COLUMNS = 8

// Static class names so Tailwind generates them; indexed by column count.
const COLUMN_CLASSES = ['', '', 'columns-2', 'columns-3', 'columns-4', 'columns-5', 'columns-6', 'columns-7', 'columns-8']

// `BUBBLE_BASE` with two deliberate changes: z-70 so the bubble stays above
// the z-50 / z-60 modals whose pickers show it, and a viewport-sized cap
// instead of `max-w-sm` (each line keeps `max-w-sm` itself, so a single
// column is exactly as wide as a regular tooltip).
export const ENTRY_BUBBLE_CLASS = BUBBLE_BASE
  .replace('z-50', 'z-70')
  .replace('max-w-sm', 'max-w-tooltip-viewport max-h-tooltip-viewport overflow-hidden')

const VALUE_CLASS = 'min-w-0 whitespace-pre-wrap break-words'

/** Column count to try after measuring the list at `current` columns.
 *  Starts from the ratio of list height to available height, then adds one
 *  column at a time while the balanced columns still don't fit. */
export function nextEntryBubbleColumns(current: number, listHeight: number, availableHeight: number): number {
  if (listHeight <= availableHeight || availableHeight <= 0 || current >= MAX_ENTRY_BUBBLE_COLUMNS) return current
  if (current === 1) return Math.min(MAX_ENTRY_BUBBLE_COLUMNS, Math.max(2, Math.ceil(listHeight / availableHeight)))
  return current + 1
}

/** `rows` cut into at most `columns` runs of equal length (the last may be
 *  shorter), one per side-by-side table. */
export function splitRows<T>(rows: readonly T[], columns: number): T[][] {
  const size = Math.max(1, Math.ceil(rows.length / columns))
  const chunks: T[][] = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}

/** How the bubble for one hover is being laid out. `viewport`: growing the
 *  column count until the list fits the viewport height. `beside`: a retry
 *  with more columns so the bubble fits next to its anchor. `fallback`:
 *  back at the `viewport` column count, to be placed top-center. `done`:
 *  `pos` is final. The stages only move forward, so a bubble is measured a
 *  bounded number of times. */
export interface EntryBubbleLayout {
  stage: 'viewport' | 'beside' | 'fallback' | 'done'
  columns: number
  /** Column count the `viewport` stage settled on. */
  viewportColumns: number
  /** List height measured at the column count before this one, which a
   *  `beside` attempt must beat. */
  listHeight: number
  pos: { top: number; left: number } | null
}

export const INITIAL_ENTRY_BUBBLE_LAYOUT: EntryBubbleLayout = {
  stage: 'viewport', columns: 1, viewportColumns: 1, listHeight: 0, pos: null,
}

export interface EntryBubbleMeasurement {
  anchor: DOMRect
  /** The bubble as laid out at the current column count. */
  bubbleRect: DOMRect
  /** The list alone, uncapped by the bubble's `max-h`. */
  listHeight: number
  /** Heading, padding and border: everything in the bubble but the list. */
  chrome: number
  viewport: { width: number; height: number }
  /** Row count of a field table (null for a macro list), whose split only
   *  changes when the rows per table do. */
  tableRows: number | null
}

function rowsPerTable(rows: number, columns: number): number {
  return Math.ceil(rows / columns)
}

/** The layout after measuring the bubble at `layout`: the same object once
 *  the position is final, otherwise the next thing to render and measure. */
export function stepEntryBubbleLayout(layout: EntryBubbleLayout, m: EntryBubbleMeasurement): EntryBubbleLayout {
  if (layout.stage === 'done') return layout
  const topCenter = (): EntryBubbleLayout => ({
    ...layout,
    stage: 'done',
    pos: computeBubblePosition(m.anchor, m.bubbleRect, 'top', 'center', BUBBLE_OFFSET, m.viewport),
  })
  if (layout.stage === 'fallback') return topCenter()
  if (layout.stage === 'viewport') {
    const next = nextEntryBubbleColumns(layout.columns, m.listHeight, m.viewport.height - 2 * VIEWPORT_MARGIN - m.chrome)
    if (next !== layout.columns) return { ...layout, columns: next }
  }
  const placed = placeBesideAnchor(m.anchor, m.bubbleRect, m.viewport, BUBBLE_OFFSET, VIEWPORT_MARGIN)
  if (placed) return { ...layout, stage: 'done', pos: { top: placed.top, left: placed.left } }

  const viewportColumns = layout.stage === 'viewport' ? layout.columns : layout.viewportColumns
  // More columns only help while they make the list shorter; a macro line
  // never splits and a table keeps its split while its rows per table do.
  const shrank = layout.stage === 'viewport' || m.listHeight < layout.listHeight
  const space = tallestSpaceBesideAnchor(m.anchor, m.viewport.height, BUBBLE_OFFSET, VIEWPORT_MARGIN) - m.chrome
  const next = nextEntryBubbleColumns(layout.columns, m.listHeight, space)
  const resplits = m.tableRows === null || rowsPerTable(m.tableRows, next) !== rowsPerTable(m.tableRows, layout.columns)
  if (shrank && next !== layout.columns && resplits) {
    return { stage: 'beside', columns: next, viewportColumns, listHeight: m.listHeight, pos: null }
  }
  if (layout.columns === viewportColumns) return topCenter()
  return { ...layout, stage: 'fallback', columns: viewportColumns, pos: null }
}

/** A computed-style length in px; 0 when it isn't one. */
function px(value: string): number {
  return parseFloat(value) || 0
}

/** Height of everything in the bubble but the list, summed from its parts:
 *  the bubble's own height is capped at the viewport, so subtracting the
 *  list from it would go negative exactly when the list is too tall. */
function chromeHeight(el: HTMLElement, heading: HTMLElement): number {
  const style = window.getComputedStyle(el)
  return heading.offsetHeight
    + px(style.paddingTop) + px(style.paddingBottom)
    + px(style.borderTopWidth) + px(style.borderBottomWidth)
}

export function EntryHoverBubble({ bubble }: { bubble: EntryHoverBubbleState | null }): JSX.Element | null {
  const { t } = useTranslation()
  const content = useMemo(() => (bubble ? buildHoverContent(bubble.entry, bubble.index, t) : null), [bubble, t])
  const bubbleRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Tied to the bubble it was measured for, so a new bubble starts over
  // from one column at the anchor's own position.
  const [layoutFor, setLayoutFor] = useState<{ bubble: EntryHoverBubbleState; layout: EntryBubbleLayout } | null>(null)
  const layout = layoutFor && layoutFor.bubble === bubble ? layoutFor.layout : INITIAL_ENTRY_BUBBLE_LAYOUT
  const { columns, pos } = layout
  // The anchor rect is a snapshot taken on hover, so a resize closes the
  // bubble instead of leaving it beside a key position that may be stale.
  const [closed, setClosed] = useState<EntryHoverBubbleState | null>(null)

  useEffect(() => {
    if (!bubble) return
    const onResize = (): void => setClosed(bubble)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [bubble])

  // Every stage runs here, before paint, so only the final position shows.
  useLayoutEffect(() => {
    const el = bubbleRef.current
    const list = listRef.current
    const heading = headingRef.current
    if (!bubble || !content || !el || !list || !heading) return
    const next = stepEntryBubbleLayout(layout, {
      anchor: bubble.rect,
      bubbleRect: el.getBoundingClientRect(),
      listHeight: list.offsetHeight,
      chrome: chromeHeight(el, heading),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tableRows: content.layout === 'prefix' ? null : content.rows.length,
    })
    if (next !== layout) setLayoutFor({ bubble, layout: next })
  }, [bubble, content, layout])

  if (!bubble || !content || closed === bubble || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      data-testid="entry-hover-bubble"
      data-columns={columns}
      className={ENTRY_BUBBLE_CLASS}
      style={{ top: pos?.top ?? bubble.rect.top, left: pos?.left ?? bubble.rect.left }}
    >
      <div ref={headingRef} className="text-2xs leading-snug text-content-muted">{content.title}</div>
      {content.layout === 'prefix' ? (
        <div ref={listRef} className={`${COLUMN_CLASSES[columns]} gap-x-4`}>
          {content.rows.map((row, i) => (
            <div key={i} className="flex max-w-sm gap-x-1.5 break-inside-avoid" data-testid="entry-hover-line">
              <span className="w-4 shrink-0 text-content-muted">{row.label}</span>
              <span className={VALUE_CLASS}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div ref={listRef} className="flex items-start gap-x-4">
          {splitRows(content.rows, columns).map((chunk, c) => (
            <div key={c} className="grid max-w-sm grid-cols-auto-1fr gap-x-3" data-testid="entry-hover-table">
              {chunk.map((row, i) => (
                <div key={i} className="contents" data-testid="entry-hover-line">
                  <span className="text-content-muted">{row.label}</span>
                  <span className={VALUE_CLASS}>{row.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
