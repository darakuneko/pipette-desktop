// SPDX-License-Identifier: GPL-2.0-or-later
// Sync orchestration: bundling, conflict resolution, debounce upload, before-quit flush

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, readdir, mkdir, access } from 'node:fs/promises'
import { encrypt, decrypt, retrievePassword } from './sync-crypto'
import { loadAppConfig } from '../app-config'
import { getAuthStatus } from './google-auth'
import {
  listFiles,
  downloadFile,
  uploadFile,
  driveFileName,
  syncUnitFromFileName,
  type DriveFile,
} from './google-drive'
import { IpcChannels } from '../../shared/ipc/channels'
import { mergeEntries, gcTombstones } from './merge'
import type { FavoriteType, FavoriteIndex } from '../../shared/types/favorite-store'
import type { SnapshotIndex } from '../../shared/types/snapshot-store'
import type { SyncBundle, SyncProgress, SyncEnvelope } from '../../shared/types/sync'

const FAVORITE_TYPES: FavoriteType[] = ['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey']
const DEBOUNCE_MS = 10_000
const POLL_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

function safeTimestamp(value: string | undefined): number {
  if (!value) return 0
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

type ProgressCallback = (progress: SyncProgress) => void

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingChanges = new Set<string>()
let progressCallback: ProgressCallback | null = null
let isQuitting = false
let isSyncing = false
let pollTimer: ReturnType<typeof setInterval> | null = null
const lastKnownRemoteState = new Map<string, string>() // fileName -> modifiedTime

export function hasPendingChanges(): boolean {
  return pendingChanges.size > 0
}

export function cancelPendingChanges(prefix?: string): void {
  if (prefix) {
    for (const unit of pendingChanges) {
      if (unit.startsWith(prefix)) pendingChanges.delete(unit)
    }
  } else {
    pendingChanges.clear()
  }
  if (pendingChanges.size === 0 && debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  broadcastPendingStatus()
}

export function isSyncInProgress(): boolean {
  return isSyncing
}

function broadcastPendingStatus(): void {
  const pending = hasPendingChanges()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannels.SYNC_PENDING_STATUS, pending)
  }
}

export function setProgressCallback(cb: ProgressCallback): void {
  progressCallback = cb
}

