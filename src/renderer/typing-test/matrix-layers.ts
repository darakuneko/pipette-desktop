// SPDX-License-Identifier: GPL-2.0-or-later

/** Matrix key (row/col) resolution against active layers: parsing matrix
 *  key strings, extracting layer-switch targets, and resolving the
 *  effective keycode for a pressed matrix position. */

import { extractMOLayer, extractLTLayer, extractLMLayer } from './keycode-char-map'

/** Press-edge record kept until the matching release edge is seen so
 * masked keys can classify the press as tap vs hold. Non-masked keys
 * are emitted immediately on press and never land in this map. */
export interface PressStartRecord {
  tsMs: number
  row: number
  col: number
  layer: number
  keycode: number
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

/** Resolve the effective keycode for a matrix position by checking active
 * layers in descending order, skipping KC_TRNS (0x01), then falling back
 * to the base layer. */
export function resolveEffectiveCode(
  row: number,
  col: number,
  keymap: Map<string, number>,
  sortedLayers: number[],
  baseLayer: number,
): number | undefined {
  for (const layer of sortedLayers) {
    const code = keymap.get(`${layer},${row},${col}`)
    if (code != null && code !== 0x01) return code
  }
  return keymap.get(`${baseLayer},${row},${col}`)
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
