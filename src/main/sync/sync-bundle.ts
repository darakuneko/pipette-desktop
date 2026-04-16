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
import type { SyncBundle } from '../../shared/types/sync'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'

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

  return units
}
