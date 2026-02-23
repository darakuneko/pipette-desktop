// SPDX-License-Identifier: GPL-2.0-or-later
// Shared utility to filter visible keys based on layout options

import type { KleKey } from './types'

/** Whether the key has a secondary rectangle (stepped, ISO enter, etc.) */
function hasSecondaryRect(key: KleKey): boolean {
  return (
    key.width2 !== key.width || key.height2 !== key.height ||
    key.x2 !== 0 || key.y2 !== 0
  )
}

/**
 * Compute the visual bounding-box min corner of a key, accounting for rotation.
 * Matches Python keyboard_widget.py which uses polygon.boundingRect().topLeft().
 */
function visualMinPos(key: KleKey): { x: number; y: number } {
  // Collect corners of the primary rectangle
  const corners: [number, number][] = [
    [key.x, key.y],
    [key.x + key.width, key.y],
    [key.x + key.width, key.y + key.height],
    [key.x, key.y + key.height],
  ]
  if (hasSecondaryRect(key)) {
    corners.push(
      [key.x + key.x2, key.y + key.y2],
      [key.x + key.x2 + key.width2, key.y + key.y2],
      [key.x + key.x2 + key.width2, key.y + key.y2 + key.height2],
      [key.x + key.x2, key.y + key.y2 + key.height2],
    )
  }

  // Rotate all corners around (rotationX, rotationY) and find the minimum
  const rad = (key.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = key.rotationX
  const cy = key.rotationY
  let minX = Infinity
  let minY = Infinity
  for (const [px, py] of corners) {
    const dx = px - cx
    const dy = py - cy
    const rx = cx + dx * cos - dy * sin
    const ry = cy + dx * sin + dy * cos
    if (rx < minX) minX = rx
    if (ry < minY) minY = ry
  }
  return { x: minX, y: minY }
}

/**
 * Reposition selected layout option keys to align with option 0's position.
 * Matches Vial GUI keyboard_widget.py:306-338.
 *
 * IMPORTANT: Call on UNFILTERED keys (including all options) so that
 * option 0's min position can be computed. Filter AFTER repositioning.
 */
export function repositionLayoutKeys(
  keys: KleKey[],
  layoutOptions: Map<number, number>,
): KleKey[] {
  if (layoutOptions.size === 0) return keys

  // Phase 1: Compute visual min (x, y) per (layoutIndex, layoutOption) pair.
  // Uses bounding box after rotation (matching Python's polygon.boundingRect()).
  const minPos = new Map<string, { x: number; y: number }>()
  for (const key of keys) {
    if (key.layoutIndex < 0) continue
    const id = `${key.layoutIndex},${key.layoutOption}`
    const vMin = visualMinPos(key)
    const cur = minPos.get(id)
    if (!cur) {
      minPos.set(id, { x: vMin.x, y: vMin.y })
    } else {
      if (vMin.x < cur.x) cur.x = vMin.x
      if (vMin.y < cur.y) cur.y = vMin.y
    }
  }

  // Phase 2: Check if any selected option != 0 (early exit if no shifts needed)
  let needsShift = false
  for (const [, opt] of layoutOptions) {
    if (opt !== 0) { needsShift = true; break }
  }
  if (!needsShift) return keys

  // Phase 3: Shift selected option keys to align with option 0
  let changed = false
  const result = keys.map((key) => {
    if (key.layoutIndex < 0) return key
    const selectedOpt = layoutOptions.get(key.layoutIndex) ?? 0
    if (selectedOpt === 0) return key
    if (key.layoutOption !== selectedOpt) return key

    const opt0Min = minPos.get(`${key.layoutIndex},0`)
    const optMin = minPos.get(`${key.layoutIndex},${selectedOpt}`)
    if (!opt0Min || !optMin) return key

    const dx = opt0Min.x - optMin.x
    const dy = opt0Min.y - optMin.y
    if (dx === 0 && dy === 0) return key

    changed = true
    return {
      ...key,
      x: key.x + dx,
      y: key.y + dy,
      rotationX: key.rotationX + dx,
      rotationY: key.rotationY + dy,
    }
  })

  return changed ? result : keys
}

export function filterVisibleKeys(
  keys: KleKey[],
  layoutOptions: Map<number, number>,
): KleKey[] {
  return keys.filter((key) => {
    if (key.decal) return false
    if (key.layoutIndex < 0) return true
    // Match KeyboardWidget: skip layout filtering when no options are set
    if (layoutOptions.size === 0) return true
    const selectedOption = layoutOptions.get(key.layoutIndex)
    if (selectedOption === undefined) return key.layoutOption === 0
    return key.layoutOption === selectedOption
  })
}
