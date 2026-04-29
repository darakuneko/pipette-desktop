// SPDX-License-Identifier: GPL-2.0-or-later
//
// Char-resolution pipeline for Layout Comparison (Phase 1).
//
// Given a typing-analytics snapshot (qmkId-per-position) plus the
// user's source layout and a target layout, translate each matrix
// event (row, col) into the physical position (row', col') the user
// would have pressed on the target layout to produce the same base
// char, and the ergonomic finger / hand / row category for that
// target position.
//
// The full result for every position is pre-computed at build time,
// so `resolve(row, col)` is a single Map lookup. Phase 1 only
// considers the layer-0 base char of each key — masked keycodes
// (LSFT(...), LT(...)) collapse to their inner basic keycode via
// findInnerKeycode.
//
// See Plan-analyze-layout-comparison §「char 解決パイプライン」.
//
// Note on Layout Comparison semantics: "target physical position" is
// answered against the same snapshot the source resolves on. The
// snapshot represents what the user's firmware actually does today;
// we are asking "if you wanted to type this same character on layout
// X, where would your finger have gone given the current keymap?".

import { findInnerKeycode } from '../../shared/keycodes/keycodes'
import {
  buildErgonomicsByPos,
  type FingerType,
  type HandType,
  type RowCategory,
} from '../../shared/kle/kle-ergonomics'
import { posKey } from '../../shared/kle/pos-key'
import type { KleKey } from '../../shared/kle/types'
import {
  firstCodePoint,
  getForwardMap,
  getReverseMap,
  type LayoutShape,
} from '../../shared/keymap/layout-parse'
import type { TypingKeymapSnapshot } from '../../shared/types/typing-analytics'

export interface LayoutResolverInput {
  snapshot: TypingKeymapSnapshot
  /** KLE-derived geometry for the snapshot's keyboard. Caller is
   * responsible for parsing `snapshot.layout` into KleKeys (kept out
   * of the resolver to keep this module agnostic of the
   * KeyboardDefinition shape). */
  kleKeys: KleKey[]
  sourceLayout: LayoutShape
  targetLayout: LayoutShape
  /** Layer to resolve against. Phase 1 reads layer 0 only. */
  layer?: number
}

export type SkipReason =
  | 'unmapped_keycode'
  | 'no_char'
  | 'no_target_position'

export type ResolveResult =
  | {
      skipped: false
      char: string
      sourceKeycode: string
      targetKeycode: string
      targetRow: number
      targetCol: number
      finger?: FingerType
      hand?: HandType
      rowCategory?: RowCategory
    }
  | {
      skipped: true
      skipReason: SkipReason
    }

export interface LayoutResolver {
  resolve(row: number, col: number): ResolveResult
}

const SKIP_UNMAPPED_KEYCODE = {
  skipped: true,
  skipReason: 'unmapped_keycode',
} as const
const SKIP_NO_CHAR = {
  skipped: true,
  skipReason: 'no_char',
} as const
const SKIP_NO_TARGET_POSITION = {
  skipped: true,
  skipReason: 'no_target_position',
} as const

export function buildLayoutResolver(input: LayoutResolverInput): LayoutResolver {
  const layer = input.layer ?? 0
  const layerKeymap = input.snapshot.keymap[layer] ?? []

  // Build pos → inner basic qmkId, plus its reverse for target
  // physical-position lookup. First-occurrence wins on the reverse
  // index so behaviour is deterministic across layouts.
  const posToInner = new Map<string, string>()
  const innerToPos = new Map<string, [number, number]>()
  for (let row = 0; row < layerKeymap.length; row += 1) {
    const cols = layerKeymap[row] ?? []
    for (let col = 0; col < cols.length; col += 1) {
      const serialized = cols[col]
      if (!serialized) continue
      const inner = findInnerKeycode(serialized)
      if (!inner) continue
      const innerId = inner.qmkId
      posToInner.set(posKey(row, col), innerId)
      if (!innerToPos.has(innerId)) innerToPos.set(innerId, [row, col])
    }
  }

  // Build pos → ergonomics meta once across the full KleKey set.
  const ergonomicsByPos = buildErgonomicsByPos(input.kleKeys)

  // Pre-compute the full ResolveResult per source position. The
  // event-time resolve() then degenerates to a single Map.get().
  const sourceForward = getForwardMap(input.sourceLayout)
  const targetReverse = getReverseMap(input.targetLayout)
  const posToResult = new Map<string, ResolveResult>()
  for (const [pos, sourceKeycode] of posToInner) {
    const sourceEntry = sourceForward.get(sourceKeycode)
    const baseChar = sourceEntry ? firstCodePoint(sourceEntry.base) : undefined
    const char = baseChar?.toLowerCase()
    if (!char) {
      posToResult.set(pos, SKIP_NO_CHAR)
      continue
    }
    const targetKeycode = targetReverse.get(char)
    if (!targetKeycode) {
      posToResult.set(pos, SKIP_NO_CHAR)
      continue
    }
    const targetPos = innerToPos.get(targetKeycode)
    if (!targetPos) {
      posToResult.set(pos, SKIP_NO_TARGET_POSITION)
      continue
    }
    const ergon = ergonomicsByPos.get(posKey(targetPos[0], targetPos[1]))
    posToResult.set(pos, {
      skipped: false,
      char,
      sourceKeycode,
      targetKeycode,
      targetRow: targetPos[0],
      targetCol: targetPos[1],
      finger: ergon?.finger,
      hand: ergon?.hand,
      rowCategory: ergon?.row,
    })
  }

  return {
    resolve(row, col) {
      return posToResult.get(posKey(row, col)) ?? SKIP_UNMAPPED_KEYCODE
    },
  }
}
