// SPDX-License-Identifier: GPL-2.0-or-later

import { KEY_SELECTED_COLOR } from './constants'
import type { Props } from './key-widget-types'

interface KeyFlashOverlayProps {
  flashed: Props['flashed']
  unionPath: string
  flashGeneration: Props['flashGeneration']
  x: number
  y: number
  w: number
  h: number
  corner: number
  flashElapsedMs: number
  outerStroke: string
  outerStrokeWidth: number
}

export function KeyFlashOverlay({
  flashed,
  unionPath,
  flashGeneration,
  x,
  y,
  w,
  h,
  corner,
  flashElapsedMs,
  outerStroke,
  outerStrokeWidth,
}: KeyFlashOverlayProps) {
  return (
    <>
      {/* Post-rewrite flash overlay (Key Label "apply to keymap" bulk
          rewrite): painted on top of the outer fill/stroke above but
          below the inner mask rect and label text (both rendered later
          in the same `<g>` in KeyWidget.tsx), matching its geometry
          (including the union path for stepped/ISO keys) so it never
          leaks past the key's own face. Opacity is driven purely by the
          `key-flash` CSS keyframe (style.css) — mounted only while
          `flashed` is true; KeymapEditor keeps it mounted for the
          keyframe's full duration before clearing the flag.
          `key={flashGeneration}` forces a fresh DOM node (and thus a
          restarted animation) on a re-apply that lands while this
          position is already flashing. The negative `animation-delay`
          (`flashElapsedMs`, computed in KeyWidget.tsx) syncs a
          late-mounted overlay to the SAME fade as everyone else's. */}
      {flashed && (
        unionPath ? (
          <path
            key={flashGeneration}
            data-testid="flash-overlay"
            className="key-flash-overlay"
            d={unionPath}
            fill={KEY_SELECTED_COLOR}
            style={{ pointerEvents: 'none', animationDelay: `-${flashElapsedMs}ms` }}
          />
        ) : (
          <rect
            key={flashGeneration}
            data-testid="flash-overlay"
            className="key-flash-overlay"
            x={x}
            y={y}
            width={w}
            height={h}
            rx={corner}
            ry={corner}
            fill={KEY_SELECTED_COLOR}
            style={{ pointerEvents: 'none', animationDelay: `-${flashElapsedMs}ms` }}
          />
        )
      )}

      {/* Flash overlay's border redraw: the overlay above paints its full
          opaque fill on top of the outer stroke too, so without this the
          key's border would look "cut" wherever the overlay covers its
          inner half. A stroke-only copy of the SAME outer shape (no
          fill, same stroke/width) redrawn immediately on top keeps the
          border crisp for the whole flash without needing separate inset
          math for the union-path (stepped/ISO) case. */}
      {flashed && (
        unionPath ? (
          <path
            data-testid="flash-overlay-border"
            d={unionPath}
            fill="none"
            stroke={outerStroke}
            strokeWidth={outerStrokeWidth}
            style={{ pointerEvents: 'none' }}
          />
        ) : (
          <rect
            data-testid="flash-overlay-border"
            x={x}
            y={y}
            width={w}
            height={h}
            rx={corner}
            ry={corner}
            fill="none"
            stroke={outerStroke}
            strokeWidth={outerStrokeWidth}
            style={{ pointerEvents: 'none' }}
          />
        )
      )}
    </>
  )
}
