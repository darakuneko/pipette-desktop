// SPDX-License-Identifier: GPL-2.0-or-later
// UID -> deviceName mapping persisted as a synced "meta/keyboard-names" unit.

import { app } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pLimit } from '../../shared/concurrency'
import { decrypt } from './sync-crypto'
import { downloadFile, driveFileName } from './google-drive'
import type { DriveFile } from './google-drive'
import type { SnapshotIndex } from '../../shared/types/snapshot-store'
import {
  createEmptyKeyboardMetaIndex,
  type KeyboardMetaEntry,
  type KeyboardMetaIndex,
} from '../../shared/types/keyboard-meta'

const META_DIR = 'meta'
const META_FILE = 'keyboard-names.json'
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const DEVICE_NAME_FROM_FILENAME = /^(.+?)_\d{4}-\d{2}-/
const BACKFILL_CONCURRENCY = 5

export function keyboardMetaFilePath(): string {
  return join(app.getPath('userData'), 'sync', META_DIR, META_FILE)
}

function metaFilePath(): string {
  return keyboardMetaFilePath()
}

export async function readKeyboardMetaIndex(): Promise<KeyboardMetaIndex> {
  try {
    const raw = await readFile(metaFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as KeyboardMetaIndex
    if (parsed?.type !== 'keyboard-meta' || !Array.isArray(parsed.entries)) {
      return createEmptyKeyboardMetaIndex()
    }
    return parsed
  } catch {
    return createEmptyKeyboardMetaIndex()
  }
}

async function writeKeyboardMetaIndex(index: KeyboardMetaIndex): Promise<void> {
  const filePath = metaFilePath()
  await mkdir(join(app.getPath('userData'), 'sync', META_DIR), { recursive: true })
  await writeFile(filePath, JSON.stringify(index, null, 2), 'utf-8')
}

// Serialize writes so concurrent upsert/tombstone calls can't clobber each other.
let metaWriteChain: Promise<unknown> = Promise.resolve()

async function withMetaWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = metaWriteChain.then(() => fn(), () => fn())
  metaWriteChain = next.catch(() => undefined)
  return next
}

export function extractDeviceNameFromFilename(filename: string): string | null {
  const match = filename.match(DEVICE_NAME_FROM_FILENAME)
  return match ? match[1] : null
}

function findEntry(index: KeyboardMetaIndex, uid: string): KeyboardMetaEntry | undefined {
  return index.entries.find((entry) => entry.uid === uid)
}

function gcKeyboardMetaTombstones(entries: KeyboardMetaEntry[], now = Date.now()): KeyboardMetaEntry[] {
  return entries.filter((entry) => {
    if (!entry.deletedAt) return true
    const deletedTime = new Date(entry.deletedAt).getTime()
    if (Number.isNaN(deletedTime)) return true
    return now - deletedTime < TOMBSTONE_TTL_MS
  })
}

export async function upsertKeyboardMeta(
  uid: string,
  deviceName: string,
): Promise<'unchanged' | 'upserted'> {
  const normalized = deviceName.trim()
  if (!uid || !normalized) return 'unchanged'
  return withMetaWriteLock(async () => {
    const index = await readKeyboardMetaIndex()
    const existing = findEntry(index, uid)
    const now = new Date().toISOString()
    if (existing) {
      if (!existing.deletedAt && existing.deviceName === normalized) {
        return 'unchanged'
      }
      existing.deviceName = normalized
      existing.updatedAt = now
      delete existing.deletedAt
    } else {
      index.entries.push({ uid, deviceName: normalized, updatedAt: now })
    }
    index.entries = gcKeyboardMetaTombstones(index.entries)
    await writeKeyboardMetaIndex(index)
    return 'upserted'
  })
}

