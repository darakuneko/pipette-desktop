// SPDX-License-Identifier: GPL-2.0-or-later

import type { FavoriteType, FavoriteExportFile, FavoriteExportEntry } from './types/favorite-store'

export const FAVORITE_TYPES: readonly FavoriteType[] = ['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey']

export const FAV_EXPORT_KEY_MAP: Record<string, FavoriteType> = {
  macro: 'macro',
  td: 'tapDance',
  combo: 'combo',
  ko: 'keyOverride',
  ark: 'altRepeatKey',
}

export const FAV_TYPE_TO_EXPORT_KEY: Record<FavoriteType, string> = {
  macro: 'macro',
  tapDance: 'td',
  combo: 'combo',
  keyOverride: 'ko',
  altRepeatKey: 'ark',
}

export const FAV_KEYCODE_FIELDS: Record<FavoriteType, readonly string[]> = {
  tapDance: ['onTap', 'onHold', 'onDoubleTap', 'onTapHold'],
  macro: [],
  combo: ['key1', 'key2', 'key3', 'key4', 'output'],
  keyOverride: ['triggerKey', 'replacementKey'],
  altRepeatKey: ['lastKey', 'altKey'],
}

export function isValidFavoriteType(v: unknown): v is FavoriteType {
  // `.includes` on a `readonly FavoriteType[]` only accepts a FavoriteType,
  // but this guard's whole job is checking an arbitrary string against that
  // set — widen the array view for the membership check.
  return typeof v === 'string' && (FAVORITE_TYPES as readonly string[]).includes(v)
}

export function isValidVialProtocol(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Fallback vial protocol used when a favorite Hub export/upload happens
 * with no keyboard connected (the Data modal only renders on the
 * disconnected screen, where `vialProtocol` is the emptyState sentinel
 * -1 — see `keyboard-types.ts`). 6, not 9: on import this value is fed
 * to `setProtocol` (`withImportProtocol` in `main/favorite-store.ts`),
 * and the keycode resolver behind `deserialize` treats *only* protocol 6
 * as the v6 keycode table (`resolve` in `keycodes-utils.ts`: `protocol
 * === 6 ? keycodesV6.kc : keycodesV5.kc`). 9 would silently fall through
 * to the v5 map and mis-import protocol-specific keycodes.
 */
export const FALLBACK_VIAL_PROTOCOL = 6

/**
 * Stricter than {@link isValidVialProtocol} — used only at the Hub
 * upload boundary (`hub-ipc.ts`), where a raw negative protocol should
 * fail fast locally instead of reaching the server as a confusing 400.
 * `isValidVialProtocol` itself stays loose on purpose: it's the local
 * (non-Hub) export/import boundary in `favorite-store.ts`, and tightening
 * it there is a separate, non-breaking-guaranteed change no caller
 * currently needs — no caller passes -1 today. (A connected device can
 * never actually hold -1: preload's protocol read ends in `>>> 0`, so
 * `vialProtocol` is unsigned once connected, and a genuinely VIA-only
 * board never reaches the connected state — `useDeviceLifecycle`
 * disconnects it with `error.notVialCompatible` first. The only place
 * -1 comes from is `emptyState()` in `keyboard-types.ts`, on the
 * disconnected screen.)
 */
export function isValidHubVialProtocol(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

export function buildFavExportFile(
  vialProtocol: number,
  categories: Record<string, FavoriteExportEntry[]>,
  exportedAt: string = new Date().toISOString(),
): FavoriteExportFile {
  return {
    app: 'pipette',
    version: 3,
    scope: 'fav',
    exportedAt,
    vial_protocol: vialProtocol,
    categories,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hasNumberFields(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => typeof obj[k] === 'number')
}

function isValidTapDanceData(data: unknown): boolean {
  if (!isRecord(data)) return false
  return hasNumberFields(data, ['onTap', 'onHold', 'onDoubleTap', 'onTapHold', 'tappingTerm'])
}

function isValidMacroData(data: unknown): boolean {
  if (!Array.isArray(data)) return false
  for (const item of data) {
    if (!Array.isArray(item) || item.length < 1 || typeof item[0] !== 'string') return false
  }
  return true
}

function isValidComboData(data: unknown): boolean {
  if (!isRecord(data)) return false
  return hasNumberFields(data, ['key1', 'key2', 'key3', 'key4', 'output'])
}

function isValidKeyOverrideData(data: unknown): boolean {
  if (!isRecord(data)) return false
  return (
    hasNumberFields(data, [
      'triggerKey', 'replacementKey', 'layers', 'triggerMods',
      'negativeMods', 'suppressedMods', 'options',
    ]) && typeof data.enabled === 'boolean'
  )
}

function isValidAltRepeatKeyData(data: unknown): boolean {
  if (!isRecord(data)) return false
  return (
    hasNumberFields(data, ['lastKey', 'altKey', 'allowedMods', 'options']) &&
    typeof data.enabled === 'boolean'
  )
}

export function isValidFavExportFile(v: unknown): v is FavoriteExportFile {
  if (!isRecord(v)) return false
  if (v.app !== 'pipette' || v.scope !== 'fav') return false
  if (v.version !== 2 && v.version !== 3) return false
  if (typeof v.exportedAt !== 'string') return false
  // vial_protocol: optional. v3 exports written by Pipette include it;
  // v2 (legacy) and out-of-spec v3 without it both fall back to the
  // default protocol on import.
  if (v.vial_protocol !== undefined && typeof v.vial_protocol !== 'number') return false
  const cats = v.categories
  if (!isRecord(cats)) return false
  for (const key of Object.keys(cats)) {
    if (!(key in FAV_EXPORT_KEY_MAP)) return false
    const entries = cats[key]
    if (!Array.isArray(entries)) return false
    for (const entry of entries) {
      if (!isRecord(entry)) return false
      if (typeof entry.label !== 'string') return false
      if (typeof entry.savedAt !== 'string') return false
      if (entry.data === undefined) return false
    }
  }
  return true
}

export function serializeFavData(
  type: FavoriteType,
  data: unknown,
  serializeFn: (code: number) => string,
): unknown {
  const fields = FAV_KEYCODE_FIELDS[type]
  if (fields.length === 0 || !isRecord(data)) return data
  const result = { ...data }
  for (const field of fields) {
    if (typeof result[field] === 'number') {
      result[field] = serializeFn(result[field] as number)
    }
  }
  return result
}

export function deserializeFavData(
  type: FavoriteType,
  data: unknown,
  deserializeFn: (val: string | number) => number,
): unknown {
  const fields = FAV_KEYCODE_FIELDS[type]
  if (fields.length === 0 || !isRecord(data)) return data
  const result = { ...data }
  for (const field of fields) {
    const val = result[field]
    if (typeof val === 'string' || typeof val === 'number') {
      result[field] = deserializeFn(val)
    }
  }
  return result
}

export function isFavoriteDataFile(v: unknown, type: FavoriteType): boolean {
  if (!isRecord(v)) return false
  if (v.type !== type) return false

  const data = v.data
  switch (type) {
    case 'tapDance':
      return isValidTapDanceData(data)
    case 'macro':
      return isValidMacroData(data)
    case 'combo':
      return isValidComboData(data)
    case 'keyOverride':
      return isValidKeyOverrideData(data)
    case 'altRepeatKey':
      return isValidAltRepeatKeyData(data)
    default:
      return false
  }
}
