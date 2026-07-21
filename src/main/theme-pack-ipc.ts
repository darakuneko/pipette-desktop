// SPDX-License-Identifier: GPL-2.0-or-later
//
// IPC handlers for the theme pack store. Follows the same thin-handler
// pattern as i18n-pack-ipc.ts — validation lives in shared/theme/validate.ts
// and the main process treats pack JSON as opaque blobs that round-trip
// via the dialog.

import { BrowserWindow, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import { secureHandle } from './ipc-guard'
import {
  listMetas,
  getPack,
  savePack,
  renamePack,
  deletePack,
  setHubPostId,
  hasActiveName,
  exportPackToDialog,
  reorderActive,
} from './theme-pack-store'
import type {
  ThemePackMeta,
  ThemePackRecord,
  ThemePackStoreResult,
  ThemePackImportDialogResult,
  ThemePackImportFile,
} from '../shared/types/theme-store'

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannels.THEME_PACK_CHANGED)
  }
}

/** Read + parse a single file selected via the multi-select import dialog.
 *  Never throws — a read or parse failure is reported via `parseError` so
 *  one bad file in the batch does not abort the rest. */
async function readOneImportFile(filePath: string): Promise<ThemePackImportFile> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    try {
      const parsed: unknown = JSON.parse(raw)
      return { filePath, raw: parsed, fileSizeBytes: Buffer.byteLength(raw, 'utf-8') }
    } catch (err) {
      return { filePath, fileSizeBytes: Buffer.byteLength(raw, 'utf-8'), parseError: String(err) }
    }
  } catch (err) {
    return { filePath, parseError: String(err) }
  }
}

export function setupThemePackStore(): void {
  secureHandle(
    IpcChannels.THEME_PACK_STORE_LIST,
    async (): Promise<ThemePackStoreResult<ThemePackMeta[]>> => {
      try {
        const metas = await listMetas()
        return { success: true, data: metas }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_STORE_HAS_NAME,
    async (_event, name: unknown, excludeId: unknown): Promise<ThemePackStoreResult<boolean>> => {
      if (typeof name !== 'string') {
        return { success: false, errorCode: 'INVALID_NAME', error: 'Invalid name' }
      }
      const exclude = typeof excludeId === 'string' ? excludeId : undefined
      try {
        const result = await hasActiveName(name, exclude)
        if (!result.success) return result
        return { success: true, data: result.data }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_STORE_GET,
    async (_event, id: unknown): Promise<ThemePackStoreResult<ThemePackRecord>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return getPack(id)
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_STORE_RENAME,
    async (
      _event,
      id: unknown,
      newName: unknown,
    ): Promise<ThemePackStoreResult<ThemePackMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      if (typeof newName !== 'string') {
        return { success: false, errorCode: 'INVALID_NAME', error: 'Invalid name' }
      }
      const result = await renamePack(id, newName)
      if (result.success) broadcastChanged()
      return result
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_STORE_REORDER,
    async (_event, orderedIds: unknown): Promise<ThemePackStoreResult<void>> => {
      if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) {
        return { success: false, errorCode: 'INVALID_FILE', error: 'Invalid order list' }
      }
      const result = await reorderActive(orderedIds as string[])
      if (result.success) broadcastChanged()
      return result
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_STORE_DELETE,
    async (_event, id: unknown): Promise<ThemePackStoreResult<void>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const result = await deletePack(id)
      if (result.success) broadcastChanged()
      return result
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_STORE_SET_HUB_POST_ID,
    async (
      _event,
      id: unknown,
      hubPostId: unknown,
      uploaderName: unknown,
      hubUpdatedAt: unknown,
    ): Promise<ThemePackStoreResult<ThemePackMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const normalized = hubPostId == null
        ? null
        : (typeof hubPostId === 'string' ? hubPostId : null)
      const result = await setHubPostId(
        id,
        normalized,
        typeof uploaderName === 'string' ? uploaderName : undefined,
        typeof hubUpdatedAt === 'string' ? hubUpdatedAt : undefined,
      )
      if (result.success) broadcastChanged()
      return result
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_IMPORT,
    async (event): Promise<ThemePackImportDialogResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { canceled: true, files: [] }
      const result = await dialog.showOpenDialog(win, {
        title: 'Import Theme Pack',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, files: [] }
      }
      const files: ThemePackImportFile[] = []
      for (const filePath of result.filePaths) {
        files.push(await readOneImportFile(filePath))
      }
      return { canceled: false, files }
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_IMPORT_APPLY,
    async (
      _event,
      raw: unknown,
      options: unknown,
    ): Promise<ThemePackStoreResult<ThemePackMeta>> => {
      const opts = (options && typeof options === 'object') ? options as Record<string, unknown> : {}
      const result = await savePack({
        raw,
        id: typeof opts.id === 'string' ? opts.id : undefined,
        hubPostId: typeof opts.hubPostId === 'string' ? opts.hubPostId : undefined,
        hubUpdatedAt: typeof opts.hubUpdatedAt === 'string' ? opts.hubUpdatedAt : undefined,
        uploaderName: typeof opts.uploaderName === 'string' ? opts.uploaderName : undefined,
      })
      if (result.success) broadcastChanged()
      return result
    },
  )

  secureHandle(
    IpcChannels.THEME_PACK_EXPORT,
    async (event, id: unknown): Promise<ThemePackStoreResult<{ filePath: string }>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, errorCode: 'IO_ERROR', error: 'No window' }
      return exportPackToDialog(win, id)
    },
  )
}
