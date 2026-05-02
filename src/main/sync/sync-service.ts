// SPDX-License-Identifier: GPL-2.0-or-later
// Sync orchestration: bundling, conflict resolution, debounce upload, before-quit flush

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { encrypt, decrypt, retrievePasswordResult, storePassword, clearPassword } from './sync-crypto'
import { loadAppConfig } from '../app-config'
import { getAuthStatus } from './google-auth'
import {
  listFiles,
  downloadFile,
  uploadFile,
  deleteFile,
  driveFileName,
  syncUnitFromFileName,
  type DriveFile,
} from './google-drive'
import { unlink } from 'node:fs/promises'
import { pLimit } from '../../shared/concurrency'
import { IpcChannels } from '../../shared/ipc/channels'
import { mergeEntries, gcTombstones } from './merge'
import {
  readIndexFile,
  bundleSyncUnit,
  collectAllSyncUnits,
  collectAnalyticsSyncUnitsForUid,
  isAnalyticsSyncUnit,
} from './sync-bundle'
import {
  applyRemoteKeyboardMetaIndex,
  backfillKeyboardMeta,
  getActiveKeyboardMetaMap,
  readKeyboardMetaIndex,
} from './keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT, type KeyboardMetaIndex } from '../../shared/types/keyboard-meta'
import { KEY_LABEL_SYNC_UNIT } from '../key-label-store'
import {
  parseTypingAnalyticsDeviceDaySyncUnit,
  parseTypingAnalyticsDeviceSyncUnit,
  typingAnalyticsDeviceDaySyncUnit,
} from '../typing-analytics/sync'
import { applyRowsToCache } from '../typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../typing-analytics/jsonl/jsonl-reader'
import {
  deviceDayDir,
  deviceDayJsonlPath,
  deviceJsonlPath,
  devicesDir,
  listDeviceDays,
  readPointerKey,
} from '../typing-analytics/jsonl/paths'
import { utcDayBoundaryMs, type UtcDay } from '../typing-analytics/jsonl/utc-day'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { getMachineHash } from '../typing-analytics/machine-hash'
import {
  emptySyncState,
  isReconcilePending,
  loadSyncState,
  saveSyncState,
  type TypingSyncState,
} from '../typing-analytics/sync-state'
import { log } from '../logger'
import type { SyncBundle, SyncProgress, SyncEnvelope, UndecryptableFile, SyncDataScanResult, SyncScope, SyncCredentialFailureReason, SyncCredentialResult } from '../../shared/types/sync'
import { syncCredentialI18nKey } from '../../shared/types/sync'

export class SyncCredentialError extends Error {
  readonly reason: SyncCredentialFailureReason
  constructor(reason: SyncCredentialFailureReason, namespace: 'readiness' | 'changePasswordError' = 'changePasswordError') {
    super(syncCredentialI18nKey(namespace, reason))
    this.reason = reason
  }
}

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
  if (syncUnit === KEY_LABEL_SYNC_UNIT) return true // key-labels follow every scope (global, all-keyboard)
  if (scope === 'favorites') return syncUnit.startsWith('favorites/')
  if (typeof scope === 'object' && 'favorites' in scope) {
    return syncUnit.startsWith('favorites/') || syncUnit.startsWith(`keyboards/${scope.keyboard}/`)
  }
  return syncUnit.startsWith(`keyboards/${scope.keyboard}/`)
}

// Re-export the analytics-sync-unit detector so existing callers
// (sync-ipc, tests) keep importing it from sync-service.
export { isAnalyticsSyncUnit }

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
  // connect progress bar stays short.
  if (typeof scope === 'object' && 'favorites' in scope && isAnalyticsSyncUnit(syncUnit)) {
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

async function requireSyncCredentials(): Promise<SyncCredentialResult> {
  const authStatus = await getAuthStatus()
  if (!authStatus.authenticated) return { ok: false, reason: 'unauthenticated' }
  return retrievePasswordResult()
}

// --- Remote data inspection ---

async function fetchValidatedDataFiles(): Promise<{ password: string; dataFiles: DriveFile[] } | null> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return null
  const { password } = credentials
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
  if (isSyncing) throw new Error('sync.changePasswordInProgress')
  isSyncing = true
  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) throw new SyncCredentialError(credentials.reason)
    const oldPassword = credentials.password
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

  // Post-upload bookkeeping: record a successful cloud upload for v7
  // per-day units so the reconcile logic can later distinguish
  // "never uploaded" from "uploaded then remotely deleted".
  const dayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (dayRef) await recordDayUploaded(dayRef)
}

