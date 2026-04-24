// SPDX-License-Identifier: GPL-2.0-or-later
// Colour ramp for the typing-view heatmap overlay. Kept in its own
// module so the KeyWidget fill-priority chain stays readable and the
// ramp can be tweaked without touching the rest of the key renderer.
//
// Palette: "wide-hue cool→warm" (hue 220°→0°) with per-theme lightness
// so the ramp reads against both light and dark key backgrounds. The
// saturation/lightness constants come from the project palette spec —
// if you tweak them, keep `fill-luminance.ts`'s HSL thresholds in sync
// (see `.claude/rules/coding-ui.md`).

import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'

/** Below this transformed intensity the overlay is skipped so the
 * default key background shows through. The check runs after the
 * sqrt curve: 0.05 in t-space corresponds to 0.0025 of the raw max,
 * so any key that ever received ≈0.25 % of the peak's hits still
 * paints a visible tint. */
const HEATMAP_MIN_T = 0.05

const HUE_START = 220 // cool end (blue)
const HUE_RANGE = 220 // slides to 0° (red) at t=1

const SAT_LIGHT = 60
const SAT_DARK = 65

// Light theme: 72% → 50% — keeps the cool end pale against the
// `#ffffff` key background, finishes at a saturated-but-not-washed red.
const L_LIGHT_START = 72
const L_LIGHT_RANGE = 22

// Dark theme: 32% → 48% — starts deep against the `#262b3a` key
// background, stays under 50% so light labels keep enough contrast.
const L_DARK_START = 32
const L_DARK_RANGE = 16

/** Maps a normalized 0-1 intensity to an HSL fill, or `null` when the
 * value is below the visibility floor. A sqrt (power = 0.5) curve
 * stretches the low-frequency tail so rare keys still tint visibly
 * while the top of the range compresses — standard treatment for the
 * power-law distribution of keystrokes. */
export function heatmapFill(
  intensity: number,
  theme: EffectiveTheme,
): string | null {
  if (!Number.isFinite(intensity)) return null
  const t = Math.sqrt(Math.max(0, Math.min(1, intensity)))
  if (t < HEATMAP_MIN_T) return null
  const hue = Math.round(HUE_START - HUE_RANGE * t)
  const saturation = theme === 'light' ? SAT_LIGHT : SAT_DARK
  const lightness =
    theme === 'light'
      ? L_LIGHT_START - L_LIGHT_RANGE * t
      : L_DARK_START + L_DARK_RANGE * t
  // Round to one decimal so the string stays stable across renders
  // (avoids churn in React's diff of the `fill` attribute).
  const l = Math.round(lightness * 10) / 10
  return `hsl(${hue}, ${saturation}%, ${l}%)`
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
  theme: EffectiveTheme,
): string | null {
  if (!cells) return null
  const cell = cells.get(posKey)
  if (!cell) return null
  // Prefer the hold axis when this keyboard has ever seen a hold —
  // that's the "outer" rect's semantic. Plain keys fall back to the
  // total so the overlay still paints them.
  if (maxHold > 0 && cell.hold > 0) {
    return heatmapFill(cell.hold / maxHold, theme)
  }
  if (maxTotal > 0 && cell.total > 0) {
    return heatmapFill(cell.total / maxTotal, theme)
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
  return heatmapFill(cell.tap / maxTap, theme)
}
