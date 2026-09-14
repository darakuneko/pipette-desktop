// SPDX-License-Identifier: GPL-2.0-or-later

import type { KleKey } from '../../../shared/kle/types'
import { hasSecondaryRect } from '../../../shared/kle/filter-keys'
import { rotatePoint } from '../../../shared/kle/rotate-point'
import { KEY_UNIT, KEY_SPACING } from './constants'

/** Compute bounding-box corners of a key (both rects), accounting for rotation. */
export function keyCorners(
  key: KleKey,
  s: number,
  spacing: number,
): [number, number][] {
  const x0 = s * key.x
  const y0 = s * key.y
  const x1 = s * (key.x + key.width) - spacing
  const y1 = s * (key.y + key.height) - spacing
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  // Include secondary rect corners for stepped/ISO keys
  if (hasSecondaryRect(key)) {
    const sx0 = x0 + s * key.x2
    const sy0 = y0 + s * key.y2
    const sx1 = s * (key.x + key.x2 + key.width2) - spacing
    const sy1 = s * (key.y + key.y2 + key.height2) - spacing
    corners.push([sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1])
  }
  if (key.rotation === 0) return corners
  const cx = s * key.rotationX
  const cy = s * key.rotationY
  return corners.map(([px, py]) => rotatePoint(px, py, key.rotation, cx, cy))
}

/** A key's own rotated center point. Always the main rect's center, even
 *  for stepped/ISO keys with a secondary rect. */
export function keyCenter(key: KleKey, scale: number): { x: number; y: number } {
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale
  const cx = s * (key.x + key.width / 2) - spacing / 2
  const cy = s * (key.y + key.height / 2) - spacing / 2
  if (key.rotation === 0) return { x: cx, y: cy }
  const [x, y] = rotatePoint(cx, cy, key.rotation, s * key.rotationX, s * key.rotationY)
  return { x, y }
}
