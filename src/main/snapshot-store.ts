// SPDX-License-Identifier: GPL-2.0-or-later
// Snapshot store — save/load .pipette snapshots within app userData

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc/channels'
import { notifyChange } from './sync/sync-service'
import { withWriteLock } from './per-uid-write-lock'
import { upsertKeyboardMeta } from './sync/keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT } from '../shared/types/keyboard-meta'
import { secureHandle } from './ipc-guard'
import { isSafePathSegment, tsForFilename } from './utils/safe-filename'
import { writeFileAtomic } from './utils/write-file-atomic'
import { buildSnapshotFilename } from '../shared/snapshot-filename'
import type { SnapshotMeta, SnapshotIndex, SnapshotUpdateOptions } from '../shared/types/snapshot-store'
import type { HubPrivateLink } from '../shared/types/hub-private'
import { type ClockedEntry, type MetaGroup, clockMs, setClock } from './sync/entry-clocks'
import { applyEntryMutation, createEntry, normalizeEntries, overwriteEntry } from './sync/entry-write'
import { readIndexMigrated } from './sync/body-filename-migration'

type SnapshotEntry = ClockedEntry<SnapshotMeta>

interface ClockedSnapshotIndex {
  uid: string
  entries: SnapshotEntry[]
}

const MAX_ENTRIES_PER_KEYBOARD = 30

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\.+$/, '')
    .trim() || 'keyboard'
}

function validateUid(uid: string): void {
  if (!isSafePathSegment(uid)) throw new Error('Invalid uid')
}

function getSnapshotDir(uid: string): string {
  return join(app.getPath('userData'), 'sync', 'keyboards', uid, 'snapshots')
}

function getIndexPath(uid: string): string {
  return join(getSnapshotDir(uid), 'index.json')
}

function getSafeFilePath(uid: string, filename: string): string {
  if (!isSafePathSegment(filename)) throw new Error('Invalid filename')
  return join(getSnapshotDir(uid), filename)
}

async function readIndex(uid: string): Promise<ClockedSnapshotIndex> {
  try {
    const raw = await readFile(getIndexPath(uid), 'utf-8')
    const parsed = JSON.parse(raw) as SnapshotIndex
    if (parsed.uid === uid && Array.isArray(parsed.entries)) {
      return { ...parsed, entries: normalizeEntries('snapshots', parsed.entries) }
    }
  } catch {
    // Index does not exist or is corrupt — return empty
  }
  return { uid, entries: [] }
}

async function writeIndex(uid: string, index: ClockedSnapshotIndex): Promise<void> {
  const dir = getSnapshotDir(uid)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(getIndexPath(uid), JSON.stringify(index, null, 2))
}

/** `readIndex` for a caller holding the uid lock: also moves body files
 *  to id-carrying names (`migrateBodyFilenames`). */
function readIndexLocked(uid: string): Promise<ClockedSnapshotIndex> {
  return readIndexMigrated('snapshots', getSnapshotDir(uid), () => readIndex(uid), (index) => writeIndex(uid, index))
}

/** `group` is the clock the mutation moves; `'delete'` tombstones the
 *  entry instead. */