function emitProgress(progress: SyncProgress): void {
  progressCallback?.(progress)
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

async function requireSyncCredentials(): Promise<string | null> {
  const authStatus = await getAuthStatus()
  if (!authStatus.authenticated) return null

  return retrievePassword()
}

// --- Bundle creation ---

export async function readIndexFile(dir: string): Promise<FavoriteIndex | SnapshotIndex | null> {
  try {
    const raw = await readFile(join(dir, 'index.json'), 'utf-8')
    return JSON.parse(raw) as FavoriteIndex | SnapshotIndex
  } catch {
    return null
  }
}

export async function bundleSyncUnit(syncUnit: string): Promise<SyncBundle | null> {
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

// --- Sync operations ---

async function uploadSyncUnit(
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  const bundle = await bundleSyncUnit(syncUnit)
  if (!bundle) return

  const plaintext = JSON.stringify(bundle)
  const envelope = await encrypt(plaintext, password, syncUnit)

  const files = remoteFiles ?? await listFiles()
  const targetName = driveFileName(syncUnit)
  const existing = files.find((f) => f.name === targetName)

  await uploadFile(targetName, envelope, existing?.id)
}

// Merges remote bundle into local state, returns whether remote needs update
async function mergeSyncUnit(
  syncUnit: string,
  envelope: SyncEnvelope,
  password: string,
): Promise<boolean> {
  const plaintext = await decrypt(envelope, password)
  const remoteBundle = JSON.parse(plaintext) as SyncBundle

  const parts = syncUnit.split('/')
  const userData = app.getPath('userData')

  // Handle settings sync unit (single-file LWW)
  if (parts.length === 3 && parts[0] === 'keyboards' && parts[2] === 'settings') {
    const dir = join(userData, 'sync', 'keyboards', parts[1])
    await mkdir(dir, { recursive: true })

    const filePath = join(dir, 'pipette_settings.json')
    const remoteContent = remoteBundle.files['pipette_settings.json']
    if (!remoteContent) return false

    let localTime = 0
    try {
      const raw = await readFile(filePath, 'utf-8')
      const local = JSON.parse(raw) as { _updatedAt?: string }
      localTime = safeTimestamp(local._updatedAt)
    } catch { /* no local settings */ }

    const remoteSettings = JSON.parse(remoteContent) as { _updatedAt?: string }
    const remoteTime = safeTimestamp(remoteSettings._updatedAt)

    if (remoteTime > localTime) {
      await writeFile(filePath, remoteContent, 'utf-8')
      return false
    }
    return localTime > remoteTime
  }

  // Handle index-based sync units (favorites, snapshots)
  const basePath = join(userData, 'sync', ...parts)
  await mkdir(basePath, { recursive: true })

  const localIndex = await readIndexFile(basePath)
  const localEntries = gcTombstones(localIndex?.entries ?? [])
  const remoteEntries = gcTombstones(remoteBundle.index.entries)

  // Merge entries (both sides GC'd to prevent expired-tombstone upload loops)
  const result = mergeEntries(localEntries, remoteEntries)

  // Copy files from remote bundle for entries that remote won
  for (const filename of result.remoteFilesToCopy) {
    if (filename in remoteBundle.files) {
      await writeFile(join(basePath, filename), remoteBundle.files[filename], 'utf-8')
    }
  }

  // Write merged index
  const mergedIndex = localIndex
    ? { ...localIndex, entries: result.entries }
    : remoteBundle.index
  await writeFile(
    join(basePath, 'index.json'),
    JSON.stringify(mergedIndex, null, 2),
    'utf-8',
  )

  return result.remoteNeedsUpdate
}

// Merges with remote, uploads if local has changes remote doesn't have
async function mergeWithRemote(
  remoteFileId: string,
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  const envelope = await downloadFile(remoteFileId)
  const needsUpload = await mergeSyncUnit(syncUnit, envelope, password)

  if (needsUpload) {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
  }
}

async function syncOrUpload(
  syncUnit: string,
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const targetName = driveFileName(syncUnit)
  const remoteFile = remoteFiles.find((f) => f.name === targetName)

  if (remoteFile) {
    await mergeWithRemote(remoteFile.id, syncUnit, password, remoteFiles)
  } else {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
  }
}

export async function executeSync(direction: 'download' | 'upload'): Promise<void> {
  if (isSyncing) return
  isSyncing = true

  try {
    const password = await requireSyncCredentials()
    if (!password) return

    emitProgress({ direction, status: 'syncing', message: 'Starting sync...' })

    let failedUnits: string[]
    if (direction === 'download') {
      failedUnits = await executeDownloadSync(password)
    } else {
      failedUnits = await executeUploadSync(password)
      // Manual upload covers all sync units — clear pending, but re-add failed units
      if (pendingChanges.size > 0) {
        pendingChanges.clear()
      }
      for (const unit of failedUnits) {
        pendingChanges.add(unit)
      }
      broadcastPendingStatus()
    }

    if (failedUnits.length === 0) {
      emitProgress({ direction, status: 'success', message: 'Sync complete' })
    } else {
      emitProgress({
        direction,
        status: 'partial',
        message: `${failedUnits.length} sync unit(s) failed`,
        failedUnits,
      })
    }
  } catch (err) {
    emitProgress({
      direction,
      status: 'error',
      message: errorMessage(err, 'Sync failed'),
    })
    throw err
  } finally {
    isSyncing = false
  }
}

async function executeDownloadSync(password: string): Promise<string[]> {
  const remoteFiles = await listFiles()
  updateRemoteState(remoteFiles)
  const total = remoteFiles.length
  let current = 0
  const failedUnits: string[] = []

  for (const remoteFile of remoteFiles) {
    current++
    const syncUnit = syncUnitFromFileName(remoteFile.name)
    if (!syncUnit) continue

    emitProgress({
      direction: 'download',
      status: 'syncing',
      syncUnit,
      current,
      total,
    })

    try {
      await mergeWithRemote(remoteFile.id, syncUnit, password, remoteFiles)
    } catch (err) {
      failedUnits.push(syncUnit)
      emitProgress({
        direction: 'download',
        status: 'error',
        syncUnit,
        message: errorMessage(err, 'Download failed'),
      })
    }
  }

  return failedUnits
}

async function executeUploadSync(password: string): Promise<string[]> {
  const syncUnits = await collectAllSyncUnits()
  const remoteFiles = await listFiles()
  updateRemoteState(remoteFiles)
  const total = syncUnits.length
  let current = 0
  const failedUnits: string[] = []

  for (const syncUnit of syncUnits) {
    current++
    emitProgress({
      direction: 'upload',
      status: 'syncing',
      syncUnit,
      current,
      total,
    })

    try {
      await syncOrUpload(syncUnit, password, remoteFiles)
    } catch (err) {
      failedUnits.push(syncUnit)
      emitProgress({
        direction: 'upload',
        status: 'error',
        syncUnit,
        message: errorMessage(err, 'Upload failed'),
      })
    }
  }

  // Refresh remote state once after all uploads to prevent polling re-downloads
  const updatedFiles = await listFiles()
  updateRemoteState(updatedFiles)

  return failedUnits
}

export async function collectAllSyncUnits(): Promise<string[]> {
  const userData = app.getPath('userData')
  const units = FAVORITE_TYPES.map((type) => `favorites/${type}`)

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

// --- Remote state tracking ---

function updateRemoteState(files: DriveFile[]): void {
  lastKnownRemoteState.clear()
  for (const file of files) {
    lastKnownRemoteState.set(file.name, file.modifiedTime)
  }
}

// --- Polling ---

async function pollForRemoteChanges(): Promise<void> {
  if (isSyncing) return
  isSyncing = true

  try {
    const password = await requireSyncCredentials()
    if (!password) return

    const remoteFiles = await listFiles()
    const changedFiles = remoteFiles.filter(
      (file) => lastKnownRemoteState.get(file.name) !== file.modifiedTime,
    )

    updateRemoteState(remoteFiles)

    for (const remoteFile of changedFiles) {
      const syncUnit = syncUnitFromFileName(remoteFile.name)
      if (!syncUnit) continue

      try {
        await mergeWithRemote(remoteFile.id, syncUnit, password, remoteFiles)
        emitProgress({
          direction: 'download',
          status: 'success',
          syncUnit,
          message: 'Sync complete',
        })
      } catch {
        // Polling merge failed — will retry next poll
      }
    }
  } catch {
    // Polling failed — will retry next interval
  } finally {
    isSyncing = false
  }
}

export function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void pollForRemoteChanges()
  }, POLL_INTERVAL_MS)
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// --- Debounced upload ---

export function notifyChange(syncUnit: string): void {
  pendingChanges.add(syncUnit)
  broadcastPendingStatus()

  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    void flushPendingChanges()
  }, DEBOUNCE_MS)
}

