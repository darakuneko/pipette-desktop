// SPDX-License-Identifier: GPL-2.0-or-later

import type { VilFile } from './types/protocol'

/** Runtime type guard for VilFile JSON data */
export function isVilFile(data: unknown): data is VilFile {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return (
    typeof obj.uid === 'string' &&
    typeof obj.keymap === 'object' &&
    obj.keymap !== null &&
    typeof obj.encoderLayout === 'object' &&
    obj.encoderLayout !== null &&
    Array.isArray(obj.macros) &&
    typeof obj.layoutOptions === 'number' &&
    Array.isArray(obj.tapDance) &&
    Array.isArray(obj.combo) &&
    Array.isArray(obj.keyOverride) &&
    Array.isArray(obj.altRepeatKey) &&
    typeof obj.qmkSettings === 'object' &&
    obj.qmkSettings !== null &&
    (obj.layerNames === undefined ||
      (Array.isArray(obj.layerNames) && obj.layerNames.every((n) => typeof n === 'string')))
  )
}

/** Convert Map<string, number> to plain Record for JSON serialization */
export function mapToRecord(map: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {}
  for (const [key, value] of map) {
    record[key] = value
  }
  return record
}

/** Convert plain Record back to Map<string, number> after JSON parse */
export function recordToMap(record: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(record).map(([k, v]) => [k, v]))
}

/** Derive layer count from keymap Record keys ("layer,row,col") */
export function deriveLayerCount(keymap: Record<string, number>): number {
  const keys = Object.keys(keymap)
  if (keys.length === 0) return 1
  let max = 0
  for (const key of keys) {
    const layer = parseInt(key.split(',')[0], 10)
    if (layer > max) max = layer
  }
  return max + 1
}
