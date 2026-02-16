// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  hue: number
  saturation: number
  value: number
  onHueChange: (h: number) => void
  onSaturationChange: (s: number) => void
  onValueChange: (v: number) => void
  onColorChange?: (h: number, s: number, v: number) => void
}

interface PointerHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onLostPointerCapture: () => void
}

interface PaletteEntry {
  readonly h: number
  readonly s: number
  readonly v: number
  readonly hex: string
}

const HUE_GRADIENT =
  'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))'

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hDeg = (h / 255) * 360
  const sN = s / 255
  const vN = v / 255
  const c = vN * sN
  const x = c * (1 - Math.abs(((hDeg / 60) % 2) - 1))
  const m = vN - c
  let r1: number, g1: number, b1: number
  if (hDeg < 60) {
    ;[r1, g1, b1] = [c, x, 0]
  } else if (hDeg < 120) {
    ;[r1, g1, b1] = [x, c, 0]
  } else if (hDeg < 180) {
    ;[r1, g1, b1] = [0, c, x]
  } else if (hDeg < 240) {
    ;[r1, g1, b1] = [0, x, c]
  } else if (hDeg < 300) {
    ;[r1, g1, b1] = [x, 0, c]
  } else {
    ;[r1, g1, b1] = [c, 0, x]
  }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ]
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rN = r / 255
  const gN = g / 255
  const bN = b / 255
  const cmax = Math.max(rN, gN, bN)
  const cmin = Math.min(rN, gN, bN)
  const delta = cmax - cmin
  let hDeg: number
  if (delta === 0) hDeg = 0
  else if (cmax === rN) hDeg = 60 * (((gN - bN) / delta) % 6)
  else if (cmax === gN) hDeg = 60 * ((bN - rN) / delta + 2)
  else hDeg = 60 * ((rN - gN) / delta + 4)
  if (hDeg < 0) hDeg += 360
  const s = cmax === 0 ? 0 : delta / cmax
  return [
    Math.round((hDeg / 360) * 255),
    Math.round(s * 255),
    Math.round(cmax * 255),
  ]
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const match = hex.match(/^#?([0-9a-f]{6})$/i)
  if (!match) return null
  const v = parseInt(match[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

// 100-color palette: 10x10 grid (Vial-original / Qt QColorDialog style)
// Rows 0-8: Chromatic (pastel -> vivid -> dark, 9 rows x 10 hue cols = 90)
// Row 9: Grayscale (10 steps from white to black)
const PALETTE: ReadonlyArray<PaletteEntry> = (() => {
  const COLS = 10
  const HUE_STEP = 256 / COLS // avoid wrapping back to red at col 9

  function makeEntry(h: number, s: number, v: number): PaletteEntry {
    return { h, s, v, hex: rgbToHex(...hsvToRgb(h, s, v)) }
  }

  function makeRow(s: number, v: number): PaletteEntry[] {
    return Array.from({ length: COLS }, (_, col) =>
      makeEntry(Math.round(col * HUE_STEP), s, v),
    )
  }

  const chromaticRows: ReadonlyArray<{ s: number; v: number }> = [
    { s: 43, v: 255 }, // very pastel
    { s: 85, v: 255 }, // pastel
    { s: 128, v: 255 }, // light
    { s: 170, v: 255 }, // medium
    { s: 255, v: 255 }, // vivid
    { s: 255, v: 213 }, // slightly dark
    { s: 255, v: 170 }, // dark
    { s: 255, v: 128 }, // very dark
    { s: 255, v: 64 }, // extremely dark
  ]

  const grayscaleRow = Array.from({ length: COLS }, (_, col) =>
    makeEntry(0, 0, Math.round(255 - col * (255 / (COLS - 1)))),
  )

  return Object.freeze(chromaticRows.flatMap(({ s, v }) => makeRow(s, v)).concat(grayscaleRow))
})()

function usePointerDrag(
  ref: React.RefObject<HTMLDivElement | null>,
  onDrag: (clientX: number, clientY: number) => void,
): PointerHandlers {
  const draggingRef = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      draggingRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      onDrag(e.clientX, e.clientY)
    },
    [onDrag],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return
      onDrag(e.clientX, e.clientY)
    },
    [onDrag],
  )

  const stopDrag = useCallback(() => {
    draggingRef.current = false
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: stopDrag,
    onPointerCancel: stopDrag,
    onLostPointerCapture: stopDrag,
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampNormalized(value: number, origin: number, size: number): number {
  return clamp((value - origin) / size, 0, 1)
}

function toggleButtonClass(active: boolean): string {
  const base = 'rounded-md border px-3 py-1.5 text-[13px] transition-colors'
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}

type PickerMode = 'palette' | 'hsv'

export function HSVColorPicker({
  hue,
  saturation,
  value,
  onHueChange,
  onSaturationChange,
  onValueChange,
  onColorChange,
}: Props) {
  const { t } = useTranslation()
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<PickerMode>('palette')

  const hueDeg = (hue / 255) * 360

  const updateSV = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      onSaturationChange(Math.round(clampNormalized(clientX, rect.left, rect.width) * 255))
      onValueChange(Math.round((1 - clampNormalized(clientY, rect.top, rect.height)) * 255))
    },
    [onSaturationChange, onValueChange],
  )

  const updateHue = useCallback(
    (clientX: number, _clientY: number) => {
      const el = hueRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      onHueChange(Math.round(clampNormalized(clientX, rect.left, rect.width) * 255))
    },
    [onHueChange],
  )

  const svHandlers = usePointerDrag(svRef, updateSV)
  const hueHandlers = usePointerDrag(hueRef, updateHue)

  const hexStr = rgbToHex(...hsvToRgb(hue, saturation, value))

  // Nearest palette color index by HSV distance with circular hue
  const nearestIdx = useMemo(() => {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < PALETTE.length; i++) {
      const entry = PALETTE[i]
      // Use circular distance for hue, weighted down when saturation is low
      const rawDh = Math.abs(hue - entry.h)
      const dh = Math.min(rawDh, 255 - rawDh)
      // Hue is meaningless when either color is near-gray
      const hueWeight = Math.min(saturation, entry.s) / 255
      const ds = saturation - entry.s
      const dv = value - entry.v
      const dist = dh * dh * hueWeight + ds * ds + dv * dv
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }
    return bestIdx
  }, [hue, saturation, value])

  function applyHsv(h: number, s: number, v: number): void {
    if (onColorChange) {
      onColorChange(h, s, v)
    } else {
      onHueChange(h)
      onSaturationChange(s)
      onValueChange(v)
    }
  }

  return (
    <div className="flex w-[15rem] flex-col gap-3">
      {/* Mode toggle */}
      <div className="flex gap-1.5">
        <button
          type="button"
          className={toggleButtonClass(mode === 'palette')}
          onClick={() => setMode('palette')}
        >
          {t('editor.lighting.colorPicker.palette')}
        </button>
        <button
          type="button"
          className={toggleButtonClass(mode === 'hsv')}
          onClick={() => setMode('hsv')}
        >
          {t('editor.lighting.colorPicker.hsv')}
        </button>
      </div>

      {mode === 'palette' ? (
        <>
          {/* 10x10 Palette grid */}
          <div
            data-testid="palette-grid"
            className="grid grid-cols-[repeat(10,1.5rem)] gap-0"
          >
            {PALETTE.map((entry, i) => {
              const selected = i === nearestIdx
              return (
                <button
                  key={i}
                  type="button"
                  data-testid="palette-cell"
                  data-hsv={`${entry.h},${entry.s},${entry.v}`}
                  data-selected={selected || undefined}
                  className={
                    selected
                      ? 'relative z-10 h-6 w-6 rounded-none border-0 p-0 ring-2 ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]'
                      : 'h-6 w-6 rounded-none border-0 p-0'
                  }
                  style={{ backgroundColor: entry.hex }}
                  onClick={() => applyHsv(entry.h, entry.s, entry.v)}
                />
              )
            })}
          </div>

          {/* Color preview */}
          <div
            data-testid="color-preview"
            className="h-8 w-full rounded border border-edge"
            style={{ backgroundColor: hexStr }}
          />
        </>
      ) : (
        <>
          {/* Saturation-Value picker area */}
          <div
            ref={svRef}
            data-testid="sv-picker"
            className="relative h-[180px] cursor-crosshair rounded-lg"
            style={{
              background:
                'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
              backgroundColor: `hsl(${hueDeg}, 100%, 50%)`,
              touchAction: 'none',
            }}
            {...svHandlers}
          >
            <div
              className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{
                left: `${(saturation / 255) * 100}%`,
                top: `${(1 - value / 255) * 100}%`,
              }}
            />
          </div>

          {/* Hue slider bar */}
          <div
            ref={hueRef}
            data-testid="hue-bar"
            className="relative h-3 cursor-pointer rounded-full"
            style={{ background: HUE_GRADIENT, touchAction: 'none' }}
            {...hueHandlers}
          >
            <div
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{
                left: `${(hue / 255) * 100}%`,
                backgroundColor: `hsl(${hueDeg}, 100%, 50%)`,
              }}
            />
          </div>

          {/* Color preview */}
          <div
            data-testid="color-preview"
            className="h-8 w-full rounded border border-edge"
            style={{ backgroundColor: hexStr }}
          />
        </>
      )}
    </div>
  )
}
