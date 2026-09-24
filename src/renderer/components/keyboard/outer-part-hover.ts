// SPDX-License-Identifier: GPL-2.0-or-later
//
// Inner-rect handlers for `hoverOuterPartOnly` on a masked key
// (`KeyWidget.tsx`) or encoder direction (`EncoderWidget.tsx`): hover counts
// only while the pointer is over the outer part. Entering the inner rect
// ends the hover; moving from the inner rect back onto the outer part of
// the same `<g>` reports it again. Leaving the widget through the inner
// rect needs nothing here, since the group's own mouseleave ends the hover.

import type { MouseEvent } from 'react'

export interface OuterPartHoverHandlers {
  onInnerEnter: () => void
  onInnerLeave: (e: MouseEvent<SVGElement>) => void
}

export function outerPartHoverHandlers(
  emitHover: (group: SVGGElement) => void,
  onHoverEnd: (() => void) | undefined,
): OuterPartHoverHandlers {
  return {
    onInnerEnter: () => onHoverEnd?.(),
    onInnerLeave: (e) => {
      const group = e.currentTarget.closest('g')
      const next = e.relatedTarget
      if (group && next instanceof Node && group.contains(next)) emitHover(group)
    },
  }
}