/** Add `{uid}|{hash}` → utcDay to sync-state.uploaded after a
 * successful cloud upload. Idempotent: the list is kept sorted and
 * duplicate-free so repeated uploads of the current-day file don't
 * grow the array. */
async function recordDayUploaded(dayRef: {
  uid: string
  machineHash: string
  utcDay: UtcDay
}): Promise<void> {
  const userData = app.getPath('userData')
  const ownHash = await getMachineHash()
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  const pointerKey = readPointerKey(dayRef.uid, dayRef.machineHash)
  const existing = new Set(state.uploaded[pointerKey] ?? [])
  if (existing.has(dayRef.utcDay)) return
  existing.add(dayRef.utcDay)
  state.uploaded[pointerKey] = Array.from(existing).sort()
  state.last_synced_at = Date.now()
  await saveSyncState(userData, state)
}

/** Write the downloaded v6 flat JSONL to the owning device's local
 * path, then replay only the rows after the previously-applied pointer
 * into the cache DB. Leaves the sync-state file with an updated pointer
 * so the next pass skips already-applied rows. No-op when the unit's
 * machineHash matches our own (our local file is the authoritative copy
 * and will be re-uploaded on the next flush). */
async function mergeDeviceBundle(
  remoteBundle: SyncBundle,
  deviceRef: { uid: string; machineHash: string },
  userData: string,
  ownHash: string,
): Promise<void> {
  if (deviceRef.machineHash === ownHash) return
  const data = remoteBundle.files['data.jsonl']
  if (!data) return

  const localPath = deviceJsonlPath(userData, deviceRef.uid, deviceRef.machineHash)
  await mkdir(devicesDir(userData, deviceRef.uid), { recursive: true })
  await writeFile(localPath, data, 'utf-8')

  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  const pointerKey = readPointerKey(deviceRef.uid, deviceRef.machineHash)
  const priorPointer = state.read_pointers[pointerKey] ?? null

  const { rows, lastId } = await readRows(localPath, { afterId: priorPointer })
  if (rows.length > 0) {
    applyRowsToCache(getTypingAnalyticsDB(), rows)
  }
  state.read_pointers[pointerKey] = lastId
  state.last_synced_at = Date.now()
  await saveSyncState(userData, state)
}

/** Write a downloaded v7 per-day JSONL under the owning device's
 * `{hash}/` directory and apply any rows newer than the pointer. Each
 * day is a distinct file so a partial download of one day does not
 * affect other days for the same remote hash. No-op when the unit's
 * machineHash matches our own. */
async function mergeDeviceDayBundle(
  remoteBundle: SyncBundle,
  dayRef: { uid: string; machineHash: string; utcDay: UtcDay },
  userData: string,
  ownHash: string,
): Promise<void> {
  if (dayRef.machineHash === ownHash) return
  const data = remoteBundle.files['data.jsonl']
  if (!data) return

  const localPath = deviceDayJsonlPath(userData, dayRef.uid, dayRef.machineHash, dayRef.utcDay)
  await mkdir(deviceDayDir(userData, dayRef.uid, dayRef.machineHash), { recursive: true })
  await writeFile(localPath, data, 'utf-8')

  // Per-day bundles are replayed in full, not against the hash-level
  // `read_pointers` — the pointer points at whatever day was last
  // processed for this hash, so fetching an older day afterwards would
  // see `afterId` already past every row in that file and apply 0
  // rows. The LWW merge is idempotent, so replaying the whole day is
  // cheap and correct. `read_pointers` only tracks v6 flat merges.
  const { rows } = await readRows(localPath)
  if (rows.length > 0) {
    applyRowsToCache(getTypingAnalyticsDB(), rows)
  }
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  state.last_synced_at = Date.now()
  await saveSyncState(userData, state)
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

  // Typing-analytics JSONL: each file is owned by one device. Skip our
  // own hash so a stale remote never clobbers freshly-flushed local
  // rows. For a remote device's file we overwrite the local copy and
  // replay only the newly-appended rows into the cache.
  const dayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (dayRef) {
    await mergeDeviceDayBundle(remoteBundle, dayRef, userData, await getMachineHash())
    return false
  }
  const deviceRef = parseTypingAnalyticsDeviceSyncUnit(syncUnit)
  if (deviceRef) {
    await mergeDeviceBundle(remoteBundle, deviceRef, userData, await getMachineHash())
    return false
  }

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
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) {
      emitProgress({
        direction,
        status: 'error',
        reason: credentials.reason,
        message: syncCredentialI18nKey('readiness', credentials.reason),
      })
      return
    }
    const password = credentials.password

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

