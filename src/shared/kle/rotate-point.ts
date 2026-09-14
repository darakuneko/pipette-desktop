// SPDX-License-Identifier: GPL-2.0-or-later

/** Rotate point (px, py) by `angle` degrees around center (cx, cy). Shared
 *  by the PDF export geometry and the renderer's key-placement geometry so
 *  both stay byte-for-byte identical. */
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
