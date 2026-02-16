// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler registration for sync operations

import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { IpcChannels } from '../../shared/ipc/channels'
import { loadAppConfig, getAppConfigStore, onAppConfigChange } from '../app-config'
import {
  storePassword,
  hasStoredPassword,
  checkPasswordStrength,
} from './sync-crypto'
import { startOAuthFlow, getAuthStatus, signOut } from './google-auth'
import { deleteAllFiles, deleteFilesByPrefix } from './google-drive'
import {
  executeSync,
  hasPendingChanges,
  cancelPendingChanges,
  isSyncInProgress,
  notifyChange,
  setProgressCallback,
  setupBeforeQuitHandler,
  startPolling,
  stopPolling,
  collectAllSyncUnits,
  bundleSyncUnit,
  readIndexFile,
} from './sync-service'
import type { SyncProgress, PasswordStrength, SyncResetTargets, LocalResetTargets } from '../../shared/types/sync'
import type { FavoriteIndex, SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { SnapshotIndex, SnapshotMeta } from '../../shared/types/snapshot-store'

interface IpcResult {
  success: boolean
  error?: string
}

async function wrapIpc(fallbackMessage: string, fn: () => Promise<void>): Promise<IpcResult> {
  try {
    await fn()
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : fallbackMessage }
  }
}

function getDialogWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

type EntryMeta = SavedFavoriteMeta | SnapshotMeta

interface ImportBundle<T extends EntryMeta> {
  index: { entries: T[] }
  files: Record<string, string>
}

const SAFE_FILENAME_RE = /^[\w.()-]+$/

function isSafePath(basePath: string, filename: string): boolean {
  if (!SAFE_FILENAME_RE.test(filename)) return false
  const resolved = resolve(basePath, filename)
  return resolved.startsWith(basePath + '/')
}

function isSafeKey(key: string): boolean {
  return /^[\w-]+$/.test(key) && !key.includes('..')
}

async function mergeImportEntries<T extends EntryMeta>(
  basePath: string,
  bundle: ImportBundle<T>,
  buildIndex: (localIndex: FavoriteIndex | SnapshotIndex | null, entries: T[]) => FavoriteIndex | SnapshotIndex,
): Promise<boolean> {
  await mkdir(basePath, { recursive: true })

  const localIndex = await readIndexFile(basePath) as FavoriteIndex | SnapshotIndex | null
  const localEntries = (localIndex?.entries ?? []) as T[]
  const localMap = new Map(localEntries.map((e) => [e.id, e]))
  let changed = false

  for (const entry of bundle.index.entries) {
    if (!isSafePath(basePath, entry.filename)) continue

    const existing = localMap.get(entry.id)
    if (existing && !existing.deletedAt) continue

    if (existing) {
      const idx = localEntries.indexOf(existing)
      localEntries[idx] = entry
    } else {
      localEntries.push(entry)
    }

    if (entry.filename in bundle.files) {
      await writeFile(join(basePath, entry.filename), bundle.files[entry.filename], 'utf-8')
    }
    changed = true
  }

  if (changed) {
    const mergedIndex = buildIndex(localIndex, localEntries)
    await writeFile(join(basePath, 'index.json'), JSON.stringify(mergedIndex, null, 2), 'utf-8')
  }

  return changed
}