/** Scan the remote file list for v7 per-day typing-analytics units
 * owned by `ownHash`, grouped by keyboard uid. Units with a malformed
 * filename are skipped. */
function collectRemoteOwnHashDays(
  remoteFiles: DriveFile[],
  ownHash: string,
): Map<string, Map<UtcDay, DriveFile>> {
  const perUid = new Map<string, Map<UtcDay, DriveFile>>()
  for (const file of remoteFiles) {
    const unit = syncUnitFromFileName(file.name)
    if (!unit) continue
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.machineHash !== ownHash) continue
    let byDay = perUid.get(ref.uid)
    if (!byDay) {
      byDay = new Map<UtcDay, DriveFile>()
      perUid.set(ref.uid, byDay)
    }
    byDay.set(ref.utcDay, file)
  }
  return perUid
}

/** Reconcile the own-hash cloud state with local + uploaded bookkeeping
 * before the regular upload pass runs. Three transitions are applied:
 *
 *   Rule 2 — `uploaded` has day X, local does not: user or Local-delete
 *     removed the file locally → delete the cloud copy as well.
 *   Rule 3 — `uploaded` has day X, cloud does not: a Sync-delete from
 *     another device or a GC step removed the cloud copy → drop the
 *     local file and let the next cache rebuild resync (rows added
 *     post-delete are preserved because they were never in `uploaded`).
 *   Orphan — when `reconciled_at` is pending for (uid, ownHash), also
 *     delete any cloud day that is neither in local nor in `uploaded`
 *     (leftover from a previous install / pre-migration state).
 *
 * Rules 2 and 3 run on every pass; orphan cleanup only on the first
 * pass after a cache rebuild or fresh install, then `reconciled_at`
 * is timestamped so the expensive listing is skipped afterwards. */
async function reconcileOwnHashTypingAnalytics(
  remoteFiles: DriveFile[],
  userData: string,
  ownHash: string,
): Promise<{ state: TypingSyncState; mutated: boolean }> {
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  const remotePerUid = collectRemoteOwnHashDays(remoteFiles, ownHash)

  // Every uid that appears in any of the three sources needs a pass:
  // local files, uploaded bookkeeping, or remote cloud listing. Union
  // them so a fully-remote-only uid (no local files left) still gets
  // reconciled.
  const candidateUids = new Set<string>()
  for (const key of Object.keys(state.uploaded)) {
    const parts = key.split('|')
    if (parts.length === 2 && parts[1] === ownHash) candidateUids.add(parts[0])
  }
  for (const uid of remotePerUid.keys()) candidateUids.add(uid)
  try {
    for (const entry of await readdir(join(userData, 'sync', 'keyboards'), { withFileTypes: true })) {
      if (entry.isDirectory()) candidateUids.add(entry.name)
    }
  } catch { /* no keyboards dir */ }

  let mutated = false
  for (const uid of candidateUids) {
    const pointerKey = readPointerKey(uid, ownHash)
    const localDays = new Set<UtcDay>(await listDeviceDays(userData, uid, ownHash))
    const uploadedDays = new Set<UtcDay>(state.uploaded[pointerKey] ?? [])
    const cloudDays = remotePerUid.get(uid) ?? new Map<UtcDay, DriveFile>()

    // Rule 2: uploaded but not local — delete from cloud.
    for (const day of Array.from(uploadedDays)) {
      if (localDays.has(day)) continue
      const cloudFile = cloudDays.get(day)
      if (cloudFile) {
        try {
          await deleteFile(cloudFile.id)
        } catch (err) {
          log('warn', `typing-analytics cloud delete failed for ${uid} ${day}: ${String(err)}`)
        }
        cloudDays.delete(day)
      }
      uploadedDays.delete(day)
      mutated = true
    }

    // Rule 3: uploaded but not cloud — another device Sync-deleted us.
    for (const day of Array.from(uploadedDays)) {
      if (cloudDays.has(day)) continue
      try {
        await unlink(deviceDayJsonlPath(userData, uid, ownHash, day))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('warn', `typing-analytics local delete failed for ${uid} ${day}: ${String(err)}`)
        }
      }
      localDays.delete(day)
      uploadedDays.delete(day)
      mutated = true
    }

    // Orphan cleanup on first reconcile only. Cloud days that are
    // neither local nor in `uploaded` are leftovers (pre-migration
    // flat bundles converted to per-day, or data from a removed
    // install). Deleting them avoids surprising re-download prompts.
    if (isReconcilePending(state, uid, ownHash)) {
      for (const [day, cloudFile] of Array.from(cloudDays.entries())) {
        if (localDays.has(day) || uploadedDays.has(day)) continue
        try {
          await deleteFile(cloudFile.id)
        } catch (err) {
          log('warn', `typing-analytics orphan delete failed for ${uid} ${day}: ${String(err)}`)
        }
        cloudDays.delete(day)
      }
      state.reconciled_at[pointerKey] = Date.now()
      mutated = true
    }

    // Persist the trimmed uploaded list (sorted for determinism so
    // the JSON-on-disk diff stays stable).
    state.uploaded[pointerKey] = Array.from(uploadedDays).sort()
  }

  if (mutated) {
    state.last_synced_at = Date.now()
    await saveSyncState(userData, state)
  }
  return { state, mutated }
}

