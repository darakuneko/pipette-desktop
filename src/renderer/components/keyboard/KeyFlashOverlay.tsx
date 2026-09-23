// SPDX-License-Identifier: GPL-2.0-or-later

import type { Key, SVGAttributes } from 'react'
import { KEY_SELECTED_COLOR } from './constants'

/** Outline both overlay layers are drawn with: the union path of a
 *  stepped/ISO key, a plain key's rect, or an encoder's circle. */
export type FlashShape =
  | { kind: 'path'; d: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; corner: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }

interface KeyFlashOverlayProps {
  shape: FlashShape
  flashGeneration: number | undefined
  flashElapsedMs: number
  outerStroke: string
  outerStrokeWidth: number
}

type LayerAttributes = SVGAttributes<SVGElement> & { 'data-testid': string }

function drawShape(shape: FlashShape, attributes: LayerAttributes, key?: Key) {
  switch (shape.kind) {
    case 'path':
      return <path key={key} d={shape.d} {...attributes} />
    case 'rect':
      return (
        <rect
          key={key}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.corner}
          ry={shape.corner}
          {...attributes}
        />
      )
    case 'circle':
      return <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} {...attributes} />
  }
}

export function KeyFlashOverlay({
  shape,
  flashGeneration,
  flashElapsedMs,
  outerStroke,
  outerStrokeWidth,
}: KeyFlashOverlayProps) {
  return (
    <>
      {/* Post-rewrite flash overlay (Key Label "apply to keymap" bulk
          rewrite, undo/redo): painted on top of the caller's outer
          fill/stroke but below its inner mask rect and label text, matching
          the outer shape so it never leaks past the key's own face. Opacity
          is driven purely by the `key-flash` CSS keyframe (style.css). The
          caller mounts this only while its `flashed` flag is set, and
          KeymapEditor keeps that flag set for the keyframe's full duration.
          `key={flashGeneration}` forces a fresh DOM node (and thus a
          restarted animation) on a re-apply that lands while this position
          is already flashing. The negative `animation-delay`
          (`flashElapsedMs`, computed by the caller) syncs a late-mounted
          overlay to the SAME fade as everyone else's. */}
      {drawShape(
        shape,
        {
          'data-testid': 'flash-overlay',
          className: 'key-flash-overlay',
          fill: KEY_SELECTED_COLOR,
          style: { pointerEvents: 'none', animationDelay: `-${flashElapsedMs}ms` },
        },
        flashGeneration,
      )}

      {/* Border redraw: the overlay above paints its full opaque fill on
          top of the outer stroke too, so without this the border would
          look "cut" wherever the overlay covers its inner half. A
          stroke-only copy of the SAME outer shape (no fill, same
          stroke/width) redrawn immediately on top keeps the border crisp
          for the whole flash without separate inset math for the union
          path. It carries no `key`, so a re-apply keeps this node. */}
      {drawShape(shape, {
        'data-testid': 'flash-overlay-border',
        fill: 'none',
        stroke: outerStroke,
        strokeWidth: outerStrokeWidth,
        style: { pointerEvents: 'none' },
      })}
    </>
  )
}
