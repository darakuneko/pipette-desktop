// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler registration for sync operations

import { BrowserWindow, app, dialog } from 'electron'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels } from '../../shared/ipc/channels'
import { onAppConfigChange } from '../app-config'
import {
  storedPasswordStatus,
  checkPasswordStrength,
} from './sync-crypto'
import { startOAuthFlow, getAuthStatus } from './google-auth'
import { broadcastToAllWindows } from '../utils/broadcast'
import {
  executeAnalyticsSync,
  executeSync,
  hasPendingChanges,
  notifyChange,
  scheduleFlushIfPending,
  setProgressCallback,
  setupBeforeQuitHandler,
  startPolling,
  stopPolling,
  startPollingIfAutoSync,
  startPollingAtLaunch,
  collectAllSyncUnits,
  bundleSyncUnit,
  getCachedSyncFormatStatus,
  refreshSyncFormatStatus,
  setSyncFormatStatusListener,
  listUndecryptableFiles,
  scanRemoteData,
  fetchRemoteBundle,
  startPasswordChange,
  resumePasswordChange,
  revertPasswordChange,
  abandonPasswordChange,
  deletePasswordChangeUndecryptableFiles,
  recoverPasswordChangeOnStartup,
  getPasswordChangeStatus,
  getPasswordChangeLockStatus,
  releasePasswordChangeLocks,
  checkPasswordCheckExists,
  setPasswordAndValidate,
  replacePasswordAndValidate,
  fetchRemoteTypingDay,
  hasAnyRemoteTypingData,
  listRemoteTypingDaysFor,
  listRemoteTypingHashesForUidFromCloud,
  listRemoteFileNames,
  restorePendingFromDisk,
  adoptPendingForSignedInAccount,
  switchAccountKeepingPending,
  signOutKeepingPending,
  SyncCredentialError,
  withResetLockWhenFree,
  IMPORT_BUSY_MESSAGE,
} from './sync-service'
import { importLocalData } from './local-data-import'
import { exportTypingDataForKeyboard, importTypingDataFiles, type ImportResult } from '../typing-analytics/import-export'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { prepareOwnDeletedRangesReapply } from '../typing-analytics/deleted-ranges-apply'
import { ensureCacheIsFresh } from '../typing-analytics/cache-rebuild'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { runOnFlushChain } from '../typing-analytics/typing-analytics-service'
import type { SyncProgress, PasswordStrength, SyncScope, StoredKeyboardInfo, SyncDataScanResult, SyncBundle, SyncOperationResult, ImportLocalDataResult, PasswordChangeDeleteResult, SyncFormatStatus } from '../../shared/types/sync'
import { secureHandle, secureOn } from '../ipc-guard'
import { wrapIpc } from './sync-ipc-wrap'
import { setupSyncResetIpc } from './sync-reset-ipc'
import type { FavoriteIndex } from '../../shared/types/favorite-store'
import type { SnapshotIndex } from '../../shared/types/snapshot-store'
import {
  extractDeviceNameFromFilename,
  getActiveKeyboardMetaMap,
  readKeyboardMetaIndex,
  upsertKeyboardMeta,
  nameKeyboardOnConnect,
} from './keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { isSafeKey } from '../utils/safe-filename'

function getDialogWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function validateSyncScope(raw: unknown): SyncScope | undefined {
  if (raw == null) return undefined
  if (raw === 'all' || raw === 'favorites' || raw === 'packs') return raw
  if (typeof raw === 'object' && 'keyboard' in raw) {
    const { keyboard } = raw as Record<string, unknown>
    if (typeof keyboard === 'string' && isSafeKey(keyboard)) {
      if ('favorites' in raw && raw.favorites === true) {
        return { favorites: true, keyboard }
      }
      return { keyboard }
    }
  }
  return undefined
}

/** Checks Drive's sync-format markers when signed in. Never throws: null
 *  when signed out, when the auth check fails, or when Drive can't be
 *  listed and nothing was known before. */
async function refreshSyncFormatStatusIfSignedIn(): Promise<SyncFormatStatus | null> {
  try {
    if (!(await getAuthStatus()).authenticated) return null
  } catch {
    return null
  }
  return refreshSyncFormatStatus()
}

/** Writes the picked typing-data files (import-export.ts) and rebuilds the
 *  analytics cache when any were imported. */
