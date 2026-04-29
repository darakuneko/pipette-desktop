// SPDX-License-Identifier: GPL-2.0-or-later
// Decides whether a key fill is "light" enough that the default label
// colour (`KEY_TEXT_COLOR`) would read poorly and text should be flipped
// to `--content-inverse`. The helper is intentionally a hard-coded table
// plus a single dynamic branch for heatmap HSL values: unknown fills are
// returned as `false` so callers keep the default label color. This
// matches the rule that new key colours must register themselves here
// explicitly rather than relying on a generic luminance formula.
//
// See `.claude/rules/coding-ui.md` (Key fill palette) for the rule.

import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'

/**
 * Registered fill values. Keys MUST match the literal strings exported
 * from `constants.ts` (CSS variable wrappers or hard-coded hex). Adding
 * a new key colour? Register it here too — the coding-ui rule requires
 * the pair to stay in sync.
 */
const FILL_INVERT_TABLE: Record<string, Record<EffectiveTheme, boolean>> = {
  // Neutral surfaces — default label reads fine.
  'var(--key-bg)': { light: false, dark: false },
  'var(--key-bg-hover)': { light: false, dark: false },
  'var(--key-mask-bg)': { light: false, dark: false },

  // Interactive states — rely on content-inverse so the accent fill
  // gets a contrasting label in both themes.
  'var(--key-bg-active)': { light: true, dark: true },
  'var(--accent-alt)': { light: true, dark: true },

  // Intermediate saturations — multi-selected blue reads OK with the
  // default label in both themes (light bg + dark text / mid bg + light
  // text); skip the invert.
  'var(--key-bg-multi-selected)': { light: false, dark: false },

  // Pressed green (`--success`) is bright in both themes. Light theme's
  // dark label still reads; dark theme's light label washes out on the
  // #34d399 fill so flip it.
  'var(--success)': { light: false, dark: true },

  // Ever-pressed is a fixed very-light green; same deal — dark theme's
  // light label disappears on it.
  '#ccffcc': { light: false, dark: true },
}

/** Parse the hue + lightness components out of an `hsl(h, s%, l%)`
 * string. Returns `null` for anything that isn't an HSL triple we
 * recognise. Saturation isn't needed for the inversion decision. */
function parseHslHueLightness(fill: string): { h: number; l: number } | null {
  const match = /^hsl\(\s*(-?[\d.]+)\s*,\s*[\d.]+%\s*,\s*([\d.]+)%\s*\)$/i.exec(fill)
  if (!match) return null
  const h = Number.parseFloat(match[1])
  const l = Number.parseFloat(match[2])
  if (!Number.isFinite(h) || !Number.isFinite(l)) return null
  return { h, l }
}

/** Hue range that counts as "red" for the special-case white label.
 * The wide-hue palette runs hue 220° (cool blue) → 0° (red); anything
 * inside ±30° of 0/360 reads as red so the warm tail gets the white
 * text the user expects from a heatmap. */
function isRedHue(hue: number): boolean {
  const normalised = ((hue % 360) + 360) % 360
  return normalised <= 30 || normalised >= 330
}

/**
 * Returns `true` when the default key label would be hard to read on
 * `fill` under `theme`, signalling the caller to swap in
 * `--content-inverse` instead.
 *
 * - Known fills come from `FILL_INVERT_TABLE` (light/dark pre-judged).
 * - HSL fills (heatmap ramp) use lightness thresholds chosen so the
 *   wide-hue palette in `renderer/utils/chart-palette.ts` gets a
 *   readable label across its whole range without false-flipping
 *   neutral zones.
 * - Anything else falls through to `false` — the rule is "don't touch
 *   colours we haven't vetted".
 */
export function shouldInvertText(
  fill: string | null | undefined,
  theme: EffectiveTheme,
): boolean {
  if (!fill) return false

  const known = FILL_INVERT_TABLE[fill]
  if (known) return known[theme]

  const hsl = parseHslHueLightness(fill)
  if (hsl !== null) {
    // Wide-hue palette fills (heatmap intensity, finger assignment)
    // default to a near-black label in both themes — the saturated
    // red tail is the only spot where a white label reads better, so
    // it's the only hue that flips to the lighter side. The XOR
    // captures both cases: light theme inverts (→ white) on red,
    // dark theme inverts everywhere except red (where the default
    // light label still reads on the red fill).
    return (theme === 'dark') !== isRedHue(hsl.h)
  }

  return false
}
