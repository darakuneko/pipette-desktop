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

// Hist bucket count is part of the IPC wire contract (TypingBigramTopEntry.hist)
// — always length 8. Hard-coded here to keep the renderer-side helpers
// independent of the main-process bucket module.
const HIST_BUCKETS = 8

/** Build a numeric-keycode → finger lookup from the snapshot's layer-0
 * keymap, honouring user finger overrides keyed by `${row},${col}`.
 * Uses first-occurrence — when a keycode appears in multiple physical
 * positions, the earliest (top-left first by KleKey order) wins. The
 * approximation is OK for typical layouts where alphas live on a single
 * spot; modifiers may hit either hand but the visualization treats
 * them as a single finger anyway. */
export function buildKeycodeFingerMap(
  snapshot: TypingKeymapSnapshot,
  keys: readonly KleKey[],
  fingerOverrides?: Record<string, FingerType>,
): Map<number, FingerType> {
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
    const parts = entry.bigramId.split('_')
    if (parts.length !== 2) continue
    const prev = Number(parts[0])
    const curr = Number(parts[1])
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue
    const f1 = keycodeFinger.get(prev)
    const f2 = keycodeFinger.get(curr)
    if (!f1 || !f2) continue
    const key = `${f1}_${f2}`
    let agg = totals.get(key)
    if (!agg) {
      agg = { count: 0, hist: new Array<number>(HIST_BUCKETS).fill(0) }
      totals.set(key, agg)
    }
    agg.count += entry.count
    for (let i = 0; i < HIST_BUCKETS; i += 1) {
      agg.hist[i] += entry.hist[i] ?? 0
    }
  }
  return totals
}