export async function tombstoneKeyboardMeta(uid: string): Promise<'unchanged' | 'tombstoned'> {
  if (!uid) return 'unchanged'
  return withMetaWriteLock(async () => {
    const index = await readKeyboardMetaIndex()
    const existing = findEntry(index, uid)
    const now = new Date().toISOString()
    if (!existing) {
      index.entries.push({ uid, deviceName: '', updatedAt: now, deletedAt: now })
    } else if (existing.deletedAt) {
      return 'unchanged'
    } else {
      existing.updatedAt = now
      existing.deletedAt = now
    }
    index.entries = gcKeyboardMetaTombstones(index.entries)
    await writeKeyboardMetaIndex(index)
    return 'tombstoned'
  })
}

export async function tombstoneAllKeyboardMeta(): Promise<number> {
  return withMetaWriteLock(async () => {
    const index = await readKeyboardMetaIndex()
    const now = new Date().toISOString()
    let count = 0
    for (const entry of index.entries) {
      if (entry.deletedAt) continue
      entry.updatedAt = now
      entry.deletedAt = now
      count++
    }
    if (count > 0) {
      index.entries = gcKeyboardMetaTombstones(index.entries)
      await writeKeyboardMetaIndex(index)
    }
    return count
  })
}

function entryEffectiveTime(entry: KeyboardMetaEntry): number {
  const source = entry.deletedAt ?? entry.updatedAt
  const t = source ? new Date(source).getTime() : 0
  return Number.isNaN(t) ? 0 : t
}

export function mergeKeyboardMetaIndex(
  local: KeyboardMetaIndex,
  remote: KeyboardMetaIndex,
): { merged: KeyboardMetaIndex; remoteNeedsUpdate: boolean } {
  const byUid = new Map<string, { local?: KeyboardMetaEntry; remote?: KeyboardMetaEntry }>()
  for (const entry of local.entries) {
    byUid.set(entry.uid, { ...(byUid.get(entry.uid) ?? {}), local: entry })
  }
  for (const entry of remote.entries) {
    byUid.set(entry.uid, { ...(byUid.get(entry.uid) ?? {}), remote: entry })
  }

  const mergedEntries: KeyboardMetaEntry[] = []
  let remoteNeedsUpdate = false

  for (const { local: l, remote: r } of byUid.values()) {
    if (l && !r) {
      mergedEntries.push(l)
      remoteNeedsUpdate = true
    } else if (!l && r) {
      mergedEntries.push(r)
    } else if (l && r) {
      const lt = entryEffectiveTime(l)
      const rt = entryEffectiveTime(r)
      if (rt > lt) {
        mergedEntries.push(r)
      } else if (lt > rt) {
        mergedEntries.push(l)
        remoteNeedsUpdate = true
      } else {
        mergedEntries.push(l)
      }
    }
  }

  const gced = gcKeyboardMetaTombstones(mergedEntries)
  if (gced.length !== mergedEntries.length) {
    remoteNeedsUpdate = true
  }

  return {
    merged: { type: 'keyboard-meta', version: 1, entries: gced },
    remoteNeedsUpdate,
  }
}

export function extractKeyboardUidsFromDriveFiles(driveFiles: DriveFile[]): string[] {
  const uids = new Set<string>()
  for (const file of driveFiles) {
    const match = file.name.match(/^keyboards_(.+?)_snapshots\.enc$/)
    if (match) uids.add(match[1])
  }
  return Array.from(uids)
}

async function resolveDeviceNameFromLocalSnapshots(uid: string): Promise<string | null> {
  const snapshotIndexPath = join(
    app.getPath('userData'),
    'sync',
    'keyboards',
    uid,
    'snapshots',
    'index.json',
  )
  try {
    const raw = await readFile(snapshotIndexPath, 'utf-8')
    const parsed = JSON.parse(raw) as SnapshotIndex
    const active = parsed.entries?.find((entry) => !entry.deletedAt)
    if (!active) return null
    return extractDeviceNameFromFilename(active.filename)
  } catch {
    return null
  }
}

