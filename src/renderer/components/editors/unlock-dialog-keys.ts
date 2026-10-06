// SPDX-License-Identifier: GPL-2.0-or-later

import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { filterVisibleKeys } from '../../../shared/kle/filter-keys'

export interface UnlockKeyView {
  highlightedKeys: Set<string>
  /** Unlock positions with no drawable key in the layout, in unlock-key order. */
  missing: [number, number][]
  /** Layout options for the dialog's keyboard only; never written back to the device or settings. */
  displayOptions: Map<number, number> | undefined
}

/**
 * Decide what the unlock dialog draws so every unlock key the layout has is visible.
 *
 * An unlock key hidden by the selected layout option gets its group switched to that
 * key's option. A group is left alone when its selected option already shows an unlock
 * key (switching would hide it), and when several hidden unlock keys need different
 * options of one group, the first in `unlockKeys` order wins.
 */
export function computeUnlockKeyView(
  keys: KleKey[],
  unlockKeys: [number, number][],
  layoutOptions: Map<number, number> | undefined,
): UnlockKeyView {
  const highlightedKeys = new Set(unlockKeys.map(([row, col]) => posKey(row, col)))

  // Encoders keep row/col 0,0 from the KLE parser (parseKeyLabels in
  // kle-parser.ts) and decals are never drawn, so neither can stand in for a matrix position.
  const candidates = keys.filter((k) => !k.decal && k.encoderIdx < 0)
  const candidatePositions = new Set(candidates.map((k) => posKey(k.row, k.col)))

  // With no layout loaded yet every position would look missing.
  const missing = keys.length === 0
    ? []
    : unlockKeys.filter(([row, col]) => !candidatePositions.has(posKey(row, col)))

  // Empty options mean every key is shown; setting one group would narrow all the
  // others to option 0 and hide keys.
  if (!layoutOptions || layoutOptions.size === 0) {
    return { highlightedKeys, missing, displayOptions: layoutOptions }
  }

  const visiblePositions = new Set<string>()
  const pinnedGroups = new Set<number>()
  for (const k of filterVisibleKeys(candidates, layoutOptions)) {
    const pos = posKey(k.row, k.col)
    visiblePositions.add(pos)
    if (k.layoutIndex >= 0 && highlightedKeys.has(pos)) pinnedGroups.add(k.layoutIndex)
  }

  let displayOptions: Map<number, number> | undefined
  for (const [row, col] of unlockKeys) {
    const pos = posKey(row, col)
    if (visiblePositions.has(pos)) continue
    const key = candidates.find((k) => posKey(k.row, k.col) === pos && !pinnedGroups.has(k.layoutIndex))
    if (!key) continue
    displayOptions ??= new Map(layoutOptions)
    displayOptions.set(key.layoutIndex, key.layoutOption)
    pinnedGroups.add(key.layoutIndex)
  }

  return { highlightedKeys, missing, displayOptions: displayOptions ?? layoutOptions }
}
