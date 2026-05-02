// SPDX-License-Identifier: GPL-2.0-or-later
// Bundle creation: reads local sync data into uploadable bundles

import { app } from 'electron'
import { join } from 'node:path'
import { readFile, readdir, access } from 'node:fs/promises'
import { gcTombstones } from './merge'
import { keyboardMetaFilePath, readKeyboardMetaIndex } from './keyboard-meta'
import { FAVORITE_TYPES } from '../../shared/favorite-data'
import type { FavoriteIndex } from '../../shared/types/favorite-store'
import type { SnapshotIndex } from '../../shared/types/snapshot-store'
import type { AnalyzeFilterSnapshotIndex } from '../../shared/types/analyze-filter-store'
import type { KeyLabelIndex } from '../../shared/types/key-label-store'
import type { SyncBundle } from '../../shared/types/sync'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { KEY_LABEL_SYNC_UNIT } from '../key-label-store'
import {
  deviceDayJsonlPath,
  listDeviceDays,
} from '../typing-analytics/jsonl/paths'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { getMachineHash } from '../typing-analytics/machine-hash'
import {
  parseTypingAnalyticsDeviceDaySyncUnit,
  typingAnalyticsDeviceDaySyncUnit,
} from '../typing-analytics/sync'
import { log } from '../logger'

export async function readIndexFile(dir: string): Promise<FavoriteIndex | SnapshotIndex | AnalyzeFilterSnapshotIndex | KeyLabelIndex | null> {
  try {
    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    return JSON.parse(raw) as FavoriteIndex | SnapshotIndex | AnalyzeFilterSnapshotIndex | KeyLabelIndex
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

  // Handle "keyboards/{uid}/devices/{hash}/days/{YYYY-MM-DD}" — per-day
  // JSONL master. One bundle per (uid, hash, day), so cloud storage grows
  // as new days are recorded and each day's file is uploaded / deleted
  // independently of the others.
  const dayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (dayRef) {
    const filePath = deviceDayJsonlPath(userData, dayRef.uid, dayRef.machineHash, dayRef.utcDay)
    try {
      const content = await readFile(filePath, 'utf-8')
      return {
        type: 'typing-analytics-device',
        key: `${dayRef.uid}|${dayRef.machineHash}|${dayRef.utcDay}`,
        index: { uid: dayRef.uid, entries: [] } as SnapshotIndex,
        files: { 'data.jsonl': content },
      }
    } catch {
      return null
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

  // keyboards/{uid}/analyze_filters mirrors the snapshots layout but is
  // its own bundle type so the export-categorisation in sync-ipc.ts
  // doesn't lump them in with keymap snapshots.
  let type: SyncBundle['type']
  let key: string
  if (syncUnit === KEY_LABEL_SYNC_UNIT) {
    type = 'key-label'
    key = KEY_LABEL_SYNC_UNIT
  } else if (parts[0] === 'favorites') {
    type = 'favorite'
    key = parts[1]
  } else if (parts[2] === 'analyze_filters') {
    type = 'analyze-filter'
    key = parts[1]
  } else {
    type = 'layout'
    key = parts[1]
  }

  return { type, key, index, files }
}

/** typing-analytics per-day sync units. Identified through the existing
 * parser so the shape (including `utcDay` validation) is single-sourced
 * and drifts with the parser, not with a separate regex. Connect-time
 * initial sync and 3-minute polling skip these; the Analyze panel pulls
 * them on demand via `executeAnalyticsSync`. See
 * `.claude/rules/settings-persistence.md`. */
export function isAnalyticsSyncUnit(syncUnit: string): boolean {
  return parseTypingAnalyticsDeviceDaySyncUnit(syncUnit) !== null
}

/** Own-hash typing-analytics units for one keyboard. Narrower than
 * `collectAllSyncUnits` + filter — no favorites/snapshots/settings
 * scan, no remote-unaware reconcile. Used by the Analyze panel mount
 * sync. */
export async function collectAnalyticsSyncUnitsForUid(uid: string): Promise<string[]> {
  const userData = app.getPath('userData')
  const units: string[] = []
  try {
    const machineHash = await getMachineHash()
    for (const day of await listDeviceDays(userData, uid, machineHash)) {
      units.push(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, day))
    }
  } catch (err) {
    log('warn', `typing-analytics per-uid scan failed for ${uid}: ${String(err)}`)
  }
  return units
}

export async function collectAllSyncUnits(): Promise<string[]> {
  const userData = app.getPath('userData')
  const units: string[] = FAVORITE_TYPES.map((type) => `favorites/${type}`)

  try {
    await access(keyboardMetaFilePath())
    units.push(KEYBOARD_META_SYNC_UNIT)
  } catch { /* no meta */ }

  try {
    await access(join(userData, 'sync', KEY_LABEL_SYNC_UNIT, 'index.json'))
    units.push(KEY_LABEL_SYNC_UNIT)
  } catch { /* no key labels */ }

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
      // analyze filter snapshots (index-based, mirrors snapshots layout)
      try {
        await access(join(keyboardsDir, uid, 'analyze_filters', 'index.json'))
        units.push(`keyboards/${uid}/analyze_filters`)
      } catch { /* no analyze filter snapshots */ }
    }
  } catch { /* dir doesn't exist */ }

  // Typing analytics sync units. Own hash only — remote devices' files
  // are owned by their producers and uploaded by them.
  try {
    const machineHash = await getMachineHash()
    const typingUids = getTypingAnalyticsDB().listLocalKeyboardUids(machineHash)
    for (const uid of typingUids) {
      // Per-day bundles: one per day we've recorded against this uid.
      // listDeviceDays returns an empty list if the per-day directory
      // doesn't exist yet, so this silently no-ops on first run.
      for (const day of await listDeviceDays(userData, uid, machineHash)) {
        units.push(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, day))
      }
    }
  } catch (err) {
    // Log instead of silently dropping so a DB schema mismatch or machine
    // hash failure does not silently disable typing-analytics sync forever.
    log('warn', `typing-analytics sync-unit scan failed: ${String(err)}`)
  }

  return units
}