/** Snapshot of the user's appData Drive listing as a name-only set,
 * for callers that need many existence checks (e.g. import). Returns
 * `null` when the user is unauthenticated so the caller can fall back
 * to a local-only check rather than rejecting outright. */
export async function listRemoteFileNames(): Promise<Set<string> | null> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return null
  const remoteFiles = await listFiles()
  return new Set(remoteFiles.map((f) => f.name))
}

/** True iff cloud currently holds at least one typing per-day file
 * owned by a non-own device. Used to decide whether the Sync > Typing
 * nav subtree is worth showing at all — a single listing is much
 * cheaper than expanding every keyboard. Returns `false` when the
 * user is unauthenticated. */
export async function hasAnyRemoteTypingData(): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const ownHash = await getMachineHash()
  const remoteFiles = await listFiles()
  for (const file of remoteFiles) {
    const unit = syncUnitFromFileName(file.name)
    if (!unit) continue
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.machineHash === ownHash) continue
    return true
  }
  return false
}

/** Distinct remote machineHash values (non-own) that cloud currently
 * holds any per-day file for under `uid`. Used by the Sync > Typing
 * subtree to discover remote devices before the user has ever opened
 * one — the cache-only `listRemoteHashesForUid` misses hashes that
 * haven't been merged locally yet. Sorted for stable UI order. */
export async function listRemoteTypingHashesForUidFromCloud(
  uid: string,
): Promise<string[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return []
  const ownHash = await getMachineHash()
  const remoteFiles = await listFiles()
  const hashes = new Set<string>()
  for (const file of remoteFiles) {
    const unit = syncUnitFromFileName(file.name)
    if (!unit) continue
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.uid !== uid || ref.machineHash === ownHash) continue
    hashes.add(ref.machineHash)
  }
  return Array.from(hashes).sort()
}

/** List the UTC days that cloud currently holds for a remote device
 * `(uid, machineHash)`. Returned in ascending lexicographic order so
 * callers can feed the list straight into a Sync > Typing > Device
 * tree without post-processing. An unauthenticated / network-failed
 * call returns an empty array — UIs surface the network error via
 * scanRemoteData or the sync progress channel separately. */
export async function listRemoteTypingDaysFor(
  uid: string,
  machineHash: string,
): Promise<UtcDay[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return []
  const remoteFiles = await listFiles()
  const perUid = collectRemoteOwnHashDays(remoteFiles, machineHash)
  const days = perUid.get(uid)
  if (!days) return []
  return Array.from(days.keys()).sort()
}

/** Delete the cloud copy of a specific (uid, machineHash, day) and
 * its local mirror if we previously downloaded it. Used by the Sync >
 * Typing > Device > Delete-day UX: another device's record is gone
 * from cloud, and when that device next syncs the reconcile pass will
 * see its `uploaded` entry without a cloud file and drop its own
 * local copy (rule 3). Own-hash cache rows are accepted as stale until
 * the next rebuild — they live in the machine that owns the day.
 * Returns `true` when a cloud delete actually ran, `false` when the
 * user is unauthenticated or the cloud file was already missing. */