async function importTypingFiles(filePaths: string[]): Promise<ImportResult> {
  const userData = app.getPath('userData')
  // Pull the Drive listing once for the whole batch — without this
  // each rejected-but-cloud-known import would round-trip the full
  // appData listing again.
  const remoteNames = await listRemoteFileNames()
  const importResult = await importTypingDataFiles(userData, filePaths, {
    cloudHasFile: remoteNames === null
      ? null
      // Cloud encrypts each sync unit as `<name>.enc`; the export
      // form drops `.enc`, so flip it back here for the lookup.
      : async (name) => remoteNames.has(name.replace(/\.jsonl$/, '.enc')),
    // The flush chain is the only writer of this device's own files, so
    // the replace waits for appends in flight and no append lands in it.
    runExclusive: runOnFlushChain,
    // Typing inside this device's deleted ranges stays deleted, whichever
    // delete wrote the range and whether or not it was applied before.
    prepareReplace: prepareOwnDeletedRangesReapply,
  })
  if (importResult.imported > 0) {
    try {
      const ownHash = await getMachineHash()
      await ensureCacheIsFresh(getTypingAnalyticsDB(), userData, ownHash, { force: true })
    } catch (err) {
      console.warn('[sync-ipc] typing-analytics import: cache rebuild failed; will retry on next launch', err)
    }
  }
  return importResult
}

