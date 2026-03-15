// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardDefinition, VilFile } from './types/protocol'

/** Runtime type guard for plain objects */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Runtime type guard for KeyboardDefinition JSON data */
export function isKeyboardDefinition(data: unknown): data is KeyboardDefinition {
  if (!isRecord(data)) return false

  const matrix = data.matrix
  if (
    !isRecord(matrix) ||
    typeof matrix.rows !== 'number' ||
    typeof matrix.cols !== 'number'
  ) {
    return false
  }

  const layouts = data.layouts
  if (!isRecord(layouts) || !Array.isArray(layouts.keymap)) {
    return false
  }

  if ('dynamic_keymap' in data && data.dynamic_keymap != null) {
    if (!isRecord(data.dynamic_keymap)) return false
    const lc = data.dynamic_keymap.layer_count
    if (lc != null && (typeof lc !== 'number' || !Number.isInteger(lc) || lc < 1 || lc > 32)) {
      return false
    }
  }

  return true
}

/** Current VilFile format version */
export const VILFILE_CURRENT_VERSION = 2

/**
 * Runtime type guard for VilFile JSON data.
 *
 * Accepts both v1 (no version field) and v2 (version: 2 with definition).
 * When version is 2, the definition field must be a valid KeyboardDefinition.
 */
export function isVilFile(data: unknown): data is VilFile {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>

  // Version field: must be undefined (v1) or a positive integer
  if (obj.version !== undefined && (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1)) {
    return false
  }

  // Core fields required in all versions
  const coreValid =
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
      (Array.isArray(obj.layerNames) && obj.layerNames.every((n) => typeof n === 'string'))) &&
    (obj.macroJson === undefined || obj.macroJson === null || Array.isArray(obj.macroJson))

  if (!coreValid) return false

  // v2: definition is mandatory
  if (obj.version === 2 && obj.definition === undefined) return false

  // All versions: if definition is present, it must be valid
  if (obj.definition !== undefined && !isKeyboardDefinition(obj.definition)) return false

  return true
}

/** Check whether a VilFile needs migration to v2 (i.e. is a legacy v1 file) */
export function isVilFileV1(vil: VilFile): boolean {
  return vil.version === undefined || vil.version < VILFILE_CURRENT_VERSION
}

/** Additional protocol metadata to embed during v1→v2 migration */
export interface MigrationContext {
  definition: KeyboardDefinition
  viaProtocol?: number
  vialProtocol?: number
  featureFlags?: number
}

/** Migrate a v1 VilFile to v2 by embedding a KeyboardDefinition and protocol metadata */
export function migrateVilFileToV2(vil: VilFile, definitionOrContext: KeyboardDefinition | MigrationContext): VilFile {
  if ('definition' in definitionOrContext) {
    const ctx = definitionOrContext
    return {
      ...vil,
      version: VILFILE_CURRENT_VERSION,
      definition: ctx.definition,
      viaProtocol: ctx.viaProtocol,
      vialProtocol: ctx.vialProtocol,
      featureFlags: ctx.featureFlags,
    }
  }
  // Legacy caller: just definition
  return { ...vil, version: VILFILE_CURRENT_VERSION, definition: definitionOrContext }
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