export async function deleteRemoteTypingDay(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const remoteFiles = await listFiles()
  const targetName = driveFileName(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, utcDay))
  const remoteFile = remoteFiles.find((f) => f.name === targetName)
  const userData = app.getPath('userData')
  try {
    await unlink(deviceDayJsonlPath(userData, uid, machineHash, utcDay))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('warn', `typing-analytics local delete failed for ${uid} ${machineHash} ${utcDay}: ${String(err)}`)
    }
  }
  // Tombstone the remote hash's cache rows for this day so the Data
  // modal list refreshes immediately after the delete. Scoped to the
  // single hash + day so a same-day local contribution stays visible.
  try {
    const { startMs, endMs } = utcDayBoundaryMs(utcDay)
    const updatedAt = Date.now()
    getTypingAnalyticsDB().tombstoneRowsForUidHashInRange(uid, machineHash, startMs, endMs, updatedAt)
  } catch (err) {
    log('warn', `typing-analytics cache tombstone failed for ${uid} ${machineHash} ${utcDay}: ${String(err)}`)
  }
  if (!remoteFile) return false
  await deleteFile(remoteFile.id)
  return true
}

/** Lazily fetch a single remote (uid, machineHash, day) into the
 * local cache. Returns `true` when the day was downloaded and merged,
 * `false` when the cloud copy was missing or a credential check failed.
 * Designed for the Sync > Typing > Device lazy-expand flow so the UI
 * can pull in only the days the user actually opens. */
export async function fetchRemoteTypingDay(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const { password } = credentials
  const remoteFiles = await listFiles()
  const targetName = driveFileName(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, utcDay))
  const file = remoteFiles.find((f) => f.name === targetName)
  if (!file) return false
  const envelope = await downloadFile(file.id)
  const plaintext = await decrypt(envelope, password)
  const remoteBundle = JSON.parse(plaintext) as SyncBundle
  const userData = app.getPath('userData')
  const ownHash = await getMachineHash()
  await mergeDeviceDayBundle(remoteBundle, { uid, machineHash, utcDay }, userData, ownHash)
  return true
}

async function executeUploadSync(
  password: string,
  prefetchedFiles?: DriveFile[],
  scope: SyncScope = 'all',
): Promise<string[]> {
  const remoteFilesInitial = prefetchedFiles ?? await listFiles()
  // Run own-hash typing-analytics reconcile before collecting units so
  // deleted cloud days don't get re-uploaded and vice-versa. The
  // reconcile only deletes when it detects a divergence; when nothing
  // changed we reuse the initial snapshot to keep the N+1 invariant.
  let mutatedDuringReconcile = false
  try {
    const ownHash = await getMachineHash()
    const result = await reconcileOwnHashTypingAnalytics(
      remoteFilesInitial,
      app.getPath('userData'),
      ownHash,
    )
    mutatedDuringReconcile = result.mutated
  } catch (err) {
    log('warn', `typing-analytics reconcile failed: ${String(err)}`)
  }
  let syncUnits = await collectAllSyncUnits()
  if (scope !== 'all') {
    syncUnits = syncUnits.filter((unit) => matchesScope(unit, scope))
  }
  const remoteFiles = mutatedDuringReconcile ? await listFiles() : remoteFilesInitial
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
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) return  // polling stays silent — manual sync surfaces the reason
    const password = credentials.password

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
      // analytics: handled by executeAnalyticsSync (Analyze panel mount).
      if (syncUnit && isAnalyticsSyncUnit(syncUnit)) return false
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

// --- Analyze-panel analytics sync ---

/** Per-uid mutex so switching between keyboards while the previous
 * sync is still running doesn't immediately skip the new uid. Uses
 * a Set instead of a single flag so `uid-a` and `uid-b` can proceed
 * in parallel — the cloud file namespace (`keyboards/{uid}/devices/*`)
 * is disjoint across uids so there is no conflict. */
const analyticsSyncingUids = new Set<string>()

/** Pull + push typing-analytics bundles for one keyboard, triggered
 * from the Analyze panel mount. Runs on its own per-uid mutex so
 * polling / manual sync stay untouched — the cloud file namespace is
 * disjoint (only `keyboards/{uid}/devices/*` is written) so there is
 * no conflict with the global `isSyncing` path.
 *
 * Returns true on a fully-successful pass so the caller can stamp a
 * rate-limit timestamp; returns false on skip (this uid is already
 * syncing or credentials are missing) or on any per-unit failure so
 * the caller can retry on the next Analyze mount. */
