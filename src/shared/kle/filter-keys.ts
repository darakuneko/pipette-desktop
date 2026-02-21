// SPDX-License-Identifier: GPL-2.0-or-later
// Shared utility to filter visible keys based on layout options

import type { KleKey } from './types'

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

  // Phase 1: Compute min (x, y) per (layoutIndex, layoutOption) pair
  const minPos = new Map<string, { x: number; y: number }>()
  for (const key of keys) {
    if (key.layoutIndex < 0) continue
    const id = `${key.layoutIndex},${key.layoutOption}`
    const cur = minPos.get(id)
    if (!cur) {
      minPos.set(id, { x: key.x, y: key.y })
    } else {
      if (key.x < cur.x) cur.x = key.x
      if (key.y < cur.y) cur.y = key.y
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
