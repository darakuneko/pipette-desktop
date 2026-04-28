// SPDX-License-Identifier: GPL-2.0-or-later

import { cloneElement, createElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, FocusEvent as ReactFocusEvent, HTMLAttributes, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'
export type TooltipAlign = 'start' | 'center' | 'end'
export type TooltipElement = 'div' | 'span'

/**
 * Shared tooltip for interactive icon/button triggers (v2).
 *
 * The bubble is rendered into `document.body` via React Portal, with its
 * viewport coords computed against the wrapper's `getBoundingClientRect()`
 * each time it opens (and on scroll / resize while open). This means the
 * bubble is no longer clipped by ancestor `overflow: auto/clip/hidden`
 * containers — the historical CSS-only positioning was scoped to the
 * wrapper's stacking context and broke inside scrollable panels.
 *
 * `describedByOn='trigger'` clones the child and merges `aria-describedby`;
 * `describedByOn='wrapper'` leaves the child alone and puts the reference
 * on the wrapper instead — useful when ARIA semantics (e.g. `role="cell"`)
 * belong on the wrapper.
 *
 * Pass `wrapperAs='span'` when the trigger nests inside an inline-only
 * ancestor (e.g. recharts Legend formatter output). `bubbleAs` is kept
 * for parity but rarely matters since the bubble is portaled to body.
 */
export interface TooltipProps {
  content: ReactNode
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: TooltipSide
  align?: TooltipAlign
  offset?: number
  openDelay?: number
  disabled?: boolean
  className?: string
  wrapperClassName?: string
  wrapperAs?: TooltipElement
  bubbleAs?: TooltipElement
  wrapperProps?: HTMLAttributes<HTMLElement>
  describedByOn?: 'trigger' | 'wrapper'
}

const BUBBLE_BASE =
  'pointer-events-none fixed z-50 w-max rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg text-xs font-medium text-content whitespace-pre-line transition-opacity'

const WRAPPER_BASE = 'relative inline-block'

function computeBubblePosition(
  trigger: DOMRect,
  bubble: DOMRect,
  side: TooltipSide,
  align: TooltipAlign,
  offset: number,
): { top: number; left: number } {
  let top = 0
  let left = 0
  if (side === 'top') {
    top = trigger.top - bubble.height - offset
  } else if (side === 'bottom') {
    top = trigger.bottom + offset
  } else if (side === 'left') {
    left = trigger.left - bubble.width - offset
  } else {
    left = trigger.right + offset
  }
  if (side === 'top' || side === 'bottom') {
    if (align === 'start') left = trigger.left
    else if (align === 'end') left = trigger.right - bubble.width
    else left = trigger.left + trigger.width / 2 - bubble.width / 2
  } else {
    if (align === 'start') top = trigger.top
    else if (align === 'end') top = trigger.bottom - bubble.height
    else top = trigger.top + trigger.height / 2 - bubble.height / 2
  }
  return { top, left }
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  offset = 8,
  openDelay = 300,
  disabled = false,
  className,
  wrapperClassName,
  wrapperAs = 'div',
  bubbleAs = 'div',
  wrapperProps,
  describedByOn = 'trigger',
}: TooltipProps) {
  const id = useId()
  const wrapperRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [mounted, setMounted] = useState(false)

  // Portal target only resolves on the client. Defer the createPortal
  // call until after first commit so SSR / pre-mount renders don't crash
  // on `document.body` access.
  useEffect(() => {
    setMounted(true)
  }, [])

  const updatePosition = useCallback(() => {
    const wrap = wrapperRef.current
    const bubble = bubbleRef.current
    if (!wrap || !bubble) return
    setPosition(computeBubblePosition(
      wrap.getBoundingClientRect(),
      bubble.getBoundingClientRect(),
      side,
      align,
      Math.max(0, offset),
    ))
  }, [side, align, offset])

  // Re-position whenever the bubble opens or any layout-affecting input
  // changes. `useLayoutEffect` so the position is in place before paint
  // (avoids a one-frame flash at the previous coords).
  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [open, updatePosition, content])

  // While open, follow scroll / resize so the bubble stays glued to the
  // trigger as the page moves.
  useEffect(() => {
    if (!open) return
    const onChange = () => updatePosition()
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    return () => {
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [open, updatePosition])

  // Force-close when the consumer flips `disabled` mid-render so flipping
  // it back doesn't surface a stale bubble at last-known coords.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  if (disabled) return children

  const bubbleClass = [
    BUBBLE_BASE,
    open ? 'opacity-100' : 'opacity-0',
    className,
  ].filter(Boolean).join(' ')
  const wrapperClass = [WRAPPER_BASE, wrapperProps?.className, wrapperClassName].filter(Boolean).join(' ')
  const bubbleStyle: CSSProperties = {
    top: position.top,
    left: position.left,
    // Delay only the fade-in. Close is instant so a brief hover doesn't
    // leave a ghost bubble lingering for the same delay window.
    transitionDelay: open ? `${Math.max(0, openDelay)}ms` : '0ms',
  }

  let trigger: ReactElement = children
  // Compose hover/focus handlers with whatever the consumer passed via
  // `wrapperProps` so a forwarded onMouseEnter etc. still runs.
  const onMouseEnter = (e: ReactMouseEvent<HTMLElement>) => {
    wrapperProps?.onMouseEnter?.(e)
    setOpen(true)
  }
  const onMouseLeave = (e: ReactMouseEvent<HTMLElement>) => {
    wrapperProps?.onMouseLeave?.(e)
    setOpen(false)
  }
  const onFocus = (e: ReactFocusEvent<HTMLElement>) => {
    wrapperProps?.onFocus?.(e)
    setOpen(true)
  }
  const onBlur = (e: ReactFocusEvent<HTMLElement>) => {
    wrapperProps?.onBlur?.(e)
    setOpen(false)
  }
  const wrapperAttrs: Record<string, unknown> = {
    ...wrapperProps,
    ref: wrapperRef,
    className: wrapperClass,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
  }

  if (describedByOn === 'trigger') {
    const existingDescribedBy = children.props['aria-describedby']
    const mergedDescribedBy = existingDescribedBy ? `${existingDescribedBy} ${id}` : id
    trigger = cloneElement(children, { 'aria-describedby': mergedDescribedBy })
  } else {
    const existingDescribedBy = wrapperProps?.['aria-describedby']
    wrapperAttrs['aria-describedby'] = existingDescribedBy ? `${existingDescribedBy} ${id}` : id
  }

  const bubble = createElement(
    bubbleAs,
    { ref: bubbleRef, role: 'tooltip', id, className: bubbleClass, style: bubbleStyle },
    content,
  )

  return createElement(
    wrapperAs,
    wrapperAttrs,
    trigger,
    mounted && typeof document !== 'undefined' ? createPortal(bubble, document.body) : null,
  )
}