async function resolveDeviceNameFromRemoteSnapshots(
  uid: string,
  password: string,
  driveFiles: DriveFile[],
): Promise<string | null> {
  const target = driveFiles.find((file) => file.name === driveFileName(`keyboards/${uid}/snapshots`))
  if (!target) return null
  try {
    const envelope = await downloadFile(target.id)
    const plaintext = await decrypt(envelope, password)
    const bundle = JSON.parse(plaintext) as { index?: SnapshotIndex }
    const active = bundle.index?.entries?.find((entry) => !entry.deletedAt)
    if (!active) return null
    return extractDeviceNameFromFilename(active.filename)
  } catch {
    return null
  }
}

export interface BackfillResult {
  resolved: number
  failed: string[]
}

export async function backfillKeyboardMeta(
  password: string,
  driveFiles: DriveFile[],
): Promise<BackfillResult> {
  const metaIndex = await readKeyboardMetaIndex()
  // Skip both active AND tombstoned uids: a tombstone explicitly opts the uid out of backfill
  // until a fresh `upsertKeyboardMeta` (e.g. snapshot save) revives it intentionally.
  const knownUids = new Set(metaIndex.entries.map((entry) => entry.uid))
  const driveUids = extractKeyboardUidsFromDriveFiles(driveFiles)
  const missingUids = driveUids.filter((uid) => !knownUids.has(uid))
  if (missingUids.length === 0) return { resolved: 0, failed: [] }

  const limit = pLimit(BACKFILL_CONCURRENCY)
  const settled = await Promise.allSettled(
    missingUids.map((uid) =>
      limit(async () => {
        const local = await resolveDeviceNameFromLocalSnapshots(uid)
        const deviceName = local ?? (await resolveDeviceNameFromRemoteSnapshots(uid, password, driveFiles))
        return { uid, deviceName }
      }),
    ),
  )

  const toUpsert: { uid: string; deviceName: string }[] = []
  const failed: string[] = []
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    if (r.value.deviceName) {
      toUpsert.push({ uid: r.value.uid, deviceName: r.value.deviceName })
    } else {
      failed.push(r.value.uid)
    }
  }

  const resolved = await batchUpsertKeyboardMeta(toUpsert)
  return { resolved, failed }
}

export async function batchUpsertKeyboardMeta(
  entries: ReadonlyArray<{ uid: string; deviceName: string }>,
): Promise<number> {
  if (entries.length === 0) return 0
  return withMetaWriteLock(async () => {
    const index = await readKeyboardMetaIndex()
    const now = new Date().toISOString()
    let count = 0
    for (const { uid, deviceName } of entries) {
      const normalized = deviceName.trim()
      if (!uid || !normalized) continue
      const existing = findEntry(index, uid)
      if (existing) {
        if (!existing.deletedAt && existing.deviceName === normalized) continue
        existing.deviceName = normalized
        existing.updatedAt = now
        delete existing.deletedAt
      } else {
        index.entries.push({ uid, deviceName: normalized, updatedAt: now })
      }
      count++
    }
    if (count > 0) {
      index.entries = gcKeyboardMetaTombstones(index.entries)
      await writeKeyboardMetaIndex(index)
    }
    return count
  })
}

export function getActiveKeyboardMetaMap(index: KeyboardMetaIndex): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of index.entries) {
    if (entry.deletedAt || !entry.deviceName) continue
    map.set(entry.uid, entry.deviceName)
  }
  return map
}

export async function applyRemoteKeyboardMetaIndex(
  remote: KeyboardMetaIndex,
): Promise<{ remoteNeedsUpdate: boolean }> {
  return withMetaWriteLock(async () => {
    const local = await readKeyboardMetaIndex()
    const { merged, remoteNeedsUpdate } = mergeKeyboardMetaIndex(local, remote)
    await writeKeyboardMetaIndex(merged)
    return { remoteNeedsUpdate }
  })
}