export function setupSyncIpc(): void {
  // --- Auth ---
  ipcMain.handle(IpcChannels.SYNC_AUTH_START, () =>
    wrapIpc('Auth failed', () => startOAuthFlow()),
  )

  ipcMain.handle(IpcChannels.SYNC_AUTH_STATUS, () => getAuthStatus())

  ipcMain.handle(IpcChannels.SYNC_AUTH_SIGN_OUT, () =>
    wrapIpc('Sign out failed', async () => {
      stopPolling()
      await signOut()
    }),
  )

  // --- Password ---
  ipcMain.handle(
    IpcChannels.SYNC_SET_PASSWORD,
    (_event, password: string) =>
      wrapIpc('Store password failed', () => storePassword(password)),
  )

  ipcMain.handle(
    IpcChannels.SYNC_RESET_PASSWORD,
    (_event, password: string) =>
      wrapIpc('Reset password failed', async () => {
        await deleteAllFiles()
        await storePassword(password)
      }),
  )

  ipcMain.handle(IpcChannels.SYNC_RESET_TARGETS, (_event, targets: SyncResetTargets) =>
    wrapIpc('Reset sync targets failed', async () => {
      if (typeof targets !== 'object' || targets === null) throw new Error('Invalid targets')
      if (typeof targets.keyboards !== 'boolean' || typeof targets.favorites !== 'boolean') {
        throw new Error('Invalid targets: expected boolean fields')
      }
      if (!targets.keyboards && !targets.favorites) throw new Error('No targets selected')
      if (isSyncInProgress()) throw new Error('Cannot reset while sync is in progress')
      if (targets.keyboards) {
        cancelPendingChanges('keyboards/')
        await deleteFilesByPrefix('keyboards_')
      }
      if (targets.favorites) {
        cancelPendingChanges('favorites/')
        await deleteFilesByPrefix('favorites_')
      }
    }),
  )

  ipcMain.handle(IpcChannels.SYNC_HAS_PASSWORD, () => hasStoredPassword())

  ipcMain.handle(
    IpcChannels.SYNC_VALIDATE_PASSWORD,
    (_event, password: string): PasswordStrength => checkPasswordStrength(password),
  )

  // --- Sync execution ---
  ipcMain.handle(
    IpcChannels.SYNC_EXECUTE,
    (_event, direction: 'download' | 'upload') =>
      wrapIpc('Sync failed', async () => {
        await executeSync(direction)
        if (direction === 'download') {
          const config = loadAppConfig()
          if (config.autoSync) {
            startPolling()
          }
        }
      }),
  )

  // --- Reset keyboard data (per-device) ---
  ipcMain.handle(IpcChannels.RESET_KEYBOARD_DATA, (_event, uid: string) =>
    wrapIpc('Reset keyboard data failed', async () => {
      if (isSyncInProgress()) throw new Error('Cannot reset while sync is in progress')
      if (!isSafeKey(uid)) {
        throw new Error('Invalid uid')
      }
      cancelPendingChanges(`keyboards/${uid}/`)
      const userData = app.getPath('userData')
      await rm(join(userData, 'sync', 'keyboards', uid), { recursive: true, force: true })
      // Best-effort remote deletion
      await deleteFilesByPrefix(`keyboards_${uid}_`).catch(() => {})
    }),
  )

  // --- Reset local targets ---
  ipcMain.handle(IpcChannels.RESET_LOCAL_TARGETS, (_event, targets: LocalResetTargets) =>
    wrapIpc('Reset local targets failed', async () => {
      if (typeof targets !== 'object' || targets === null) throw new Error('Invalid targets')
      if (typeof targets.keyboards !== 'boolean' || typeof targets.favorites !== 'boolean' || typeof targets.appSettings !== 'boolean') {
        throw new Error('Invalid targets: expected boolean fields')
      }
      if (!targets.keyboards && !targets.favorites && !targets.appSettings) throw new Error('No targets selected')
      if (isSyncInProgress()) throw new Error('Cannot reset while sync is in progress')
      const userData = app.getPath('userData')
      const allSelected = targets.keyboards && targets.favorites && targets.appSettings
      if (allSelected) {
        cancelPendingChanges()
        stopPolling()
      } else {
        if (targets.keyboards) cancelPendingChanges('keyboards/')
        if (targets.favorites) cancelPendingChanges('favorites/')
        // Clearing appSettings resets autoSync config, so stop polling to match
        if (targets.appSettings) stopPolling()
      }
      if (targets.keyboards) {
        await rm(join(userData, 'sync', 'keyboards'), { recursive: true, force: true })
      }
      if (targets.favorites) {
        await rm(join(userData, 'sync', 'favorites'), { recursive: true, force: true })
      }
      if (targets.appSettings) {
        getAppConfigStore().clear()
        await rm(join(userData, 'local', 'auth'), { recursive: true, force: true })
        await rm(join(userData, 'local', 'downloads', 'languages'), { recursive: true, force: true })
        await rm(join(userData, 'local', 'logs'), { recursive: true, force: true })
      }
    }),
  )

  // --- Export local data ---
  ipcMain.handle(IpcChannels.EXPORT_LOCAL_DATA, () =>
    wrapIpc('Export failed', async () => {
      const syncUnits = await collectAllSyncUnits()

      const bundleTypeToCategory: Record<string, string> = {
        favorite: 'favorites',
        layout: 'snapshots',
        settings: 'settings',
      }
      const categories: Record<string, Record<string, { index: FavoriteIndex | SnapshotIndex; files: Record<string, string> }>> = {
        snapshots: {},
        favorites: {},
        settings: {},
      }

      for (const syncUnit of syncUnits) {
        const bundle = await bundleSyncUnit(syncUnit)
        if (!bundle) continue
        const category = bundleTypeToCategory[bundle.type] ?? 'snapshots'
        categories[category][bundle.key] = { index: bundle.index, files: bundle.files }
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
  ipcMain.handle(IpcChannels.IMPORT_LOCAL_DATA, () =>
    wrapIpc('Import failed', async () => {
      const dialogOpts = {
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile' as const],
      }
      const win = getDialogWindow()
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (result.canceled || result.filePaths.length === 0) return

      const raw = await readFile(result.filePaths[0], 'utf-8')
      const data: unknown = JSON.parse(raw)

      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('Invalid export file format')
      }
      const obj = data as Record<string, unknown>
      if (obj.version !== 1) {
        throw new Error('Unsupported export version')
      }

      const userData = app.getPath('userData')
      const changedUnits: string[] = []

      // Import snapshots (index-based, keyed by uid)
      if (obj.snapshots && typeof obj.snapshots === 'object' && !Array.isArray(obj.snapshots)) {
        const snapshots = obj.snapshots as Record<string, ImportBundle<SnapshotMeta>>
        for (const [uid, bundle] of Object.entries(snapshots)) {
          if (!isSafeKey(uid)) continue
          const changed = await mergeImportEntries(
            join(userData, 'sync', 'keyboards', uid, 'snapshots'),
            bundle,
            (local, merged) => local
              ? { ...local, entries: merged } as SnapshotIndex
              : { uid, entries: merged } as SnapshotIndex,
          )
          if (changed) changedUnits.push(`keyboards/${uid}/snapshots`)
        }
      }

      // Import settings (single-file LWW, keyed by uid)
      if (obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings)) {
        const settings = obj.settings as Record<string, { files: Record<string, string> }>
        for (const [uid, bundle] of Object.entries(settings)) {
          if (!isSafeKey(uid)) continue
          const remoteContent = bundle.files['pipette_settings.json']
          if (!remoteContent) continue

          const dir = join(userData, 'sync', 'keyboards', uid)
          await mkdir(dir, { recursive: true })
          const filePath = join(dir, 'pipette_settings.json')

          let shouldWrite = true
          try {
            const localRaw = await readFile(filePath, 'utf-8')
            const localSettings = JSON.parse(localRaw) as { _updatedAt?: string }
            const remoteSettings = JSON.parse(remoteContent) as { _updatedAt?: string }
            const localTime = localSettings._updatedAt ? new Date(localSettings._updatedAt).getTime() : 0
            const remoteTime = remoteSettings._updatedAt ? new Date(remoteSettings._updatedAt).getTime() : 0
            shouldWrite = remoteTime > localTime
          } catch { /* no local — write */ }

          if (shouldWrite) {
            await writeFile(filePath, remoteContent, 'utf-8')
            changedUnits.push(`keyboards/${uid}/settings`)
          }
        }
      }

      // Import favorites (index-based, keyed by type)
      if (obj.favorites && typeof obj.favorites === 'object' && !Array.isArray(obj.favorites)) {
        const favorites = obj.favorites as Record<string, ImportBundle<SavedFavoriteMeta>>
        for (const [type, bundle] of Object.entries(favorites)) {
          if (!isSafeKey(type)) continue
          const changed = await mergeImportEntries(
            join(userData, 'sync', 'favorites', type),
            bundle,
            (local, merged) => local
              ? { ...local, entries: merged } as FavoriteIndex
              : { type: type as FavoriteIndex['type'], entries: merged } as FavoriteIndex,
          )
          if (changed) changedUnits.push(`favorites/${type}`)
        }
      }

      for (const unit of changedUnits) {
        notifyChange(unit)
      }
    }),
  )

  // --- Pending status (renderer polls on mount) ---
  ipcMain.handle(IpcChannels.SYNC_PENDING_STATUS, () => hasPendingChanges())

  // --- Cancel pending changes ---
  ipcMain.handle(IpcChannels.SYNC_CANCEL_PENDING, () => {
    cancelPendingChanges()
    return { success: true } satisfies IpcResult
  })

  // --- Change notification (from stores) ---
  ipcMain.on(IpcChannels.SYNC_NOTIFY_CHANGE, (_event, syncUnit: string) => {
    notifyChange(syncUnit)
  })

  // --- Progress events (main -> renderer) ---
  setProgressCallback((progress: SyncProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.SYNC_PROGRESS, progress)
    }
  })

  // --- Before-quit handler ---
  setupBeforeQuitHandler()

  // --- React to autoSync config changes ---
  onAppConfigChange((key, value) => {
    if (key === 'autoSync') {
      if (value) {
        startPolling()
      } else {
        stopPolling()
      }
    }
  })
}
