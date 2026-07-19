// SPDX-License-Identifier: GPL-2.0-or-later

import type { PackActionResult } from './pack-modal-types'

export interface PackResultBadgeProps {
  result: PackActionResult | null
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
  if (!result || result.id !== rowId) return null
  return (
    <span
      className={`text-xs font-medium ${result.kind === 'success' ? 'text-accent' : 'text-rose-600'}`}
      data-testid={testid}
    >
      {result.message}
    </span>
  )
}
