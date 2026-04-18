// SPDX-License-Identifier: GPL-2.0-or-later
// Colour ramp for the typing-view heatmap overlay. Kept in its own
// module so the KeyWidget fill-priority chain stays readable and the
// ramp can be tweaked without touching the rest of the key renderer.

import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'

/** Maps a normalized 0-1 intensity to an HSL fill. 0 returns a soft
 * yellow tint; 1 returns a saturated red. Intensities above 1 are
 * clamped so the hottest key cannot go beyond full red. */
export function heatmapFill(intensity: number): string {
  const t = Math.max(0, Math.min(1, intensity))
  // Hue slides from yellow (60°) to red (0°). Lightness drops so the
  // high end reads as a filled red key rather than a washed-out tint.
  const hue = Math.round(60 - 60 * t)
  const saturation = 70
  const lightness = Math.round(80 - 30 * t)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

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
): string | null {
  if (!cells) return null
  const cell = cells.get(posKey)
  if (!cell) return null
  // Prefer the hold axis when this keyboard has ever seen a hold —
  // that's the "outer" rect's semantic. Plain keys fall back to the
  // total so the overlay still paints them.
  if (maxHold > 0 && cell.hold > 0) {
    return heatmapFill(cell.hold / maxHold)
  }
  if (maxTotal > 0 && cell.total > 0) {
    return heatmapFill(cell.total / maxTotal)
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
): string | null {
  if (!cells || maxTap <= 0) return null
  const cell = cells.get(posKey)
  if (!cell || cell.tap <= 0) return null
  return heatmapFill(cell.tap / maxTap)
}
