// SPDX-License-Identifier: GPL-2.0-or-later

export interface KeyboardMetaEntry {
  uid: string
  deviceName: string
  updatedAt: string
  deletedAt?: string
}

export interface KeyboardMetaIndex {
  type: 'keyboard-meta'
  version: 1
  entries: KeyboardMetaEntry[]
}

export const KEYBOARD_META_SYNC_UNIT = 'meta/keyboard-names' as const
export type KeyboardMetaSyncUnit = typeof KEYBOARD_META_SYNC_UNIT

export function createEmptyKeyboardMetaIndex(): KeyboardMetaIndex {
  return { type: 'keyboard-meta', version: 1, entries: [] }
}
