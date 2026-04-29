// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react'

/**
 * Headless popover that renders into `document.body` so it can escape
 * ancestor `overflow: auto/clip/hidden` containers. Coordinates are
 * computed against `anchorRef`'s `getBoundingClientRect()` and the
 * popover follows scroll / resize while open — same pattern as
 * `Tooltip.tsx`. Use this for click-toggled menus where the trigger
 * lives inside a horizontally-scrollable row (e.g. the Analyze filter
 * bar) and the menu must not be clipped.
 *
 * Controlled: the consumer owns `open` state. `onClose` fires on
 * outside click (not on anchor, not on popover) and on Escape — the
 * consumer is expected to flip `open` to false and run any extra
 * cleanup (e.g. resetting pending state) inside it.
 */

const DEFAULT_OFFSET_PX = 4

export interface AnchoredPopoverProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** Vertical gap between the anchor's bottom edge and the popover's
   * top edge, in CSS pixels. */
  offset?: number
  children: ReactNode
}

export function AnchoredPopover({
  anchorRef,
  open,
  onClose,
  offset = DEFAULT_OFFSET_PX,
  children,
  ...rest
}: AnchoredPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [mounted, setMounted] = useState(false)

  // Defer the createPortal call until after first commit so SSR /
  // pre-mount renders don't crash on `document.body` access.
  useEffect(() => {
    setMounted(true)
  }, [])

  // Position is computed before paint so the first frame lands at the
  // trigger (no flash at last-known coords). The same effect attaches
  // scroll (capture: true so inner scroll containers fire too) and
  // resize listeners so the popover follows the trigger while the
  // user pans the filter row horizontally. Bail out via prev-equals
  // check so unrelated scroll events don't schedule a no-op re-render.
  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const next = { top: rect.bottom + offset, left: rect.left }
      setPosition((prev) => (prev.top === next.top && prev.left === next.left ? prev : next))
    }
    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, anchorRef, offset])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (target === null) return
      if (anchorRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, anchorRef, onClose])

  if (!open || !mounted || typeof document === 'undefined') return null

  const style: CSSProperties = {
    position: 'fixed',
    top: position.top,
    left: position.left,
  }

  return createPortal(
    <div ref={popoverRef} style={style} {...rest}>
      {children}
    </div>,
    document.body,
  )
}
