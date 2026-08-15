// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure geometry helpers for clamping the main window's bounds to a
// display's work area. Minimum size is passed in as params rather than
// read from app-config (which imports electron's `screen`) so this module
// can stay electron-free at runtime — the `Rectangle`/`Size` imports below
// are type-only and erased at compile time, keeping it unit-testable
// without booting a BrowserWindow or the `screen` module.

import type { Rectangle, Size } from 'electron'

/**
 * The minimum size actually enforceable on the given work area. Equal to
 * the nominal minimum unless the work area is smaller, in which case it
 * shrinks to fit — never wider or taller than the visible area itself.
 */
export function effectiveMinSize(workArea: Size, minWidth: number, minHeight: number): Size {
  return {
    width: Math.min(minWidth, workArea.width),
    height: Math.min(minHeight, workArea.height),
  }
}

/**
 * Shrinks `bounds` to fit inside `workArea` (never growing it) and then
 * slides it so the whole rectangle stays within the work area's origin and
 * far edge. Size is resolved before position so a rect larger than the work
 * area lands flush against the near edge instead of straddling it.
 */
export function clampBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)

  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const x = Math.min(Math.max(bounds.x, workArea.x), maxX)
  const y = Math.min(Math.max(bounds.y, workArea.y), maxY)

  return { x, y, width, height }
}
