// SPDX-License-Identifier: GPL-2.0-or-later
// Per-cell heatmap fills for the typing-view overlay. Kept next to the
// KeyWidget renderer so the fill-priority chain stays readable. Colour
// math lives in `renderer/utils/chart-palette.ts`; this module only
// resolves which intensity to feed it for a given cell.

import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'
import { paletteColorFromIntensity } from '../../utils/chart-palette'

/** Fill for the outer (hold) rect of a masked LT/MT key — or the sole
 * rect of a non-tap-hold key. Falls back to the total count when the
 * hold axis is empty so a keyboard that has seen no hold resolutions
 * yet still paints a meaningful overlay for plain keys. Returns `null`
 * when the cell has no data at all, letting the KeyWidget skip the
 * heatmap layer and fall through to the default key background. */
export function outerHeatmapFillForCell(
  cells: Map<string, TypingHeatmapCell> | null | undefined,
  maxHold: number,
  maxTotal: number,
  posKey: string,
  theme: EffectiveTheme,
): string | null {
  if (!cells) return null
  const cell = cells.get(posKey)
  if (!cell) return null
  // Prefer the hold axis when this keyboard has ever seen a hold —
  // that's the "outer" rect's semantic. Plain keys fall back to the
  // total so the overlay still paints them.
  if (maxHold > 0 && cell.hold > 0) {
    return paletteColorFromIntensity(cell.hold / maxHold, theme)
  }
  if (maxTotal > 0 && cell.total > 0) {
    return paletteColorFromIntensity(cell.total / maxTotal, theme)
  }
  return null
}

/** Fill for the inner (tap) rect of a masked LT/MT key. Only paints
 * when there is a tap to show — the inner rect's mask-colour default
 * remains visible when the cell never resolved to a tap. */
export function innerHeatmapFillForCell(
  cells: Map<string, TypingHeatmapCell> | null | undefined,
  maxTap: number,
  posKey: string,
  theme: EffectiveTheme,
): string | null {
  if (!cells || maxTap <= 0) return null
  const cell = cells.get(posKey)
  if (!cell || cell.tap <= 0) return null
  return paletteColorFromIntensity(cell.tap / maxTap, theme)
}
