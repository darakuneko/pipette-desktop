// SPDX-License-Identifier: GPL-2.0-or-later
// Display helpers shared between the Bigrams Top / Slow / Heatmap
// views. Numeric keycode pair ids are decoded to human-readable
// labels via the keycodes utility, with a raw-id fallback so a partial
// decode still surfaces actionable rows.

import { codeToLabel } from '../../../shared/keycodes/keycodes'

/** Convert a stored bigram pair id like `"4_11"` into a display label
 * such as `"A → H"`. Falls back to the raw id when either side is not
 * a finite number, so the renderer never throws on schema drift. */
export function bigramPairLabel(bigramId: string): string {
  const parts = bigramId.split('_')
  if (parts.length !== 2) return bigramId
  const [prevStr, currStr] = parts
  // Reject empty halves explicitly: `Number('')` coerces to 0 rather
  // than NaN, which would otherwise label `"4_"` as `"A → "` instead
  // of returning the raw id.
  if (prevStr.length === 0 || currStr.length === 0) return bigramId
  const prev = Number(prevStr)
  const curr = Number(currStr)
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return bigramId
  return `${codeToLabel(prev)} → ${codeToLabel(curr)}`
}
