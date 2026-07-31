// SPDX-License-Identifier: GPL-2.0-or-later

/** Matrix key (row/col) resolution against active layers: parsing matrix
 *  key strings, extracting layer-switch targets, resolving the effective
 *  keycode for a pressed matrix position, and diffing two frames' pressed
 *  sets into an ordered list of press/release edges. */

import { extractMOLayer, extractLTLayer, extractLMLayer } from './keycode-char-map'

/** Press-edge record kept until the press resolves — by its matching
 * release edge, or by the deferred-emit deadline if it is still held
 * when that fires — so masked keys can classify the press as tap vs
 * hold. Non-masked keys are emitted immediately on press and never land
 * in this record. */
export interface PressStartRecord {
  tsMs: number
  row: number
  col: number
  layer: number
  keycode: number
  /** Overlap / pollGapMs determined at press time (see
   * matrix-press-duration.ts) — carried through to whatever event this
   * press eventually resolves into (tap or hold), so a masked key's
   * deferred classification doesn't lose the fields a non-masked press
   * gets immediately. */
  overlap?: boolean
  pollGapMs?: number
}

/** Parse a "row,col" matrix key string into numeric row and col. */
export function parseMatrixKey(key: string): [number, number] {
  const [r, c] = key.split(',')
  return [Number(r), Number(c)]
}

/** Extract the target layer from any layer switch keycode (MO, LT, or LM). */
export function extractSwitchLayer(code: number): number | null {
  return extractMOLayer(code) ?? extractLTLayer(code) ?? extractLMLayer(code)
}

/** Resolve the effective keycode AND the layer the keycode was picked
 * from. Used by the analytics path so each event is attributed to the
 * layer where the key is actually defined, not the (possibly different)
 * layer the pressed key itself is activating. For example, a lone LT1
 * press at base 0 resolves to LT1(kc) from layer 0 even though it
 * activates layer 1, so the heatmap shows the press on the base-layer
 * view the user is looking at. */
export function resolveEffectiveCodeWithLayer(
  row: number,
  col: number,
  keymap: Map<string, number>,
  sortedLayers: number[],
  baseLayer: number,
): { code: number; layer: number } | undefined {
  for (const layer of sortedLayers) {
    const code = keymap.get(`${layer},${row},${col}`)
    if (code != null && code !== 0x01) return { code, layer }
  }
  const baseCode = keymap.get(`${baseLayer},${row},${col}`)
  return baseCode != null ? { code: baseCode, layer: baseLayer } : undefined
}

/** One press or release edge between two frames' pressed sets, in
 * row-major walk order (see {@link matrixFrameEdges}). */
export interface MatrixEdge {
  key: string
  row: number
  col: number
  isPress: boolean
}

/** Diff `prev` and `pressed` into the keys whose held-status changed —
 * a key present in both is not an edge and is skipped. Edges are
 * returned in row-major order (ascending row, then col) rather than Set
 * iteration order, which has no ordering guarantee: a caller resolving
 * each edge against state mutated by the edges before it (as
 * processMatrixFrame does for its layer latch) needs that order to be
 * deterministic, not incidental to Set internals. Built from two direct
 * scans of `prev` and `pressed` rather than a unioned copy, so an idle
 * frame (nothing changed) does no allocation beyond the empty result. */
export function matrixFrameEdges(prev: ReadonlySet<string>, pressed: ReadonlySet<string>): MatrixEdge[] {
  const edges: MatrixEdge[] = []
  for (const key of prev) {
    if (!pressed.has(key)) {
      const [row, col] = parseMatrixKey(key)
      edges.push({ key, row, col, isPress: false })
    }
  }
  for (const key of pressed) {
    if (!prev.has(key)) {
      const [row, col] = parseMatrixKey(key)
      edges.push({ key, row, col, isPress: true })
    }
  }
  return edges.sort((a, b) => a.row - b.row || a.col - b.col)
}
