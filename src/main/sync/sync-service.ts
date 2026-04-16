// SPDX-License-Identifier: GPL-2.0-or-later
// Sync orchestration: bundling, conflict resolution, debounce upload, before-quit flush

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { encrypt, decrypt, retrievePassword, storePassword, clearPassword } from './sync-crypto'
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
import { pLimit } from '../../shared/concurrency'
import { IpcChannels } from '../../shared/ipc/channels'
import { mergeEntries, gcTombstones } from './merge'
import { readIndexFile, bundleSyncUnit, collectAllSyncUnits } from './sync-bundle'
import {
  applyRemoteKeyboardMetaIndex,
  backfillKeyboardMeta,
  getActiveKeyboardMetaMap,
  readKeyboardMetaIndex,
} from './keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT, type KeyboardMetaIndex } from '../../shared/types/keyboard-meta'
import type { SyncBundle, SyncProgress, SyncEnvelope, UndecryptableFile, SyncDataScanResult, SyncScope } from '../../shared/types/sync'

const SYNC_CONCURRENCY = 10
const DEBOUNCE_MS = 10_000
const POLL_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes
const PASSWORD_CHECK_UNIT = 'password-check'
const PASSWORD_CHECK_PAYLOAD = JSON.stringify({ type: 'password-check', version: 1 })

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
let passwordCheckValidated = false
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

export function matchesScope(syncUnit: string | null, scope: SyncScope): boolean {
  if (scope === 'all') return true
  if (syncUnit === null) return false
  if (syncUnit === KEYBOARD_META_SYNC_UNIT) return true // meta follows every scope
  if (scope === 'favorites') return syncUnit.startsWith('favorites/')
  if (typeof scope === 'object' && 'favorites' in scope) {
    return syncUnit.startsWith('favorites/') || syncUnit.startsWith(`keyboards/${scope.keyboard}/`)
  }
  return syncUnit.startsWith(`keyboards/${scope.keyboard}/`)
}

