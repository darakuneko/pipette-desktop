// SPDX-License-Identifier: GPL-2.0-or-later
// Toggle button heading a collapsible tree group: chevron + truncated
// label, `aria-expanded` reflecting the open state. Callers render the
// group's children themselves.

import type { CSSProperties } from 'react'
import { DisclosureChevron } from './DisclosureChevron'

interface DisclosureRowProps {
  label: string
  open: boolean
  onToggle: () => void
  /** Runtime indentation (DataNavTree's depth-based padding). */
  style?: CSSProperties
  testId?: string
}

export function DisclosureRow({ label, open, onToggle, style, testId }: DisclosureRowProps) {
  return (
    <button
      type="button"
      className="w-full text-left text-sm py-1 flex items-center gap-1 cursor-pointer truncate text-content-secondary hover:text-content"
      style={style}
      onClick={onToggle}
      data-testid={testId}
      aria-expanded={open}
    >
      <DisclosureChevron open={open} />
      <span className="truncate">{label}</span>
    </button>
  )
}
