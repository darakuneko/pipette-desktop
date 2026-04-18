// SPDX-License-Identifier: GPL-2.0-or-later
// Bundle creation: reads local sync data into uploadable bundles

import { app } from 'electron'
import { join } from 'node:path'
import { readFile, readdir, access } from 'node:fs/promises'
import { gcTombstones } from './merge'
import { keyboardMetaFilePath, readKeyboardMetaIndex } from './keyboard-meta'
import { FAVORITE_TYPES } from '../../shared/favorite-data'
import { DEFAULT_TYPING_SYNC_SPAN_DAYS } from '../../shared/types/typing-analytics'
import type { FavoriteIndex } from '../../shared/types/favorite-store'
import type { SnapshotIndex } from '../../shared/types/snapshot-store'
import type { SyncBundle } from '../../shared/types/sync'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { buildTypingAnalyticsBundle, parseTypingAnalyticsSyncUnit, typingAnalyticsSyncUnit } from '../typing-analytics/sync'
import { readPipetteSettings } from '../pipette-settings-store'
import { log } from '../logger'

export async function readIndexFile(dir: string): Promise<FavoriteIndex | SnapshotIndex | null> {
  try {
    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    return JSON.parse(raw) as FavoriteIndex | SnapshotIndex
  } catch {
    return null
  }
}

export async function bundleSyncUnit(syncUnit: string): Promise<SyncBundle | null> {
  if (syncUnit === KEYBOARD_META_SYNC_UNIT) {
    const index = await readKeyboardMetaIndex()
    return { type: 'keyboard-meta', key: 'keyboard-names', index, files: {} }
  }

  const parts = syncUnit.split('/')
  const userData = app.getPath('userData')

  // Handle "keyboards/{uid}/typing-analytics" — synthetic single-file bundle
  // backed by the SQLite store. Nothing lives on disk under sync/ for this
  // unit; the exported rows are serialized into files['data.json'] so the
  // existing encrypt/upload pipeline can carry them unchanged. Errors are
  // logged and re-thrown so the upload path re-queues the unit instead of
  // treating a transient DB/settings failure as a silent success.
  const typingAnalyticsUid = parseTypingAnalyticsSyncUnit(syncUnit)
  if (typingAnalyticsUid !== null) {
    const uid = typingAnalyticsUid
    try {
      const prefs = await readPipetteSettings(uid)
      const spanDays = prefs?.typingSyncSpanDays ?? DEFAULT_TYPING_SYNC_SPAN_DAYS
      const bundle = buildTypingAnalyticsBundle(uid, spanDays)
      return {
        type: 'typing-analytics',
        key: uid,
        index: { uid, entries: [] } as SnapshotIndex,
        files: { 'data.json': JSON.stringify(bundle) },
      }
    } catch (err) {
      log('warn', `typing-analytics bundle build failed for ${uid}: ${String(err)}`)
      throw err
    }
  }

  // Handle "keyboards/{uid}/settings" — single-file bundle (no index)
  if (parts.length === 3 && parts[0] === 'keyboards' && parts[2] === 'settings') {
    const uid = parts[1]
    const filePath = join(userData, 'sync', 'keyboards', uid, 'pipette_settings.json')
    try {
      const content = await readFile(filePath, 'utf-8')
      return {
        type: 'settings',
        key: uid,
        index: { uid, entries: [] } as SnapshotIndex,
        files: { 'pipette_settings.json': content },
      }
    } catch {
      return null
    }
  }

  // Handle index-based sync units (favorites, keyboard snapshots)
  const basePath = join(userData, 'sync', ...parts)
  const index = await readIndexFile(basePath)
  if (!index) return null

  const gcEntries = gcTombstones(index.entries)
  index.entries = gcEntries as typeof index.entries

  const files: Record<string, string> = {}

  for (const entry of gcEntries) {
    try {
      const content = await readFile(join(basePath, entry.filename), 'utf-8')
      files[entry.filename] = content
    } catch {
      // File missing — skip
    }
  }

  files['index.json'] = JSON.stringify(index, null, 2)

  const type: SyncBundle['type'] = parts[0] === 'favorites' ? 'favorite' : 'layout'

  return { type, key: parts[1], index, files }
}

export async function collectAllSyncUnits(): Promise<string[]> {
  const userData = app.getPath('userData')
  const units: string[] = FAVORITE_TYPES.map((type) => `favorites/${type}`)

  try {
    await access(keyboardMetaFilePath())
    units.push(KEYBOARD_META_SYNC_UNIT)
  } catch { /* no meta */ }

  // Scan sync/keyboards/{uid}/ for settings and snapshots
  const keyboardsDir = join(userData, 'sync', 'keyboards')
  try {
    const entries = await readdir(keyboardsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const uid = entry.name
      // settings (single file)
      try {
        await access(join(keyboardsDir, uid, 'pipette_settings.json'))
        units.push(`keyboards/${uid}/settings`)
      } catch { /* no settings */ }
      // snapshots (index-based)
      try {
        await access(join(keyboardsDir, uid, 'snapshots', 'index.json'))
        units.push(`keyboards/${uid}/snapshots`)
      } catch { /* no snapshots */ }
    }
  } catch { /* dir doesn't exist */ }

  // Typing analytics units: one per keyboard uid that this machine has
  // recorded rows for. Remote-only uids (from other machines) are not
  // uploaded here — the owning machine is responsible for its own data.
  try {
    const machineHash = await getMachineHash()
    const typingUids = getTypingAnalyticsDB().listLocalKeyboardUids(machineHash)
    for (const uid of typingUids) {
      units.push(typingAnalyticsSyncUnit(uid))
    }
  } catch (err) {
    // Log instead of silently dropping so a DB schema mismatch or machine
    // hash failure does not silently disable typing-analytics sync forever.
    log('warn', `typing-analytics sync-unit scan failed: ${String(err)}`)
  }

  return units
}