async function flushPendingChanges(): Promise<void> {
  if (pendingChanges.size === 0) return

  if (isSyncing) {
    debounceTimer = setTimeout(() => {
      void flushPendingChanges()
    }, DEBOUNCE_MS)
    return
  }

  isSyncing = true

  debounceTimer = null

  try {
    const config = await loadAppConfig()
    if (!config.autoSync) {
      pendingChanges.clear()
      broadcastPendingStatus()
      return
    }

    const password = await requireSyncCredentials()
    if (!password) {
      pendingChanges.clear()
      broadcastPendingStatus()
      return
    }

    const changes = new Set(pendingChanges)
    pendingChanges.clear()

    emitProgress({ direction: 'upload', status: 'syncing', message: 'Auto-sync starting...' })

    const remoteFiles = await listFiles()
    updateRemoteState(remoteFiles)

    for (const syncUnit of changes) {
      try {
        await syncOrUpload(syncUnit, password, remoteFiles)
      } catch {
        // Re-add failed unit so pending stays true
        pendingChanges.add(syncUnit)
      }
    }

    broadcastPendingStatus()

    // Refresh remote state after uploads to prevent polling re-downloads
    const updatedFiles = await listFiles()
    updateRemoteState(updatedFiles)

    if (pendingChanges.size === 0) {
      emitProgress({ direction: 'upload', status: 'success', message: 'Sync complete' })
    } else {
      emitProgress({ direction: 'upload', status: 'error', message: 'Some sync units failed' })
    }
  } finally {
    isSyncing = false
  }
}

// --- Before-quit handler ---

export function setupBeforeQuitHandler(): void {
  app.on('before-quit', (e) => {
    if (isQuitting) return

    stopPolling()

    if (pendingChanges.size === 0 && !debounceTimer) return

    e.preventDefault()
    isQuitting = true

    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    flushPendingChanges()
      .catch(() => {})
      .finally(() => {
        app.quit()
      })
  })
}

// --- Test helpers ---

export function _resetForTests(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  stopPolling()
  pendingChanges.clear()
  lastKnownRemoteState.clear()
  isSyncing = false
  isQuitting = false
  progressCallback = null
}