async function updateEntry(
  uid: string,
  entryId: string,
  group: MetaGroup | 'delete',
  mutate: (entry: SnapshotEntry) => void = () => {},
): Promise<{ success: boolean; error?: string }> {
  return withWriteLock(uid, async () => {
    try {
      validateUid(uid)
      const index = await readIndexLocked(uid)
      if (!applyEntryMutation(index.entries, entryId, group, new Date(), mutate)) return { success: false, error: 'Entry not found' }
      await writeIndex(uid, index)
      notifyChange(`keyboards/${uid}/snapshots`)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

export function setupSnapshotStore(): void {
  secureHandle(
    IpcChannels.SNAPSHOT_STORE_LIST,
    async (_event, uid: string): Promise<{ success: boolean; entries?: SnapshotMeta[]; error?: string }> => {
      try {
        validateUid(uid)
        const index = await readIndex(uid)
        return { success: true, entries: index.entries.filter((e) => !e.deletedAt) }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_SAVE,
    async (
      _event,
      uid: string,
      json: string,
      deviceName: string,
      label: string,
      vilVersion?: number,
    ): Promise<{ success: boolean; entry?: SnapshotMeta; error?: string }> => {
      try {
        validateUid(uid)
        return await withWriteLock(uid, async () => {
          const index = await readIndexLocked(uid)
          const activeCount = index.entries.filter((e) => !e.deletedAt).length
          if (activeCount >= MAX_ENTRIES_PER_KEYBOARD) {
            return { success: false, error: 'max entries reached' }
          }

          const dir = getSnapshotDir(uid)
          await mkdir(dir, { recursive: true })

          const now = new Date()
          const id = randomUUID()
          const filename = buildSnapshotFilename(sanitizeFilename(deviceName), tsForFilename(now), id)
          const filePath = getSafeFilePath(uid, filename)

          await writeFile(filePath, json, 'utf-8')

          const entry = createEntry('snapshots', { id, label, filename, savedAt: now.toISOString(), vilVersion }, now)

          index.entries.unshift(entry)
          await writeIndex(uid, index)

          notifyChange(`keyboards/${uid}/snapshots`)

          const metaResult = await upsertKeyboardMeta(uid, deviceName)
          if (metaResult === 'upserted') {
            notifyChange(KEYBOARD_META_SYNC_UNIT)
          }

          return { success: true, entry }
        })
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_LOAD,
    async (_event, uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        validateUid(uid)
        const index = await readIndex(uid)
        const entry = index.entries.find((e) => e.id === entryId)
        if (!entry) return { success: false, error: 'Entry not found' }
        if (entry.deletedAt) return { success: false, error: 'Entry has been deleted' }

        const filePath = getSafeFilePath(uid, entry.filename)
        const data = await readFile(filePath, 'utf-8')
        return { success: true, data }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_UPDATE,
    async (
      _event,
      uid: string,
      entryId: string,
      json: string,
      vilVersion?: number,
      options?: SnapshotUpdateOptions,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        validateUid(uid)
        const migrateFrom = typeof options?.migrateFrom === 'string' ? options.migrateFrom : undefined
        return await withWriteLock(uid, async () => {
          const index = await readIndexLocked(uid)
          const at = index.entries.findIndex((e) => e.id === entryId)
          if (at < 0) return { success: false, error: 'Entry not found' }
          const entry = index.entries[at]
          const next = { ...entry, ...(vilVersion != null ? { vilVersion } : {}) }
          if (migrateFrom !== undefined) {
            const migrated = await migrateSnapshotBody(uid, entry, next, json, migrateFrom)
            if (!migrated.success) return migrated
            index.entries[at] = migrated.entry
          } else {
            // A user save: brings a deleted entry back (`overwriteEntry`).
            await writeFile(getSafeFilePath(uid, entry.filename), json, 'utf-8')
            index.entries[at] = overwriteEntry('snapshots', entry, next, new Date(), { body: true, explicit: true })
          }
          await writeIndex(uid, index)

          notifyChange(`keyboards/${uid}/snapshots`)
          return { success: true }
        })
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_RENAME,
    async (_event, uid: string, entryId: string, newLabel: string) =>
      updateEntry(uid, entryId, 'name', (entry) => { entry.label = newLabel }),
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_DELETE,
    async (_event, uid: string, entryId: string) =>
      updateEntry(uid, entryId, 'delete'),
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID,
    async (_event, uid: string, entryId: string, hubPostId: string | null) => {
      const normalized = hubPostId?.trim() || null
      return updateEntry(uid, entryId, 'hub', (entry) => {
        if (normalized === null) {
          delete entry.hubPostId
        } else {
          entry.hubPostId = normalized
          // public and private linkage are mutually exclusive
          delete entry.hubPrivate
        }
      })
    },
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_SET_HUB_PRIVATE,
    async (_event, uid: string, entryId: string, link: HubPrivateLink | null) =>
      setSnapshotHubPrivate(uid, entryId, link),
  )
}

/** The mechanical v1 → v2 rewrite of `entry`'s body (see
 *  `SnapshotUpdateOptions`): refused for a deleted entry or a body that is
 *  no longer `migrateFrom`; the body clock moves 1 ms past its old value,
 *  not to now. */
async function migrateSnapshotBody(
  uid: string,
  entry: SnapshotEntry,
  next: SnapshotEntry,
  json: string,
  migrateFrom: string,
): Promise<{ success: true; entry: SnapshotEntry } | { success: false; error: string }> {
  if (entry.deletedAt) return { success: false, error: 'Entry has been deleted' }
  const filePath = getSafeFilePath(uid, entry.filename)
  if ((await readFile(filePath, 'utf-8')) !== migrateFrom) return { success: false, error: 'Entry changed since it was read' }
  await writeFile(filePath, json, 'utf-8')
  return { success: true, entry: setClock(next, 'body', new Date(clockMs(entry.clocks.body) + 1).toISOString()) }
}

/** Sets (or clears with `null`) the private Hub linkage on a snapshot
 *  entry. Setting a link clears the mutually-exclusive public `hubPostId`. */
export async function setSnapshotHubPrivate(
  uid: string,
  entryId: string,
  link: HubPrivateLink | null,
): Promise<{ success: boolean; error?: string }> {
  return updateEntry(uid, entryId, 'hub', (entry) => {
    if (link === null) {
      delete entry.hubPrivate
    } else {
      entry.hubPrivate = link
      delete entry.hubPostId
    }
  })
}
