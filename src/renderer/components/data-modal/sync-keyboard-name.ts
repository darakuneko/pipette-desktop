// SPDX-License-Identifier: GPL-2.0-or-later

import type { StoredKeyboardInfo, SyncDataScanResult } from '../../../shared/types/sync'

/** Case-insensitive A-Z compare for keyboard display names. */
export const byDisplayName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** The name the Data modal's Sync tree shows for keyboard `uid`: the synced
 *  name the scan found, else the stored keyboard's name, else `fallback`
 *  (the uid unless given). */
export function syncKeyboardName(
  uid: string,
  scan: SyncDataScanResult | null,
  storedKeyboards: StoredKeyboardInfo[],
  fallback: string = uid,
): string {
  return scan?.keyboardNames[uid] ?? storedKeyboards.find((kb) => kb.uid === uid)?.name ?? fallback
}