async function listLocalKeyboardUids(): Promise<Set<string>> {
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

function shouldDownloadSyncUnit(
  syncUnit: string | null,
  scope: SyncScope,
  localKeyboardUids: Set<string>,
): boolean {
  if (!syncUnit) return false
  if (!matchesScope(syncUnit, scope)) return false
  // Lazy: when scope is 'all' only download keyboards/<uid>/* that already exist locally.
  // Explicit keyboard scopes always download in full.
  if (syncUnit.startsWith('keyboards/') && scope === 'all') {
    const uid = syncUnit.split('/')[1]
    return !!uid && localKeyboardUids.has(uid)
  }
  return true
}

async function requireSyncCredentials(): Promise<string | null> {
  const authStatus = await getAuthStatus()
  if (!authStatus.authenticated) return null

  return retrievePassword()
}

// --- Remote data inspection ---

async function fetchValidatedDataFiles(): Promise<{ password: string; dataFiles: DriveFile[] } | null> {
  const password = await requireSyncCredentials()
  if (!password) return null
  const remoteFiles = await listFiles()

  await validatePasswordCheck(password, remoteFiles)

  const passwordCheckFileName = driveFileName(PASSWORD_CHECK_UNIT)
  const dataFiles = remoteFiles.filter((f) => f.name !== passwordCheckFileName)
  return { password, dataFiles }
}

async function findUndecryptableFiles(password: string, dataFiles: DriveFile[]): Promise<UndecryptableFile[]> {
  const undecryptable: UndecryptableFile[] = []
  const limit = pLimit(SYNC_CONCURRENCY)
  await Promise.allSettled(
    dataFiles.map((file) =>
      limit(async () => {
        try {
          const envelope = await downloadFile(file.id)
          await decrypt(envelope, password)
        } catch {
          undecryptable.push({
            fileId: file.id,
            fileName: file.name,
            syncUnit: syncUnitFromFileName(file.name),
          })
        }
      }),
    ),
  )
  return undecryptable
}

export async function listUndecryptableFiles(): Promise<UndecryptableFile[]> {
  const result = await fetchValidatedDataFiles()
  if (!result) return []
  return findUndecryptableFiles(result.password, result.dataFiles)
}

export async function scanRemoteData(): Promise<SyncDataScanResult> {
  const result = await fetchValidatedDataFiles()
  if (!result) return { keyboards: [], keyboardNames: {}, favorites: [], undecryptable: [] }
  const { password, dataFiles } = result

  // Categorize from filenames (no download needed)
  const keyboardUids = new Set<string>()
  const favoriteTypes = new Set<string>()
  for (const file of dataFiles) {
    const syncUnit = syncUnitFromFileName(file.name)
    if (!syncUnit) continue
    if (syncUnit.startsWith('keyboards/')) {
      const uid = syncUnit.split('/')[1]
      if (uid) keyboardUids.add(uid)
    } else if (syncUnit.startsWith('favorites/')) {
      const type = syncUnit.split('/')[1]
      if (type) favoriteTypes.add(type)
    }
  }

  // Use whatever names are already in the local meta index (populated by executeSync/backfill
  // and the LIST_STORED_KEYBOARDS safety net). scanRemoteData stays read-only here so it
  // doesn't trigger extra downloads or writes.
  const metaIndex = await readKeyboardMetaIndex()
  const metaMap = getActiveKeyboardMetaMap(metaIndex)
  const keyboardNames: Record<string, string> = {}
  for (const uid of keyboardUids) {
    const name = metaMap.get(uid)
    if (name) keyboardNames[uid] = name
  }

  const undecryptable = await findUndecryptableFiles(password, dataFiles)

  return {
    keyboards: [...keyboardUids],
    keyboardNames,
    favorites: [...favoriteTypes],
    undecryptable,
  }
}

/** Download and decrypt a remote sync unit bundle without merging into local. */
export async function fetchRemoteBundle(syncUnit: string): Promise<SyncBundle | null> {
  const result = await fetchValidatedDataFiles()
  if (!result) return null
  const { password, dataFiles } = result
  const targetName = driveFileName(syncUnit)
  const file = dataFiles.find((f) => f.name === targetName)
  if (!file) return null
  try {
    const envelope = await downloadFile(file.id)
    const plaintext = await decrypt(envelope, password)
    return JSON.parse(plaintext) as SyncBundle
  } catch {
    return null
  }
}

// --- Non-destructive password change ---

export async function changePassword(newPassword: string): Promise<void> {
  if (isSyncing) throw new Error('Cannot change password while sync is in progress')
  isSyncing = true
  try {
    const oldPassword = await requireSyncCredentials()
    if (!oldPassword) throw new Error('No stored password found')
    if (newPassword === oldPassword) throw new Error('sync.samePassword')
    const remoteFiles = await listFiles()

    // Validate old password against password-check first
    await validatePasswordCheck(oldPassword, remoteFiles)

    const passwordCheckFileName = driveFileName(PASSWORD_CHECK_UNIT)
    const dataFiles = remoteFiles.filter((f) => f.name !== passwordCheckFileName)

    // Phase 1: Download + decrypt all files (fail-fast on any error)
    const limit = pLimit(SYNC_CONCURRENCY)
    const decrypted = await Promise.all(
      dataFiles.map((file) =>
        limit(async () => {
          const envelope = await downloadFile(file.id)
          try {
            const plaintext = await decrypt(envelope, oldPassword)
            return { file, plaintext, syncUnit: envelope.syncUnit }
          } catch {
            throw new Error('sync.changePasswordUndecryptable')
          }
        }),
      ),
    )

    // Phase 2: Re-encrypt + upload with new password (overwrite)
    await Promise.all(
      decrypted.map(({ file, plaintext, syncUnit }) =>
        limit(async () => {
          const newEnvelope = await encrypt(plaintext, newPassword, syncUnit)
          await uploadFile(file.name, newEnvelope, file.id)
        }),
      ),
    )

    // Phase 3: Recreate password-check with new password
    const existingPc = remoteFiles.find((f) => f.name === passwordCheckFileName)
    const pcEnvelope = await encrypt(PASSWORD_CHECK_PAYLOAD, newPassword, PASSWORD_CHECK_UNIT)
    await uploadFile(passwordCheckFileName, pcEnvelope, existingPc?.id)

    await storePassword(newPassword)
    resetPasswordCheckCache()
  } finally {
    isSyncing = false
  }
}

// Re-export bundle functions for backward compatibility
export { readIndexFile, bundleSyncUnit, collectAllSyncUnits } from './sync-bundle'

// --- Password check validation ---

class PasswordMismatchError extends Error {
  constructor() {
    super('sync.passwordMismatch')
    this.name = 'PasswordMismatchError'
  }
}

async function validatePasswordCheck(
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const fileName = driveFileName(PASSWORD_CHECK_UNIT)
  const existing = remoteFiles.find((f) => f.name === fileName)

  if (existing) {
    const envelope = await downloadFile(existing.id)
    try {
      await decrypt(envelope, password)
    } catch {
      throw new PasswordMismatchError()
    }
  } else {
    const envelope = await encrypt(PASSWORD_CHECK_PAYLOAD, password, PASSWORD_CHECK_UNIT)
    await uploadFile(fileName, envelope)
  }
  passwordCheckValidated = true
}

export function resetPasswordCheckCache(): void {
  passwordCheckValidated = false
}

export async function checkPasswordCheckExists(): Promise<boolean> {
  const remoteFiles = await listFiles()
  const fileName = driveFileName(PASSWORD_CHECK_UNIT)
  return remoteFiles.some((f) => f.name === fileName)
}

export async function setPasswordAndValidate(password: string): Promise<void> {
  await storePassword(password)
  resetPasswordCheckCache()
  try {
    const remoteFiles = await listFiles()
    await validatePasswordCheck(password, remoteFiles)
  } catch (err) {
    await clearPassword()
    throw err
  }
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

  // Handle meta/keyboard-names (entry-level LWW, no data files)
  if (syncUnit === KEYBOARD_META_SYNC_UNIT) {
    const remoteIndex = remoteBundle.index as KeyboardMetaIndex
    const { remoteNeedsUpdate } = await applyRemoteKeyboardMetaIndex(remoteIndex)
    return remoteNeedsUpdate
  }

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

export async function executeSync(
  direction: 'download' | 'upload',
  scope: SyncScope = 'all',
): Promise<void> {
  if (isSyncing) return
  isSyncing = true

  try {
    const password = await requireSyncCredentials()
    if (!password) return

    emitProgress({ direction, status: 'syncing', message: 'Starting sync...' })

    const initialFiles = await listFiles()

    // Force password re-validation on scope 'all' (changePassword, listUndecryptable)
    // Scoped syncs (including manual sync) respect the cached validation;
    // decryption errors during actual file processing serve as implicit validation
    if (scope === 'all' || !passwordCheckValidated) {
      await validatePasswordCheck(password, initialFiles)
    }

    let failedUnits: string[]
    if (direction === 'download') {
      failedUnits = await executeDownloadSync(password, initialFiles, scope)
      if (scope === 'all') {
        const { resolved } = await backfillKeyboardMeta(password, initialFiles)
        if (resolved > 0) {
          pendingChanges.add(KEYBOARD_META_SYNC_UNIT)
          broadcastPendingStatus()
        }
      }
    } else {
      failedUnits = await executeUploadSync(password, initialFiles, scope)
      // Clear pending changes matching the scope, then re-add failed units
      for (const unit of pendingChanges) {
        if (matchesScope(unit, scope)) pendingChanges.delete(unit)
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

async function executeDownloadSync(
  password: string,
  prefetchedFiles?: DriveFile[],
  scope: SyncScope = 'all',
): Promise<string[]> {
  const remoteFiles = prefetchedFiles ?? await listFiles()
  updateRemoteState(remoteFiles) // Always record full remote state for polling

  const localKeyboardUids = await listLocalKeyboardUids()
  const filesToDownload = remoteFiles.filter((f) => {
    const syncUnit = syncUnitFromFileName(f.name)
    return shouldDownloadSyncUnit(syncUnit, scope, localKeyboardUids)
  })

  const total = filesToDownload.length
  let completed = 0
  const failedUnits: string[] = []
  const limit = pLimit(SYNC_CONCURRENCY)

  await Promise.allSettled(
    filesToDownload.map((remoteFile) =>
      limit(async () => {
        completed++
        const syncUnit = syncUnitFromFileName(remoteFile.name)
        if (!syncUnit) return

        emitProgress({
          direction: 'download',
          status: 'syncing',
          syncUnit,
          current: completed,
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
      }),
    ),
  )

  return failedUnits
}

async function executeUploadSync(
  password: string,
  prefetchedFiles?: DriveFile[],
  scope: SyncScope = 'all',
): Promise<string[]> {
  let syncUnits = await collectAllSyncUnits()
  if (scope !== 'all') {
    syncUnits = syncUnits.filter((unit) => matchesScope(unit, scope))
  }
  const remoteFiles = prefetchedFiles ?? await listFiles()
  updateRemoteState(remoteFiles)
  const total = syncUnits.length
  let completed = 0
  const failedUnits: string[] = []
  const limit = pLimit(SYNC_CONCURRENCY)

  await Promise.allSettled(
    syncUnits.map((syncUnit) =>
      limit(async () => {
        completed++
        emitProgress({
          direction: 'upload',
          status: 'syncing',
          syncUnit,
          current: completed,
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
      }),
    ),
  )

  // Refresh remote state once after all uploads to prevent polling re-downloads
  const updatedFiles = await listFiles()
  updateRemoteState(updatedFiles)

  return failedUnits
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

    if (!passwordCheckValidated) {
      await validatePasswordCheck(password, remoteFiles)
    }

    // First poll: just validate password and record remote state
    // Avoids downloading all files on startup
    if (lastKnownRemoteState.size === 0) {
      updateRemoteState(remoteFiles)
      return
    }

    const localKeyboardUids = await listLocalKeyboardUids()
    const changedFiles = remoteFiles.filter((file) => {
      if (lastKnownRemoteState.get(file.name) === file.modifiedTime) return false
      const syncUnit = syncUnitFromFileName(file.name)
      return shouldDownloadSyncUnit(syncUnit, 'all', localKeyboardUids)
    })

    updateRemoteState(remoteFiles)

    const limit = pLimit(SYNC_CONCURRENCY)
    await Promise.allSettled(
      changedFiles.map((remoteFile) =>
        limit(async () => {
          const syncUnit = syncUnitFromFileName(remoteFile.name)
          if (!syncUnit) return

          try {
            await mergeWithRemote(remoteFile.id, syncUnit, password, remoteFiles)
            emitProgress({
              direction: 'download',
              status: 'success',
              syncUnit,
              message: 'Sync complete',
            })
          } catch {
            // Forget the modifiedTime so the next poll re-detects this file as changed
            // and gets another chance to merge it.
            lastKnownRemoteState.delete(remoteFile.name)
          }
        }),
      ),
    )
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

    if (!passwordCheckValidated) {
      try {
        await validatePasswordCheck(password, remoteFiles)
      } catch (err) {
        for (const unit of changes) pendingChanges.add(unit)
        broadcastPendingStatus()
        if (err instanceof PasswordMismatchError) {
          emitProgress({ direction: 'upload', status: 'error', message: 'sync.passwordMismatch' })
        } else {
          emitProgress({ direction: 'upload', status: 'error', message: errorMessage(err, 'Password check failed') })
        }
        return
      }
    }

    const limit = pLimit(SYNC_CONCURRENCY)
    await Promise.allSettled(
      [...changes].map((syncUnit) =>
        limit(async () => {
          try {
            await syncOrUpload(syncUnit, password, remoteFiles)
          } catch {
            // Re-add failed unit so pending stays true
            pendingChanges.add(syncUnit)
          }
        }),
      ),
    )

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
  passwordCheckValidated = false
}
