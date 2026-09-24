// SPDX-License-Identifier: GPL-2.0-or-later
//
// The macro hover bubble: `M{n}` plus every action of the macro, one per
// line, with the same prefixes as the Macro tab tiles and the labels in
// full. It follows the shared-bubble contract of `Tooltip.tsx`
// (`BUBBLE_BASE`, `computeBubblePosition` with an 8px offset,
// `role="tooltip"`) and is portaled to `document.body`, so no scroll
// container clips it.
//
// The bubble is `pointer-events-none`, so it can't scroll. Its size is
// capped at the viewport instead, and a list taller than the viewport
// flows into more columns. A text action wraps inside its column and
// keeps its spaces and line breaks.

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BUBBLE_BASE, computeBubblePosition } from '../ui/Tooltip'
import { MACRO_PREFIX, macroActionLabel } from './macro-action-format'
import type { MacroHoverBubbleState } from './use-macro-hover'

/** Same margin as `Tooltip.tsx`'s viewport clamping. */
const VIEWPORT_MARGIN = 8
const BUBBLE_OFFSET = 8
export const MAX_MACRO_BUBBLE_COLUMNS = 8

// Static class names so Tailwind generates them; indexed by column count.
const COLUMN_CLASSES = ['', '', 'columns-2', 'columns-3', 'columns-4', 'columns-5', 'columns-6', 'columns-7', 'columns-8']

// `BUBBLE_BASE` with two deliberate changes: z-70 so the bubble stays above
// the z-50 / z-60 modals whose pickers show it, and a viewport-sized cap
// instead of `max-w-sm` (each line keeps `max-w-sm` itself, so a single
// column is exactly as wide as a regular tooltip).
export const MACRO_BUBBLE_CLASS = BUBBLE_BASE
  .replace('z-50', 'z-70')
  .replace('max-w-sm', 'max-w-tooltip-viewport max-h-tooltip-viewport overflow-hidden')

/** Column count to try after measuring the list at `current` columns.
 *  Starts from the ratio of list height to available height, then adds one
 *  column at a time while the balanced columns still don't fit. */
export function nextMacroBubbleColumns(current: number, listHeight: number, availableHeight: number): number {
  if (listHeight <= availableHeight || availableHeight <= 0 || current >= MAX_MACRO_BUBBLE_COLUMNS) return current
  if (current === 1) return Math.min(MAX_MACRO_BUBBLE_COLUMNS, Math.max(2, Math.ceil(listHeight / availableHeight)))
  return current + 1
}

export function MacroHoverBubble({ bubble }: { bubble: MacroHoverBubbleState | null }): JSX.Element | null {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Both are tied to the bubble they were measured for, so a new bubble
  // starts from one column at the anchor's own position.
  const [columnsFor, setColumnsFor] = useState<{ bubble: MacroHoverBubbleState; columns: number } | null>(null)
  const [posFor, setPosFor] = useState<{ bubble: MacroHoverBubbleState; top: number; left: number } | null>(null)
  const columns = columnsFor && columnsFor.bubble === bubble ? columnsFor.columns : 1
  const pos = posFor && posFor.bubble === bubble ? posFor : null

  useLayoutEffect(() => {
    const el = bubbleRef.current
    const list = listRef.current
    if (!bubble || !el || !list) return
    const chrome = el.offsetHeight - list.offsetHeight
    const available = window.innerHeight - 2 * VIEWPORT_MARGIN - chrome
    const next = nextMacroBubbleColumns(columns, list.offsetHeight, available)
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
  }, [bubble, columns])

  if (!bubble || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      data-testid="macro-hover-bubble"
      data-columns={columns}
      className={MACRO_BUBBLE_CLASS}
      style={{ top: pos?.top ?? bubble.rect.top, left: pos?.left ?? bubble.rect.left }}
    >
      <div className="text-2xs leading-snug text-content-muted">M{bubble.index}</div>
      <div ref={listRef} className={`${COLUMN_CLASSES[columns]} gap-x-4`}>
        {bubble.actions.map((action, i) => (
          <div key={i} className="flex max-w-sm gap-x-1.5 break-inside-avoid" data-testid="macro-hover-line">
            <span className="w-4 shrink-0 text-content-muted">{MACRO_PREFIX[action.type]}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{macroActionLabel(action)}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
