// SPDX-License-Identifier: GPL-2.0-or-later

import type { FavoriteType } from './types/favorite-store'

const FAVORITE_TYPES: readonly FavoriteType[] = ['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey']

export function isValidFavoriteType(v: unknown): v is FavoriteType {
  return typeof v === 'string' && FAVORITE_TYPES.includes(v)
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