export function setupSyncIpc(): void {
  // --- Pending changes left by the last run ---
  // Restored before any handler below can queue a change; sent by the
  // usual flush. Ownerless units go to the stored sign-in once its tokens
  // are read (never rejects).
  restorePendingFromDisk()
  void adoptPendingForSignedInAccount().catch((err: unknown) => {
    console.warn('[sync-ipc] could not check the owner of the pending changes', err)
  })
  scheduleFlushIfPending()

  // --- Auth ---
  secureHandle(IpcChannels.SYNC_AUTH_START, () =>
    wrapIpc('Auth failed', async () => {
      // The new tokens are stored holding the sync lock, and the previous
      // account's caches (Hub JWT, password-check, sync-format status) are
      // forgotten. Changes kept while signed out, and those this account
      // left unsent, go to it; another account's changes are held.
      await startOAuthFlow(switchAccountKeepingPending)
      // The account may have changed, so its Drive is checked afresh.
      void refreshSyncFormatStatus()
      scheduleFlushIfPending()
      startPollingIfAutoSync()
    }),
  )

  secureHandle(IpcChannels.SYNC_AUTH_STATUS, () => getAuthStatus())

  secureHandle(IpcChannels.SYNC_AUTH_SIGN_OUT, () =>
    wrapIpc('Sign out failed', async () => {
      // This account's unsent changes are held for its next sign-in; its
      // caches are forgotten once the tokens are gone. A failed sign-out
      // keeps the account signed in, so polling keeps running.
      await signOutKeepingPending()
      stopPolling()
    }),
  )

  // --- Password ---
  secureHandle(
    IpcChannels.SYNC_SET_PASSWORD,
    (_event, password: string) =>
      wrapIpc('Set password failed', async () => {
        await setPasswordAndValidate(password)
        scheduleFlushIfPending()
        startPollingIfAutoSync()
      }),
  )

  // A password changed on another machine: stored only once it opens the
  // password-check on Drive.
  secureHandle(
    IpcChannels.SYNC_REPLACE_PASSWORD,
    (_event, password: string) =>
      wrapIpc('Replace password failed', async () => {
        if (typeof password !== 'string' || password === '') throw new Error('Invalid password')
        await replacePasswordAndValidate(password)
        scheduleFlushIfPending()
        startPollingIfAutoSync()
      }),
  )

  secureHandle(
    IpcChannels.SYNC_CHANGE_PASSWORD,
    (_event, newPassword: string) =>
      wrapIpc('Change password failed', async () => {
        if (typeof newPassword !== 'string' || newPassword === '') throw new Error('Invalid password')
        await startPasswordChange(newPassword)
      }),
  )

  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_STATUS, () => getPasswordChangeStatus())

  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_RESUME, () =>
    wrapIpc('Resume password change failed', () => resumePasswordChange()),
  )

  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_REVERT, () =>
    wrapIpc('Revert password change failed', () => revertPasswordChange()),
  )

  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_ABANDON, () =>
    wrapIpc('Abandon password change failed', () => abandonPasswordChange()),
  )

  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_DELETE_UNDECRYPTABLE, (_event, fileIds: unknown) =>
    wrapIpc<PasswordChangeDeleteResult>('Delete files failed', () => {
      if (!Array.isArray(fileIds) || fileIds.length === 0 || !fileIds.every((id) => typeof id === 'string' && id !== '')) {
        throw new Error('Invalid file IDs')
      }
      return deletePasswordChangeUndecryptableFiles(fileIds)
    }),
  )

  // Neither lock handler goes through the sync guard: releasing the lock
  // is the only way out once a lock blocks every machine.
  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_LOCK_STATUS, () => getPasswordChangeLockStatus())

  secureHandle(IpcChannels.SYNC_PASSWORD_CHANGE_RELEASE_LOCKS, () =>
    wrapIpc('Release lock failed', () => releasePasswordChangeLocks()),
  )

  setupSyncResetIpc()

  secureHandle(IpcChannels.SYNC_PASSWORD_STATUS, () => storedPasswordStatus())

  secureHandle(
    IpcChannels.SYNC_VALIDATE_PASSWORD,
    (_event, password: string): PasswordStrength => checkPasswordStrength(password),
  )

  // --- Sync execution ---
  // Not routed through wrapIpc: that helper only ever returns `{success:
  // true}` when the wrapped fn() doesn't throw, which is exactly the bug
  // that let a busy-race or missing-credentials skip (executeSync
  // returns normally in both cases, never throws) look identical to a
  // real completed sync to every caller — see executeSync's `status`
  // field doc in sync-execute.ts and SyncOperationResult's doc in
  // shared/types/sync.ts. `success` is kept `true` for any non-throwing
  // outcome (including skipped/partial) to preserve existing callers'
  // "did the IPC call itself throw" semantics; `status`/`skipReason`
  // carry the real outcome for callers that need it (useDeviceLifecycle's
  // packsPulledOnce once-flag, usePackCloudPull's error state).
  secureHandle(
    IpcChannels.SYNC_EXECUTE,
    async (_event, direction: 'download' | 'upload', scope?: unknown): Promise<SyncOperationResult> => {
      if (scope != null && validateSyncScope(scope) === undefined) {
        return { success: false, error: 'Invalid sync scope' }
      }
      const validatedScope = validateSyncScope(scope) ?? 'all'
      try {
        const outcome = await executeSync(direction, validatedScope)
        if (direction === 'download') startPollingIfAutoSync()
        return {
          success: true,
          status: outcome.status,
          skipReason: outcome.skipReason,
          error: outcome.status === 'partial'
            ? `${outcome.failedUnits?.length ?? 0} sync unit(s) failed`
            : undefined,
        }
      } catch (err) {
        if (err instanceof SyncCredentialError) {
          return { success: false, error: err.message, reason: err.reason, status: 'skipped', skipReason: err.reason }
        }
        return { success: false, error: err instanceof Error ? err.message : 'Sync failed' }
      }
    },
  )

  // --- Name a keyboard on connect (names a new uid, revives a tombstone;
  //     leaves an active/user-renamed entry untouched) ---
  secureHandle(IpcChannels.KEYBOARD_META_NAME_IF_MISSING, async (_event, uid: string, name: string): Promise<void> => {
    if (typeof uid !== 'string' || !isSafeKey(uid) || typeof name !== 'string') return
    const result = await nameKeyboardOnConnect(uid, name)
    if (result === 'upserted') notifyChange(KEYBOARD_META_SYNC_UNIT)
  })

  // --- List stored keyboards ---
  secureHandle(IpcChannels.LIST_STORED_KEYBOARDS, async (): Promise<StoredKeyboardInfo[]> => {
    const userData = app.getPath('userData')
    const keyboardsDir = join(userData, 'sync', 'keyboards')
    const results: StoredKeyboardInfo[] = []
    const metaIndex = await readKeyboardMetaIndex()
    const metaMap = getActiveKeyboardMetaMap(metaIndex)
    let metaBackfilled = false
    try {
      const entries = await readdir(keyboardsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const uid = entry.name
        if (!isSafeKey(uid)) continue
        let name = metaMap.get(uid) ?? uid
        // Fallback: derive name from snapshot filename and backfill meta
        if (name === uid) {
          try {
            const raw = await readFile(join(keyboardsDir, uid, 'snapshots', 'index.json'), 'utf-8')
            const index = JSON.parse(raw) as SnapshotIndex
            const active = index.entries.find((e) => !e.deletedAt)
            const extracted = active ? extractDeviceNameFromFilename(active.filename) : null
            if (extracted) {
              name = extracted
              const result = await upsertKeyboardMeta(uid, extracted)
              if (result === 'upserted') metaBackfilled = true
            }
          } catch { /* no snapshots */ }
        }
        results.push({ uid, name })
      }
    } catch { /* dir doesn't exist */ }
    if (metaBackfilled) notifyChange(KEYBOARD_META_SYNC_UNIT)
    return results
  })

  // --- Export local data ---
  secureHandle(IpcChannels.EXPORT_LOCAL_DATA, () =>
    wrapIpc('Export failed', async () => {
      const syncUnits = await collectAllSyncUnits()

      // Only sync-bundle types covered by the import contract below are
      // exported. A missing entry is a hard skip rather than a silent
      // fallback so new types don't get misfiled under 'snapshots' — the
      // prior ?? 'snapshots' default hid typing-analytics and
      // keyboard-meta bundles inside the snapshots category even though
      // neither has an importer.
      type ExportCategory = 'favorites' | 'snapshots' | 'settings'
      const bundleTypeToCategory: Partial<Record<SyncBundle['type'], ExportCategory>> = {
        favorite: 'favorites',
        layout: 'snapshots',
        settings: 'settings',
      }
      const categories: Record<ExportCategory, Record<string, { index: FavoriteIndex | SnapshotIndex; files: Record<string, string> }>> = {
        snapshots: {},
        favorites: {},
        settings: {},
      }

      for (const syncUnit of syncUnits) {
        const bundle = await bundleSyncUnit(syncUnit)
        if (!bundle) continue
        const category = bundleTypeToCategory[bundle.type]
        // typing-analytics / keyboard-meta / run-log not in export contract yet —
        // run-log is deliberately absent (highest input-recovery-risk data; never leaves this device via Export Local Data)
        if (!category) continue
        // bundleTypeToCategory only maps 'favorite' / 'layout' / 'settings',
        // so bundle.index is always a FavoriteIndex or SnapshotIndex here —
        // SyncBundle['index'] just isn't discriminated by ['type'] in the type system.
        categories[category][bundle.key] = {
          index: bundle.index as FavoriteIndex | SnapshotIndex,
          files: bundle.files,
        }
      }

      const dialogOpts = {
        defaultPath: `pipette-data-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }
      const win = getDialogWindow()
      const result = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts)
      if (result.canceled || !result.filePath) return

      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        ...categories,
      }
      await writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
    }),
  )

  // --- Import local data ---
  // A cancelled file picker isn't an error, so the wrapped fn returns a
  // `cancelled` payload instead of throwing — wrapIpc merges it into the
  // success result, keeping `cancelled` distinct from a real success or
  // an error. See ImportLocalDataResult's doc.
  secureHandle(IpcChannels.IMPORT_LOCAL_DATA, async (): Promise<ImportLocalDataResult> =>
    wrapIpc<{ cancelled?: true }>('Import failed', async () => {
      const dialogOpts = {
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile' as const],
      }
      const win = getDialogWindow()
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true }
      }

      const raw = await readFile(result.filePaths[0], 'utf-8')
      const data: unknown = JSON.parse(raw)

      const userData = app.getPath('userData')
      const { changedUnits } = await importLocalData(data, userData)

      for (const unit of changedUnits) {
        notifyChange(unit)
      }
    }) as Promise<ImportLocalDataResult>,
  )

  // --- Undecryptable files ---
  secureHandle(IpcChannels.SYNC_LIST_UNDECRYPTABLE, () => listUndecryptableFiles())

  secureHandle(IpcChannels.SYNC_SCAN_REMOTE, (): Promise<SyncDataScanResult> => scanRemoteData())

  secureHandle(IpcChannels.SYNC_FETCH_REMOTE_BUNDLE, (_event, syncUnit: string) => {
    if (typeof syncUnit !== 'string' || !syncUnit) return Promise.resolve(null)
    return fetchRemoteBundle(syncUnit)
  })

  // --- Password check existence ---
  secureHandle(IpcChannels.SYNC_CHECK_PASSWORD_EXISTS, () => checkPasswordCheckExists())

  // --- Sync-format status for the update banner ---
  // Fetched once by the renderer; every later change is pushed.
  secureHandle(IpcChannels.SYNC_FORMAT_STATUS, async (): Promise<SyncFormatStatus | null> =>
    getCachedSyncFormatStatus() ?? refreshSyncFormatStatusIfSignedIn(),
  )
  setSyncFormatStatusListener((status) => {
    broadcastToAllWindows(IpcChannels.SYNC_FORMAT_STATUS_CHANGED, status)
  })

  // --- Pending status (renderer polls on mount) ---
  secureHandle(IpcChannels.SYNC_PENDING_STATUS, () => hasPendingChanges())

  // --- Analyze-panel analytics sync (separate mutex) ---
  secureHandle(
    IpcChannels.SYNC_ANALYTICS_NOW,
    async (_event, uid: unknown): Promise<boolean> => {
      if (typeof uid !== 'string' || uid.length === 0) return false
      return executeAnalyticsSync(uid)
    },
  )

  // --- Typing analytics cloud operations (Sync tab) ---
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_HAS_REMOTE,
    async (): Promise<boolean> => hasAnyRemoteTypingData(),
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_REMOTE_CLOUD_HASHES,
    async (_event, uid: unknown): Promise<string[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      return listRemoteTypingHashesForUidFromCloud(uid)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_REMOTE_CLOUD_DAYS,
    async (_event, uid: unknown, machineHash: unknown): Promise<string[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      return listRemoteTypingDaysFor(uid, machineHash)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_FETCH_REMOTE_DAY,
    async (_event, uid: unknown, machineHash: unknown, utcDay: unknown): Promise<boolean> => {
      if (typeof uid !== 'string' || uid.length === 0) return false
      if (typeof machineHash !== 'string' || machineHash.length === 0) return false
      if (typeof utcDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(utcDay)) return false
      return fetchRemoteTypingDay(uid, machineHash, utcDay)
    },
  )

  // --- Typing analytics export / import ---
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_EXPORT,
    async (_event, uid: unknown, dates: unknown): Promise<{ written: number; cancelled: boolean }> => {
      if (typeof uid !== 'string' || uid.length === 0) {
        return { written: 0, cancelled: true }
      }
      // Empty array short-circuits before opening the dialog so the user
      // doesn't pick a directory just to receive zero files.
      if (!Array.isArray(dates) || dates.length === 0 || dates.some((d) => typeof d !== 'string')) {
        return { written: 0, cancelled: true }
      }
      const result = await dialog.showOpenDialog(getDialogWindow()!, {
        title: 'Export typing data',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { written: 0, cancelled: true }
      }
      const ownHash = await getMachineHash()
      const userData = app.getPath('userData')
      const filter = new Set(dates as string[])
      const out = await exportTypingDataForKeyboard(userData, uid, ownHash, result.filePaths[0], filter)
      return { written: out.written, cancelled: false }
    },
  )

  // The file dialog runs without the lock, so syncing goes on while the
  // user picks. The writes and the cache rebuild hold it for every
  // keyboard: the rebuild re-reads every keyboard's day files and rewrites
  // sync_state.json, which analytics syncs and remote day fetches also
  // write. It waits for a running poll or flush instead of failing at once.
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_IMPORT,
    async () => wrapIpc<{ result: ImportResult; cancelled: boolean }>('Import typing data failed', async () => {
      const dialogResult = await dialog.showOpenDialog(getDialogWindow()!, {
        title: 'Import typing data',
        filters: [{ name: 'Typing data', extensions: ['jsonl'] }],
        properties: ['openFile', 'multiSelections'],
      })
      const empty: ImportResult = { imported: 0, rejections: [] }
      if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
        return { result: empty, cancelled: true }
      }
      const result = await withResetLockWhenFree('all', () => importTypingFiles(dialogResult.filePaths), IMPORT_BUSY_MESSAGE)
      return { result, cancelled: false }
    }),
  )

  // --- Change notification (from stores) ---
  secureOn(IpcChannels.SYNC_NOTIFY_CHANGE, (_event, syncUnit: string) => {
    notifyChange(syncUnit)
  })

  // --- Progress events (main -> renderer) ---
  setProgressCallback((progress: SyncProgress) => {
    broadcastToAllWindows(IpcChannels.SYNC_PROGRESS, progress)
  })

  // --- Before-quit handler ---
  setupBeforeQuitHandler()

  // --- Finish or clean up a password change interrupted by the last exit ---
  // Never rejects: failures are logged and the state stays for next time.
  void recoverPasswordChangeOnStartup()

  // --- Startup sync-format check (never rejects) ---
  void refreshSyncFormatStatusIfSignedIn()

  // --- Startup polling (auto sync only, even with no keyboard connected) ---
  startPollingAtLaunch()

  // --- React to autoSync config changes ---
  onAppConfigChange((key, value) => {
    if (key === 'autoSync') {
      if (value) {
        startPolling()
        // A flush with auto sync off keeps its pending changes.
        scheduleFlushIfPending()
      } else {
        stopPolling()
      }
    }
  })
}
