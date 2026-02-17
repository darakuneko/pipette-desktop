// SPDX-License-Identifier: GPL-2.0-or-later
// Snapshot store — save/load .pipette snapshots within app userData

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc/channels'
import { notifyChange } from './sync/sync-service'
import { secureHandle } from './ipc-guard'
import type { SnapshotMeta, SnapshotIndex } from '../shared/types/snapshot-store'

const MAX_ENTRIES_PER_KEYBOARD = 30

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\.+$/, '')
    .trim() || 'keyboard'
}

// Reject uid or filename values that could escape the snapshots directory
function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
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

async function readIndex(uid: string): Promise<SnapshotIndex> {
  try {
    const raw = await readFile(getIndexPath(uid), 'utf-8')
    const parsed = JSON.parse(raw) as SnapshotIndex
    if (parsed.uid === uid && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch {
    // Index does not exist or is corrupt — return empty
  }
  return { uid, entries: [] }
}

async function writeIndex(uid: string, index: SnapshotIndex): Promise<void> {
  const dir = getSnapshotDir(uid)
  await mkdir(dir, { recursive: true })
  await writeFile(getIndexPath(uid), JSON.stringify(index, null, 2), 'utf-8')
}

async function updateEntry(
  uid: string,
  entryId: string,
  mutate: (entry: SnapshotMeta) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    validateUid(uid)
    const index = await readIndex(uid)
    const entry = index.entries.find((e) => e.id === entryId)
    if (!entry) return { success: false, error: 'Entry not found' }

    mutate(entry)
    entry.updatedAt = new Date().toISOString()
    await writeIndex(uid, index)
    notifyChange(`keyboards/${uid}/snapshots`)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// Simple per-uid write serialization to prevent race conditions
const writeLocks = new Map<string, Promise<unknown>>()
function withWriteLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(uid) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(uid, next)
  return next
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
    ): Promise<{ success: boolean; entry?: SnapshotMeta; error?: string }> => {
      try {
        validateUid(uid)
        return await withWriteLock(uid, async () => {
          const index = await readIndex(uid)
          const activeCount = index.entries.filter((e) => !e.deletedAt).length
          if (activeCount >= MAX_ENTRIES_PER_KEYBOARD) {
            return { success: false, error: 'max entries reached' }
          }

          const dir = getSnapshotDir(uid)
          await mkdir(dir, { recursive: true })

          const now = new Date()
          const timestamp = now.toISOString().replace(/:/g, '-')
          const safeName = sanitizeFilename(deviceName)
          const filename = `${safeName}_${timestamp}.pipette`
          const filePath = getSafeFilePath(uid, filename)

          await writeFile(filePath, json, 'utf-8')

          const nowIso = now.toISOString()
          const entry: SnapshotMeta = {
            id: randomUUID(),
            label,
            filename,
            savedAt: nowIso,
            updatedAt: nowIso,
          }

          index.entries.unshift(entry)
          await writeIndex(uid, index)

          notifyChange(`keyboards/${uid}/snapshots`)
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
    IpcChannels.SNAPSHOT_STORE_RENAME,
    async (_event, uid: string, entryId: string, newLabel: string) =>
      updateEntry(uid, entryId, (entry) => { entry.label = newLabel }),
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_DELETE,
    async (_event, uid: string, entryId: string) =>
      updateEntry(uid, entryId, (entry) => { entry.deletedAt = new Date().toISOString() }),
  )

  secureHandle(
    IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID,
    async (_event, uid: string, entryId: string, hubPostId: string | null) => {
      const normalized = hubPostId?.trim() || null
      return updateEntry(uid, entryId, (entry) => {
        if (normalized === null) {
          delete entry.hubPostId
        } else {
          entry.hubPostId = normalized
        }
      })
    },
  )
}
