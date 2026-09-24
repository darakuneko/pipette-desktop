// SPDX-License-Identifier: GPL-2.0-or-later
//
// The entry hover bubble: a title plus every field of the hovered macro,
// Tap Dance, Combo, Key Override or Alt Repeat Key entry, in full (content
// from `hover-entry-content.ts`). It follows the shared-bubble contract of
// `Tooltip.tsx` (`BUBBLE_BASE`, `computeBubblePosition` with an 8px offset,
// `role="tooltip"`) and is portaled to `document.body`, so no scroll
// container clips it.
//
// The bubble is `pointer-events-none`, so it can't scroll. Its size is
// capped at the viewport instead, and a macro list taller than the
// viewport flows into more columns. The other kinds have a handful of
// fields in a two-column table. Long values wrap and keep their spaces and
// line breaks.

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { BUBBLE_BASE, computeBubblePosition } from '../ui/Tooltip'
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

/** A computed-style length in px; 0 when it isn't one. */
function px(value: string): number {
  return parseFloat(value) || 0
}

/** Column count to try next for the list as it is laid out now. */
function nextColumnsFor(el: HTMLElement, list: HTMLElement, heading: HTMLElement, columns: number): number {
  // Everything but the list, summed from its parts: the bubble's own
  // height is capped at the viewport, so subtracting the list from it
  // would go negative exactly when the list is too tall.
  const style = window.getComputedStyle(el)
  const chrome = heading.offsetHeight
    + px(style.paddingTop) + px(style.paddingBottom)
    + px(style.borderTopWidth) + px(style.borderBottomWidth)
  const available = window.innerHeight - 2 * VIEWPORT_MARGIN - chrome
  return nextEntryBubbleColumns(columns, list.offsetHeight, available)
}

export function EntryHoverBubble({ bubble }: { bubble: EntryHoverBubbleState | null }): JSX.Element | null {
  const { t } = useTranslation()
  const content = useMemo(() => (bubble ? buildHoverContent(bubble.entry, bubble.index, t) : null), [bubble, t])
  const splits = content?.layout === 'prefix'
  const bubbleRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Both are tied to the bubble they were measured for, so a new bubble
  // starts from one column at the anchor's own position.
  const [columnsFor, setColumnsFor] = useState<{ bubble: EntryHoverBubbleState; columns: number } | null>(null)
  const [posFor, setPosFor] = useState<{ bubble: EntryHoverBubbleState; top: number; left: number } | null>(null)
  const columns = columnsFor && columnsFor.bubble === bubble ? columnsFor.columns : 1
  const pos = posFor && posFor.bubble === bubble ? posFor : null

  useLayoutEffect(() => {
    const el = bubbleRef.current
    const list = listRef.current
    const heading = headingRef.current
    if (!bubble || !el || !list || !heading) return
    const next = splits ? nextColumnsFor(el, list, heading, columns) : columns
    if (next !== columns) {
      setColumnsFor({ bubble, columns: next })
      return
    }
    const { top, left } = computeBubblePosition(
      bubble.rect,
      el.getBoundingClientRect(),
      'top',
      'center',
      BUBBLE_OFFSET,
      { width: window.innerWidth, height: window.innerHeight },
    )
    setPosFor((prev) => (prev && prev.bubble === bubble && prev.top === top && prev.left === left ? prev : { bubble, top, left }))
  }, [bubble, columns, splits])

  if (!bubble || !content || typeof document === 'undefined') return null

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
      {splits ? (
        <div ref={listRef} className={`${COLUMN_CLASSES[columns]} gap-x-4`}>
          {content.rows.map((row, i) => (
            <div key={i} className="flex max-w-sm gap-x-1.5 break-inside-avoid" data-testid="entry-hover-line">
              <span className="w-4 shrink-0 text-content-muted">{row.label}</span>
              <span className={VALUE_CLASS}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div ref={listRef} className="grid max-w-sm grid-cols-auto-1fr gap-x-3">
          {content.rows.map((row, i) => (
            <div key={i} className="contents" data-testid="entry-hover-line">
              <span className="text-content-muted">{row.label}</span>
              <span className={VALUE_CLASS}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
