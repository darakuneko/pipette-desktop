// SPDX-License-Identifier: GPL-2.0-or-later
// Identifies which physical cells in a keymap snapshot are tap-hold
// keys (Layer-Tap, Mod-Tap, Swap-Hands-Tap) so the TAPPING_TERM
// advisor (analyze-tapping-term.ts) only aggregates duration data from
// keys that actually have a tap/hold decision to make — a plain
// `KC_A` has no TAPPING_TERM-relevant behavior, and folding its
// (usually much longer) ordinary hold times into the histogram would
// bias the diagnosis toward "everything is a slow hold".
//
// Deliberately narrower than the typing-test's `isTapKeycode` (which
// also treats one-shot keys, tap dance, etc. as "has a tap action" for
// recording purposes): TAPPING_TERM only governs the tap/hold decision
// for LT / MT / SH_T, so those three are the only keycodes this module
// cares about. See `buildSpeedFillByPos` in key-heatmap-helpers.ts and
// `tapKeycodeOf` in analyze-bigram-word-position.ts for the same
// "deserialize under withSnapshotProtocol, test with the specific
// range predicates" pattern this reuses.
//
// The caller (TappingTermCard) computes `tapHoldPositionKeys` once per
// snapshot and passes the resulting Set into both selectors below,
// rather than each selector re-walking the keymap itself — the walk
// (and the protocol swap it runs under) is the expensive part, not the
// filter.

import { deserialize, isLTKeycode, isModTapKeycode, isSHTKeycode } from '../../../shared/keycodes/keycodes'
import type { TypingDurationCell, TypingKeymapSnapshot, TypingMatrixCellRow } from '../../../shared/types/typing-analytics'
import { withSnapshotProtocol } from './analyze-protocol'
import { durationCellKey } from './key-heatmap-helpers'
import { posKey } from '../../../shared/kle/pos-key'

/** True when a serialized QMK id (as stored in `TypingKeymapSnapshot.keymap`)
 * decodes to a Layer-Tap, Mod-Tap or Swap-Hands-Tap keycode. Must be
 * called inside `withSnapshotProtocol(snapshot.vialProtocol, ...)` —
 * the range predicates it uses resolve against the *current* global
 * protocol, and two of the three move between v5 and v6 (see
 * `tapKeycodeOf`'s doc comment in analyze-bigram-word-position.ts). */
function isTapHoldQmkId(qmkId: string): boolean {
  if (!qmkId) return false
  let code: number
  try {
    code = deserialize(qmkId)
  } catch {
    return false
  }
  if (!Number.isFinite(code)) return false
  return isLTKeycode(code) || isModTapKeycode(code) || isSHTKeycode(code)
}

/** Every `"layer:row,col"` position (see `durationCellKey`) in
 * `snapshot.keymap` whose keycode is a tap-hold key. Empty when the
 * snapshot has none — the caller uses that both to hide the advisor
 * card entirely and as the "no qualifying keys" input to the two
 * selectors below. */
export function tapHoldPositionKeys(snapshot: TypingKeymapSnapshot): ReadonlySet<string> {
  const keys = new Set<string>()
  if (!Array.isArray(snapshot.keymap)) return keys
  withSnapshotProtocol(snapshot.vialProtocol, () => {
    snapshot.keymap.forEach((layerRows, layer) => {
      if (!Array.isArray(layerRows)) return
      layerRows.forEach((row, r) => {
        if (!Array.isArray(row)) return
        row.forEach((qmkId, c) => {
          if (isTapHoldQmkId(qmkId)) keys.add(durationCellKey(layer, posKey(r, c)))
        })
      })
    })
  })
  return keys
}

/** Filters a range's duration cells down to only the ones sitting on a
 * tap-hold position from a precomputed `tapHoldPositionKeys` result. */
export function selectTapHoldDurationCells(
  positionKeys: ReadonlySet<string>,
  cells: readonly TypingDurationCell[],
): TypingDurationCell[] {
  if (positionKeys.size === 0) return []
  return cells.filter((cell) => positionKeys.has(durationCellKey(cell.layer, posKey(cell.row, cell.col))))
}

/** Same filter as {@link selectTapHoldDurationCells} but for the
 * matrix cell rows (tap/hold press counts) the card shows as
 * supporting context. */
export function selectTapHoldMatrixCells(
  positionKeys: ReadonlySet<string>,
  cells: readonly TypingMatrixCellRow[],
): TypingMatrixCellRow[] {
  if (positionKeys.size === 0) return []
  return cells.filter((cell) => positionKeys.has(durationCellKey(cell.layer, posKey(cell.row, cell.col))))
}
