// SPDX-License-Identifier: GPL-2.0-or-later

import type { KleKey } from '../../../shared/kle/types'

/** Rotate point (px, py) by `angle` degrees around center (cx, cy). */
export function rotatePoint(
  px: number,
  py: number,
  angle: number,
  cx: number,
  cy: number,
): [number, number] {
  const rad = (angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

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
  const has2 =
    key.width2 !== key.width ||
    key.height2 !== key.height ||
    key.x2 !== 0 ||
    key.y2 !== 0
  if (has2) {
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
