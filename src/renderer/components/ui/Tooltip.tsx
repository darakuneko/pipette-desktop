// SPDX-License-Identifier: GPL-2.0-or-later

import { cloneElement, useId, createElement } from 'react'
import type { CSSProperties, HTMLAttributes, ReactElement, ReactNode } from 'react'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'
export type TooltipAlign = 'start' | 'center' | 'end'
export type TooltipElement = 'div' | 'span'

/**
 * Shared tooltip for interactive icon/button triggers (v1.1).
 *
 * Wraps the trigger in `wrapperAs` (default `div`) with `group/tt relative
 * inline-block` and renders a CSS-driven bubble (`bubbleAs`, default `div`)
 * that shows on hover or focus-within. Short-text only (`whitespace-nowrap`).
 *
 * `describedByOn='trigger'` clones the child and merges `aria-describedby`;
 * `describedByOn='wrapper'` leaves the child alone and puts the reference on
 * the wrapper instead — useful when ARIA semantics (e.g. `role="cell"`)
 * belong on the wrapper.
 *
 * Pass `wrapperAs='span'` + `bubbleAs='span'` when the tooltip must nest
 * inside an inline-only ancestor (e.g. recharts Legend formatter output).
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
  'pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg text-xs font-medium text-content whitespace-nowrap opacity-0 transition-opacity group-hover/tt:opacity-100 group-focus-within/tt:opacity-100'

const WRAPPER_BASE = 'group/tt relative inline-block'

const POSITION: Record<TooltipSide, Record<TooltipAlign, string>> = {
  top: {
    start: 'bottom-full left-0 mb-[var(--tt-offset)]',
    center: 'bottom-full left-1/2 -translate-x-1/2 mb-[var(--tt-offset)]',
    end: 'bottom-full right-0 mb-[var(--tt-offset)]',
  },
  right: {
    start: 'left-full top-0 ml-[var(--tt-offset)]',
    center: 'left-full top-1/2 -translate-y-1/2 ml-[var(--tt-offset)]',
    end: 'left-full bottom-0 ml-[var(--tt-offset)]',
  },
  bottom: {
    start: 'top-full left-0 mt-[var(--tt-offset)]',
    center: 'top-full left-1/2 -translate-x-1/2 mt-[var(--tt-offset)]',
    end: 'top-full right-0 mt-[var(--tt-offset)]',
  },
  left: {
    start: 'right-full top-0 mr-[var(--tt-offset)]',
    center: 'right-full top-1/2 -translate-y-1/2 mr-[var(--tt-offset)]',
    end: 'right-full bottom-0 mr-[var(--tt-offset)]',
  },
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

  if (disabled) return children

  const bubbleClass = [BUBBLE_BASE, POSITION[side][align], className].filter(Boolean).join(' ')
  const wrapperClass = [WRAPPER_BASE, wrapperProps?.className, wrapperClassName].filter(Boolean).join(' ')
  const bubbleStyle = {
    '--tt-offset': `${Math.max(0, offset)}px`,
    transitionDelay: `${Math.max(0, openDelay)}ms`,
  } as CSSProperties

  let trigger: ReactElement = children
  const wrapperAttrs: Record<string, unknown> = { ...wrapperProps, className: wrapperClass }

  if (describedByOn === 'trigger') {
    const existingDescribedBy = children.props['aria-describedby']
    const mergedDescribedBy = existingDescribedBy ? `${existingDescribedBy} ${id}` : id
    trigger = cloneElement(children, { 'aria-describedby': mergedDescribedBy })
  } else {
    const existingDescribedBy = wrapperProps?.['aria-describedby']
    wrapperAttrs['aria-describedby'] = existingDescribedBy ? `${existingDescribedBy} ${id}` : id
  }

  return createElement(
    wrapperAs,
    wrapperAttrs,
    trigger,
    createElement(
      bubbleAs,
      { role: 'tooltip', id, className: bubbleClass, style: bubbleStyle },
      content,
    ),
  )
}
