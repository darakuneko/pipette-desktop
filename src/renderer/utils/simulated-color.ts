// SPDX-License-Identifier: GPL-2.0-or-later
//
// Auto-derives the "simulated" remap tint (permutation-pack Display Only
// legends) from a theme's own "actual" remap tint (`key-label-remap`) when
// a theme pack does not define `key-label-simulated` explicitly. Rotating
// the hue 180° keeps the derived colour visually distinct from the actual
// tint while still reading as "related" to the pack's own palette, rather
// than falling back to an unrelated fixed colour for every custom theme.

import type { ThemeColorScheme } from '../../shared/types/theme-store'

/** Built-in simulated-color default, used whenever the source colour is
 *  unparseable or too close to grey (achromatic) for a hue rotation to
 *  produce a meaningfully different result. Matches the `--key-label-
 *  simulated` defaults in `style.css`. */
export const DEFAULT_SIMULATED_COLOR: Record<ThemeColorScheme, string> = {
  light: '#9333ea',
  dark: '#c084fc',
}

/** Below this saturation the source colour is treated as achromatic (grey/
 *  black/white) — a hue rotation on a colour with no hue to speak of would
 *  just return the same grey, so this falls back to the fixed default
 *  instead. */
const ACHROMATIC_SATURATION_THRESHOLD = 10

/** Light theme clamp: keeps the derived tint dark enough to read against
 *  light key-cap backgrounds. Dark theme clamp: keeps it light enough to
 *  read against dark key-cap backgrounds. */
const LIGHT_MAX_LIGHTNESS = 50
const DARK_MIN_LIGHTNESS = 60

interface Hsl {
  h: number
  s: number
  l: number
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, n))
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = clampChannel(r) / 255
  const gn = clampChannel(g) / 255
  const bn = clampChannel(b) / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case rn:
        h = 60 * (((gn - bn) / d) % 6)
        break
      case gn:
        h = 60 * ((bn - rn) / d + 2)
        break
      default:
        h = 60 * ((rn - gn) / d + 4)
    }
  }
  if (h < 0) h += 360
  return { h, s: s * 100, l: l * 100 }
}

function hslToHex({ h, s, l }: Hsl): string {
  const sn = Math.max(0, Math.min(100, s)) / 100
  const ln = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = ln - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const toHex = (v: number): string => clampChannel(Math.round((v + m) * 255)).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function parseHex(value: string): Hsl | null {
  let hex = value.slice(1)
  if (hex.length === 3 || hex.length === 4) {
    hex = hex.split('').map((c) => c + c).join('')
  }
  if (hex.length !== 6 && hex.length !== 8) return null
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return null
  return rgbToHsl(r, g, b)
}

/** Splits the inner content of an `rgb()`/`hsl()` function call into its
 *  component tokens, accepting both the classic comma-separated form
 *  (`rgb(255, 0, 0)`) and the modern space-separated form with an optional
 *  `/ alpha` suffix (`rgb(255 0 0 / 50%)`). */
function splitFunctionArgs(inner: string): string[] {
  return inner.split('/')[0].trim().split(/[\s,]+/).filter(Boolean)
}

function parsePercentOr255(token: string): number {
  return token.endsWith('%') ? (parseFloat(token) / 100) * 255 : parseFloat(token)
}

function parseRgbFunction(value: string): Hsl | null {
  const match = value.match(/^rgba?\(([^)]+)\)$/i)
  if (!match) return null
  const parts = splitFunctionArgs(match[1])
  if (parts.length < 3) return null
  const [r, g, b] = parts.slice(0, 3).map(parsePercentOr255)
  if ([r, g, b].some((n) => Number.isNaN(n))) return null
  return rgbToHsl(r, g, b)
}

function parseHslFunction(value: string): Hsl | null {
  const match = value.match(/^hsla?\(([^)]+)\)$/i)
  if (!match) return null
  const parts = splitFunctionArgs(match[1])
  if (parts.length < 3) return null
  const h = parseFloat(parts[0])
  const s = parseFloat(parts[1])
  const l = parseFloat(parts[2])
  if ([h, s, l].some((n) => Number.isNaN(n))) return null
  return { h: ((h % 360) + 360) % 360, s, l }
}

/** Parses a CSS colour string (`#hex` in 3/4/6/8-digit form, `rgb()`/
 *  `rgba()`, or `hsl()`/`hsla()`) into HSL. Returns null for anything else
 *  (named colours, unparseable input) so the caller can fall back to the
 *  fixed default. */
function parseColor(value: string): Hsl | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('#')) return parseHex(trimmed)
  if (/^rgba?\(/i.test(trimmed)) return parseRgbFunction(trimmed)
  if (/^hsla?\(/i.test(trimmed)) return parseHslFunction(trimmed)
  return null
}

/** Derives the "simulated" remap tint from a theme's "actual" remap tint
 *  (`key-label-remap`) by rotating hue 180° and clamping lightness for
 *  readability. Falls back to `DEFAULT_SIMULATED_COLOR[mode]` when the
 *  source colour is unparseable or achromatic (a hue rotation on a
 *  colour with no hue would just return the same grey). */
export function deriveSimulatedColor(remapColor: string, mode: ThemeColorScheme): string {
  const hsl = parseColor(remapColor)
  if (!hsl || hsl.s < ACHROMATIC_SATURATION_THRESHOLD) return DEFAULT_SIMULATED_COLOR[mode]
  const rotatedHue = (hsl.h + 180) % 360
  const clampedLightness = mode === 'light'
    ? Math.min(hsl.l, LIGHT_MAX_LIGHTNESS)
    : Math.max(hsl.l, DARK_MIN_LIGHTNESS)
  return hslToHex({ h: rotatedHue, s: hsl.s, l: clampedLightness })
}
