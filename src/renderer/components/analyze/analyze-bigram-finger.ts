// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram → finger-pair helpers for the Analyze Bigrams Finger IKI
// view. Bigram pair ids store keycodes (no row / col), so the renderer
// reverse-resolves each numeric keycode to a finger via the snapshot
// keymap + ergonomics estimator. First-occurrence wins when a keycode
// is bound at multiple physical positions.

import { deserialize } from '../../../shared/keycodes/keycodes'
import {
  buildErgonomicsByPos,
  type FingerType,
} from '../../../shared/kle/kle-ergonomics'
import { posKey } from '../../../shared/kle/pos-key'
import type { KleKey } from '../../../shared/kle/types'
import type {
  TypingBigramTopEntry,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { foldHist, HIST_BUCKETS, parseBigramId } from './analyze-bigram-heatmap'
import { withSnapshotProtocol } from './analyze-protocol'

/** Build a numeric-keycode → finger lookup from the snapshot's layer-0
 * keymap, honouring user finger overrides keyed by `${row},${col}`.
 * Uses first-occurrence — when a keycode appears in multiple physical
 * positions, the earliest (top-left first by KleKey order) wins. The
 * approximation is OK for typical layouts where alphas live on a single
 * spot; modifiers may hit either hand but the visualization treats
 * them as a single finger anyway.
 *
 * Keycodes decode under `vialProtocol` (the snapshot's own protocol —
 * see `withSnapshotProtocol`) so the resulting numeric codes match the
 * ones the bigram aggregate stores. Callers should pass
 * `snapshot.vialProtocol` so protocol-dependent codes (QK_BOOT, macros,
 * ...) resolve to the value recorded at capture time rather than the
 * current session's default. */
export function buildKeycodeFingerMap(
  snapshot: TypingKeymapSnapshot,
  keys: readonly KleKey[],
  fingerOverrides?: Record<string, FingerType>,
  vialProtocol?: number,
): Map<number, FingerType> {
  return withSnapshotProtocol(vialProtocol, () => {
    const result = new Map<number, FingerType>()
    if (snapshot.keymap.length === 0) return result
    const layer0 = snapshot.keymap[0]
    if (!layer0) return result
    const ergonomicsByPos = buildErgonomicsByPos([...keys])
    for (const key of keys) {
      const row = layer0[key.row]
      if (!row) continue
      const qmkId = row[key.col]
      if (typeof qmkId !== 'string' || qmkId.length === 0) continue
      let code: number
      try {
        code = deserialize(qmkId)
      } catch {
        continue
      }
      if (!Number.isFinite(code)) continue
      if (result.has(code)) continue
      const pos = posKey(key.row, key.col)
      const override = fingerOverrides?.[pos]
      const finger = override ?? ergonomicsByPos.get(pos)?.finger
      if (finger) result.set(code, finger)
    }
    return result
  })
}

export interface FingerPairTotal {
  count: number
  hist: number[]
}

/** Aggregate bigram entries into (prevFinger, currFinger) totals.
 * Pairs whose keycodes can't be mapped to a finger (composite codes,
 * unknown keys) fall through silently — the renderer just won't show
 * a cell for them. */
export function aggregateFingerPairs(
  entries: readonly TypingBigramTopEntry[],
  keycodeFinger: ReadonlyMap<number, FingerType>,
): Map<string, FingerPairTotal> {
  const totals = new Map<string, FingerPairTotal>()
  for (const entry of entries) {
    const pair = parseBigramId(entry.ngramId)
    if (!pair) continue
    const f1 = keycodeFinger.get(pair.prev)
    const f2 = keycodeFinger.get(pair.curr)
    if (!f1 || !f2) continue
    const key = `${f1}_${f2}`
    let agg = totals.get(key)
    if (!agg) {
      agg = { count: 0, hist: new Array<number>(HIST_BUCKETS).fill(0) }
      totals.set(key, agg)
    }
    agg.count += entry.count
    foldHist(agg.hist, entry.hist)
  }
  return totals
}
