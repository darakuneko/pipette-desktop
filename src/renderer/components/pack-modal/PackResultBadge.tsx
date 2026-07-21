// SPDX-License-Identifier: GPL-2.0-or-later

import type { PackActionResult } from './pack-modal-types'

export interface PackResultBadgeProps {
  /** A single-row action (rename, upload, delete, ...) sets one result.
   *  A multi-file import batch sets an array so every successfully
   *  imported row can show its own badge at the same time. */
  result: PackActionResult | PackActionResult[] | null
  /** Row (or hub post) id this badge is anchored to — matches `result.id`. */
  rowId: string
  testid: string
}

/**
 * Inline confirmation badge: "Saved" / "Uploaded" / "Updated" /
 * "Removed" or the localized error message after a Hub or local
 * mutation completes. Shared across Language Packs, Theme Packs and
 * Key Labels so the feedback stays visually identical.
 */
export function PackResultBadge({ result, rowId, testid }: PackResultBadgeProps): JSX.Element | null {
  const match = Array.isArray(result)
    ? result.find((r) => r.id === rowId)
    : (result && result.id === rowId ? result : null)
  if (!match) return null
  return (
    <span
      className={`text-xs font-medium ${match.kind === 'success' ? 'text-accent' : 'text-rose-600'}`}
      data-testid={testid}
    >
      {match.message}
    </span>
  )
}
