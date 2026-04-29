// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer-wide chart palette. Powers both the keyboard heatmap
// overlay (continuous intensity → colour) and the Analyze chart line /
// bar series colours (discrete index → colour). Two-layer split so the
// keyboard heatmap and chart series share a single tuned ramp without
// either side having to know the other exists.
//
// Palette: "wide-hue cool→warm" (hue 220° → 0°) with per-theme
// lightness so the ramp reads against both light and dark surfaces.
// The saturation/lightness constants come from the project palette
// spec — if you tweak them, keep `fill-luminance.ts`'s HSL thresholds
// in sync (see `.claude/rules/coding-ui.md`).

import type { EffectiveTheme } from '../hooks/useEffectiveTheme'

/** Below this transformed intensity the overlay is skipped so the
 * underlying surface shows through. The check runs after the sqrt
 * curve: 0.05 in t-space corresponds to 0.0025 of the raw max, so
 * any cell that ever received ≈0.25 % of the peak's hits still
 * paints a visible tint. */
export const PALETTE_MIN_T = 0.05

const HUE_START = 220
const HUE_RANGE = 220

const SAT_LIGHT = 60
const SAT_DARK = 65

// Light theme: 72% → 50% — keeps the cool end pale against the
// `#ffffff` key background, finishes at a saturated-but-not-washed red.
const L_LIGHT_START = 72
const L_LIGHT_RANGE = 22

// Dark theme: 65% → 50% — kept light enough that a near-black label
// (`--content-inverse` = #0f1117) reads on top of every step of the
// ramp. Drops from cool-blue 65% to warm-red 50% so the warmer end
// is still visibly more saturated than the cooler end.
const L_DARK_START = 65
const L_DARK_RANGE = 15

/** Builds the HSL string from a ramp position `t` ∈ [0,1] and theme.
 * Shared by both the intensity → fill path (with sqrt curve and
 * visibility floor applied first) and the series-index → colour path
 * (linear, no floor). Keeping the formula in one spot stops drift if
 * the saturation / lightness knobs ever get retuned. */
function hslFromRampT(t: number, theme: EffectiveTheme): string {
  const hue = Math.round(HUE_START - HUE_RANGE * t)
  const saturation = theme === 'light' ? SAT_LIGHT : SAT_DARK
  // Both themes decrease lightness from cool to warm so the saturated
  // end always reads as the "hotter" colour. Dark mode just starts /
  // ends at a higher lightness band so a near-black label remains
  // legible across the whole ramp.
  const lightness =
    theme === 'light'
      ? L_LIGHT_START - L_LIGHT_RANGE * t
      : L_DARK_START - L_DARK_RANGE * t
  // Round to one decimal so the string stays stable across renders
  // (avoids churn in React's diff of the `fill` attribute).
  const l = Math.round(lightness * 10) / 10
  return `hsl(${hue}, ${saturation}%, ${l}%)`
}

/** Maps a normalized 0-1 intensity to an HSL fill, or `null` when the
 * value is below the visibility floor. A sqrt (power = 0.5) curve
 * stretches the low-frequency tail so rare keys still tint visibly
 * while the top of the range compresses — standard treatment for the
 * power-law distribution of keystrokes. */
export function paletteColorFromIntensity(
  intensity: number,
  theme: EffectiveTheme,
): string | null {
  if (!Number.isFinite(intensity)) return null
  const t = Math.sqrt(Math.max(0, Math.min(1, intensity)))
  if (t < PALETTE_MIN_T) return null
  return hslFromRampT(t, theme)
}

/** Discrete chart-series colour. Series 0 lands on the cool end (blue),
 * series N-1 on the warm end (red), with the rest spaced evenly along
 * the same wide-hue ramp so every chart that adds an extra series gets
 * a deterministic, distinguishable colour without a per-chart palette
 * table. The Analyze tabs cap at 2 series today (Device-diff), but the
 * function generalises so a future N-way overlay drops in cleanly.
 *
 * Skips the visibility floor that gates `paletteColorFromIntensity` —
 * series 0 sits at `t = 0`, well below the floor, but it must still
 * paint a saturated cool colour for the chart to be readable. */
export function chartSeriesColor(
  index: number,
  total: number,
  theme: EffectiveTheme,
): string {
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0) {
    // Garbage in: paint the cool end through the shared formula so a
    // future palette retune doesn't strand this fallback in the old
    // colour space.
    return hslFromRampT(0, theme)
  }
  const clampedIndex = Math.min(Math.max(0, Math.floor(index)), total - 1)
  // Avoid t = NaN when the caller asks for a single-series colour.
  const t = total === 1 ? 0 : clampedIndex / (total - 1)
  return hslFromRampT(t, theme)
}
