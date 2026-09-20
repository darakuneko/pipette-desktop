// SPDX-License-Identifier: GPL-2.0-or-later

import { type Keycode, getAvailableLMMods } from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { KeycodeCategory } from './categories'
import { getShiftedKeycode } from './SplitKey'

export interface KeycodeIndexEntry { baseIdx: number; shiftedIdx?: number }

/** Expand a flat list of base keycodes: shifted first, then all in original order.
 *  Also builds an index map keyed by base qmkId. */
export function expandGrouped(
  keycodes: Keycode[],
  startIdx: number,
  indexMap: Map<string, KeycodeIndexEntry>,
): Keycode[] {
  let idx = startIdx
  const shiftedPairs: { shifted: Keycode; baseQmkId: string; shiftedIdx: number }[] = []
  for (const kc of keycodes) {
    const s = getShiftedKeycode(kc.qmkId)
    if (s) shiftedPairs.push({ shifted: s, baseQmkId: kc.qmkId, shiftedIdx: idx++ })
  }
  const expanded: Keycode[] = shiftedPairs.map((p) => p.shifted)
  for (const kc of keycodes) {
    const pair = shiftedPairs.find((p) => p.baseQmkId === kc.qmkId)
    indexMap.set(kc.qmkId, { baseIdx: idx, shiftedIdx: pair?.shiftedIdx })
    expanded.push(kc)
    idx++
  }
  return expanded
}

/** Expand layout keycodes per physical row using KLE positions.
 *  For each row: shifted in X order, then ALL keys in X order.
 *  Also builds an index map keyed by base qmkId. */
export function expandPerRow(
  keycodes: Keycode[],
  kleData: unknown[][],
  startIdx: number,
  indexMap: Map<string, KeycodeIndexEntry>,
): Keycode[] {
  const kle = parseKle(kleData)
  const kcSet = new Set(keycodes.map((k) => k.qmkId))
  const rows = new Map<number, { kc: Keycode; x: number }[]>()
  for (const key of kle.keys) {
    const qmkId = key.labels[0]
    if (!qmkId || !kcSet.has(qmkId)) continue
    const kc = keycodes.find((k) => k.qmkId === qmkId)
    if (!kc) continue
    const y = Math.round(key.y * 2) / 2
    if (!rows.has(y)) rows.set(y, [])
    rows.get(y)!.push({ kc, x: key.x })
  }

  let idx = startIdx
  const expanded: Keycode[] = []
  const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0])
  for (const [, keys] of sortedRows) {
    keys.sort((a, b) => a.x - b.x)
    // Record shifted indices first
    const shiftedMap = new Map<string, number>() // baseQmkId → shiftedIdx
    for (const k of keys) {
      const shifted = getShiftedKeycode(k.kc.qmkId)
      if (shifted) {
        shiftedMap.set(k.kc.qmkId, idx)
        expanded.push(shifted)
        idx++
      }
    }
    // Base line: ALL keys in X order
    for (const k of keys) {
      indexMap.set(k.kc.qmkId, { baseIdx: idx, shiftedIdx: shiftedMap.get(k.kc.qmkId) })
      expanded.push(k.kc)
      idx++
    }
  }
  return expanded
}

export const LM_CATEGORY: KeycodeCategory = {
  id: 'lm-mods',
  labelKey: 'keycodes.modifiers',
  getKeycodes: getAvailableLMMods,
}

// Shared bubble contract: 8px
// offset, `computeBubblePosition` viewport clamping, `BUBBLE_BASE` skin,
// 300ms open delay via `useSharedHoverBubble`. A canonicalized shared
// bubble rather than per-key `Tooltip` wraps — every category's key grid
// mounts simultaneously (inactive tabs stay in the DOM, just visually
// hidden, to keep tab-switch instant and preserve scroll position), so a
// per-key `Tooltip` would multiply its portal + effects across hundreds
// of tiles that are never all visible at once.
export interface TooltipState {
  keycode: Keycode
  rect: DOMRect
}

export interface Props {
  onKeycodeSelect?: (keycode: Keycode) => void
  onKeycodeDoubleClick?: (keycode: Keycode) => void
  onConfirm?: () => void // Confirm current selection (Enter key)
  onKeycodeMultiSelect?: (index: number, keycode: number, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodeNumbers: number[]) => void
  pickerSelectedIndices?: Set<number>
  pickerMultiSelectEnabled?: boolean
  onBackgroundClick?: () => void
  onTabChange?: () => void
  onClose?: () => void
  highlightedKeycodes?: Set<string>
  maskOnly?: boolean // When true, only show keycodes with value < 0xFF (for mask inner byte editing)
  lmMode?: boolean  // When true, show MOD_* keycodes for LM inner editing
  tabFooterContent?: Record<string, React.ReactNode> // Tab-specific footer content keyed by tab ID
  tabBarRight?: React.ReactNode // Content rendered at the right end of the tab bar
  panelOverlay?: React.ReactNode // Content rendered as a right-side overlay over the keycodes grid
  showHint?: boolean // Show multi-select usage hint at the bottom
  keyboardPickerContent?: React.ReactNode // Keyboard layout picker shown in a "Keyboard" tab
  tabContentOverride?: Record<string, React.ReactNode> // Custom content that replaces the keycode grid for specific tabs
  basicViewType?: BasicViewType // View type for the basic tab
  onBasicViewTypeChange?: (v: BasicViewType) => void
  splitKeyMode?: SplitKeyMode // 'split' (default) or 'flat' for individual buttons
  remapLabel?: (qmkId: string) => string
}
