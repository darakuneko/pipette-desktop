// SPDX-License-Identifier: GPL-2.0-or-later
//
// Where the entry hover bubble (`EntryHoverBubble.tsx`) goes so it doesn't
// cover the key or tile it describes. Unlike `computeBubblePosition`
// (`Tooltip.tsx`), which clamps a bubble into the viewport even when that
// pushes it over its trigger, a candidate here always touches the anchor at
// `offset` on one side and only slides along that side; a candidate that
// doesn't fit that way is dropped rather than moved away from the anchor.

export interface AnchorRect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface BubbleSize {
  width: number
  height: number
}

export type BesideSide = 'top' | 'bottom' | 'right' | 'left'

export interface BesidePlacement {
  top: number
  left: number
  side: BesideSide
}

/** Tried in this order: the shared tooltips' default side, its opposite,
 *  then the two sides. */
const SIDES: readonly BesideSide[] = ['top', 'bottom', 'right', 'left']

/** Slack for sub-pixel measurements, so an exact fit isn't lost to float
 *  rounding. */
const EPSILON = 0.001

/** Start of a `size`-long run centered on `center`, slid to stay inside
 *  `[margin, extent - margin]`; null when it can't fit there at all. */
function alignedStart(center: number, size: number, extent: number, margin: number): number | null {
  const max = extent - margin - size
  if (max < margin - EPSILON) return null
  return Math.min(Math.max(center - size / 2, margin), Math.max(max, margin))
}

function overlaps(a: AnchorRect, top: number, left: number, size: BubbleSize): boolean {
  return left < a.right && left + size.width > a.left && top < a.bottom && top + size.height > a.top
}

function candidate(
  side: BesideSide, anchor: AnchorRect, size: BubbleSize, viewport: BubbleSize, offset: number, margin: number,
): BesidePlacement | null {
  if (side === 'top' || side === 'bottom') {
    const top = side === 'top' ? anchor.top - offset - size.height : anchor.bottom + offset
    if (top < margin - EPSILON || top + size.height > viewport.height - margin + EPSILON) return null
    const left = alignedStart(anchor.left + anchor.width / 2, size.width, viewport.width, margin)
    return left === null ? null : { top, left, side }
  }
  const left = side === 'left' ? anchor.left - offset - size.width : anchor.right + offset
  if (left < margin - EPSILON || left + size.width > viewport.width - margin + EPSILON) return null
  const top = alignedStart(anchor.top + anchor.height / 2, size.height, viewport.height, margin)
  return top === null ? null : { top, left, side }
}

/** The first of top / bottom / right / left where a bubble of `size` fits
 *  inside the viewport (keeping `margin` from its edges) while touching the
 *  anchor at `offset` and not covering it; null when none does. */
export function placeBesideAnchor(
  anchor: AnchorRect, size: BubbleSize, viewport: BubbleSize, offset: number, margin: number,
): BesidePlacement | null {
  for (const side of SIDES) {
    const placed = candidate(side, anchor, size, viewport, offset, margin)
    if (placed && !overlaps(anchor, placed.top, placed.left, size)) return placed
  }
  return null
}

/** Height a bubble can take above or below the anchor, whichever is taller,
 *  keeping `offset` from the anchor and `margin` from the viewport edge.
 *  May be zero or negative when the anchor leaves no room. */
export function tallestSpaceBesideAnchor(anchor: AnchorRect, viewportHeight: number, offset: number, margin: number): number {
  return Math.max(anchor.top - offset - margin, viewportHeight - anchor.bottom - offset - margin)
}
