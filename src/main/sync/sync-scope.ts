// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-unit scope matching: which sync units a given SyncScope covers,
// and which remote units are worth downloading given what's stored
// locally. Split out of sync-service.ts to keep it under the project's
// 800-line Service/Util size ceiling.

import { app } from 'electron'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { isAnalyticsSyncUnit, isRunLogSyncUnit } from './sync-bundle'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { KEY_LABEL_SYNC_UNIT } from '../key-label-store'
import { TYPING_TEST_TEXT_SYNC_UNIT } from '../typing-test-text-store'
import { I18N_SYNC_UNIT_PREFIX } from '../../shared/types/i18n-store'
import { THEME_SYNC_UNIT_PREFIX } from '../../shared/types/theme-store'
import type { SyncScope } from '../../shared/types/sync'

export function matchesScope(syncUnit: string | null, scope: SyncScope): boolean {
  if (scope === 'all') return true
  if (syncUnit === null) return false
  // 'packs' is checked before the unconditional keyboard-meta/key-label/
  // typing-test-text `true`s below — otherwise a 'packs'-scoped download
  // would also pull those unrelated global units in, since their own
  // checks don't otherwise care what scope was asked for. Returning here
  // also means 'packs' never falls through to the i18n/themes rejection
  // further down, and never matches anything else (favorites/keyboards).
  if (scope === 'packs') {
    return syncUnit.startsWith(I18N_SYNC_UNIT_PREFIX) || syncUnit.startsWith(THEME_SYNC_UNIT_PREFIX)
  }
  if (syncUnit === KEYBOARD_META_SYNC_UNIT) return true // meta follows every scope
  if (syncUnit === KEY_LABEL_SYNC_UNIT) return true // key-labels follow every scope (global, all-keyboard)
  if (syncUnit === TYPING_TEST_TEXT_SYNC_UNIT) return true // imported typing-test texts follow every scope (global, all-keyboard)
  // i18n/themes only match 'all' or 'packs' (both short-circuited above) —
  // excluded from favorites/keyboard-scoped syncs. NOT reliably discovered
  // by the 3-minute poll alone despite it using 'all': polling only merges
  // a CHANGED modifiedTime since its own last snapshot, so a pack already
  // on Drive before this machine's first poll is invisible to it forever.
  // What actually closes the gap is the 'packs' scope above: an
  // automatic pull on first device connection (AppConfig.packsPulledOnce)
  // and the Language/Theme Packs modal's "Pull from Cloud" button both
  // use it to fetch i18n/theme packs directly, without depending on
  // poll-detected diffs.
  if (syncUnit.startsWith(I18N_SYNC_UNIT_PREFIX) || syncUnit.startsWith(THEME_SYNC_UNIT_PREFIX)) return false
  if (scope === 'favorites') return syncUnit.startsWith('favorites/')
  if (typeof scope === 'object' && 'favorites' in scope) {
    return syncUnit.startsWith('favorites/') || syncUnit.startsWith(`keyboards/${scope.keyboard}/`)
  }
  return syncUnit.startsWith(`keyboards/${scope.keyboard}/`)
}

export async function listLocalKeyboardUids(): Promise<Set<string>> {
  const userData = app.getPath('userData')
  const keyboardsDir = join(userData, 'sync', 'keyboards')
  const uids = new Set<string>()
  try {
    const entries = await readdir(keyboardsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) uids.add(entry.name)
    }
  } catch { /* dir doesn't exist */ }
  return uids
}

export function shouldDownloadSyncUnit(
  syncUnit: string | null,
  scope: SyncScope,
  localKeyboardUids: Set<string>,
): boolean {
  if (!syncUnit) return false
  if (!matchesScope(syncUnit, scope)) return false
  // Keyboard-connect initial sync (useDeviceAutoSync) passes a
  // `{ favorites: true, keyboard }` scope. typing-analytics is pulled
  // separately when the Analyze panel opens — skip it here so the
  // connect progress bar stays short. Run logs are excluded the same
  // way (no per-uid keystroke count to show on the connect progress
  // bar either).
  if (typeof scope === 'object' && 'favorites' in scope && (isAnalyticsSyncUnit(syncUnit) || isRunLogSyncUnit(syncUnit))) {
    return false
  }
  // Lazy: when scope is 'all' only download keyboards/<uid>/* that already exist locally.
  // Explicit keyboard scopes always download in full.
  if (syncUnit.startsWith('keyboards/') && scope === 'all') {
    const uid = syncUnit.split('/')[1]
    return !!uid && localKeyboardUids.has(uid)
  }
  return true
}