export async function executeAnalyticsSync(uid: string): Promise<boolean> {
  if (analyticsSyncingUids.has(uid)) return false
  analyticsSyncingUids.add(uid)
  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) return false
    const password = credentials.password

    const remoteFiles = await listFiles()
    const prefix = `keyboards/${uid}/devices/`
    let anyFailure = false
    const limit = pLimit(SYNC_CONCURRENCY)
    // Units `mergeWithRemote` already handled — it uploads any
    // divergence internally, so the push pass can skip them.
    const mergedUnits = new Set<string>()

    await Promise.allSettled(
      remoteFiles.map((file) =>
        limit(async () => {
          const unit = syncUnitFromFileName(file.name)
          if (!unit || !isAnalyticsSyncUnit(unit)) return
          if (!unit.startsWith(prefix)) return
          try {
            await mergeWithRemote(file.id, unit, password, remoteFiles)
            mergedUnits.add(unit)
          } catch {
            anyFailure = true
          }
        }),
      ),
    )

    const localUnits = await collectAnalyticsSyncUnitsForUid(uid)
    await Promise.allSettled(
      localUnits
        .filter((unit) => !mergedUnits.has(unit))
        .map((unit) =>
          limit(async () => {
            try {
              await syncOrUpload(unit, password, remoteFiles)
            } catch {
              anyFailure = true
            }
          }),
        ),
    )

    return !anyFailure
  } catch {
    return false
  } finally {
    analyticsSyncingUids.delete(uid)
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

    const credentials = await requireSyncCredentials()
    if (!credentials.ok) {
      pendingChanges.clear()
      broadcastPendingStatus()
      return
    }
    const password = credentials.password

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

interface BeforeQuitFinalizer {
  hasWork: () => boolean
  run: () => Promise<void>
}

const preSyncFinalizers: BeforeQuitFinalizer[] = []
const extraFinalizers: BeforeQuitFinalizer[] = []

/**
 * Register a finalizer that runs BEFORE the sync flush at before-quit time.
 * Use this when the subsystem's flush may enqueue new sync units via
 * notifyChange() — running pre-sync guarantees the freshly queued units land
 * in the same quit cycle instead of waiting for the next launch.
 */
export function registerPreSyncQuitFinalizer(finalizer: BeforeQuitFinalizer): void {
  preSyncFinalizers.push(finalizer)
}

/**
 * Register an additional async finalizer to run alongside the sync flush at
 * before-quit time. Used by subsystems that do not touch the sync queue.
 */
export function registerBeforeQuitFinalizer(finalizer: BeforeQuitFinalizer): void {
  extraFinalizers.push(finalizer)
}

export function setupBeforeQuitHandler(): void {
  app.on('before-quit', (e) => {
    if (isQuitting) return

    stopPolling()

    const syncPending = pendingChanges.size > 0 || debounceTimer !== null
    const preSync = preSyncFinalizers.filter((f) => f.hasWork())
    const extras = extraFinalizers.filter((f) => f.hasWork())
    if (!syncPending && preSync.length === 0 && extras.length === 0) return

    e.preventDefault()
    isQuitting = true

    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const runQuitPhases = async (): Promise<void> => {
      // Phase 1: pre-sync finalizers. They may call notifyChange() to
      // enqueue additional sync units; those land in pendingChanges before
      // the sync flush starts.
      if (preSync.length > 0) {
        await Promise.all(
          preSync.map((f) =>
            f.run().catch((err: unknown) => {
              log('error', `pre-sync quit finalizer failed: ${String(err)}`)
            }),
          ),
        )
      }

      // Phase 2: sync flush. Re-evaluate pendingChanges because pre-sync
      // finalizers may have added to it.
      if (syncPending || pendingChanges.size > 0) {
        await flushPendingChanges().catch((err: unknown) => {
          log('error', `before-quit sync flush failed: ${String(err)}`)
        })
      }

      // Phase 3: remaining extra finalizers. Re-check hasWork() so nothing
      // is run twice if it also happens to sit on the extra list.
      const extrasAfter = extraFinalizers.filter((f) => f.hasWork())
      if (extrasAfter.length > 0) {
        await Promise.all(
          extrasAfter.map((f) =>
            f.run().catch((err: unknown) => {
              log('error', `extra quit finalizer failed: ${String(err)}`)
            }),
          ),
        )
      }
    }

    // Always call app.quit() even if a phase unexpectedly throws, so the
    // app cannot hang on the preventDefault()'d quit.
    runQuitPhases()
      .catch((err: unknown) => {
        log('error', `before-quit phases crashed: ${String(err)}`)
      })
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
  preSyncFinalizers.length = 0
  extraFinalizers.length = 0
}
