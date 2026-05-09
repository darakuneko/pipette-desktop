// SPDX-License-Identifier: GPL-2.0-or-later
//
// IPC handlers for the i18n language pack store. The handlers stay
// thin — heavy lifting (validation, coverage computation, preview
// payload assembly) lives in renderer-side helpers so the main
// process can keep treating pack JSON as opaque blobs that round-trip
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
  setEnabled,
  deletePack,
  setHubPostId,
  hasActiveName,
  exportPackToDialog,
} from './i18n-pack-store'
import type {
  I18nPackMeta,
  I18nPackRecord,
  I18nPackStoreResult,
  I18nPackImportDialogResult,
} from '../shared/types/i18n-store'

export function setupI18nPackStore(): void {
  secureHandle(
    IpcChannels.I18N_PACK_STORE_LIST,
    async (): Promise<I18nPackStoreResult<I18nPackMeta[]>> => {
      try {
        const metas = await listMetas()
        return { success: true, data: metas }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  // Mirrors KEY_LABEL_STORE_LIST_ALL — returns tombstoned entries too,
  // useful for sync diagnostics.
  secureHandle(
    IpcChannels.I18N_PACK_STORE_HAS_NAME,
    async (_event, name: unknown, excludeId: unknown): Promise<I18nPackStoreResult<boolean>> => {
      if (typeof name !== 'string') {
        return { success: false, errorCode: 'INVALID_NAME', error: 'Invalid name' }
      }
      const exclude = typeof excludeId === 'string' ? excludeId : undefined
      try {
        const exists = await hasActiveName(name, exclude)
        return { success: true, data: exists }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_STORE_GET,
    async (_event, id: unknown): Promise<I18nPackStoreResult<I18nPackRecord>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return getPack(id)
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_STORE_RENAME,
    async (
      _event,
      id: unknown,
      newName: unknown,
    ): Promise<I18nPackStoreResult<I18nPackMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      if (typeof newName !== 'string') {
        return { success: false, errorCode: 'INVALID_NAME', error: 'Invalid name' }
      }
      return renamePack(id, newName)
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_STORE_SET_ENABLED,
    async (
      _event,
      id: unknown,
      enabled: unknown,
    ): Promise<I18nPackStoreResult<I18nPackMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      if (typeof enabled !== 'boolean') {
        return { success: false, errorCode: 'INVALID_FILE', error: 'enabled must be boolean' }
      }
      return setEnabled(id, enabled)
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_STORE_DELETE,
    async (_event, id: unknown): Promise<I18nPackStoreResult<void>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return deletePack(id)
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_STORE_SET_HUB_POST_ID,
    async (
      _event,
      id: unknown,
      hubPostId: unknown,
    ): Promise<I18nPackStoreResult<I18nPackMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const normalized = hubPostId == null
        ? null
        : (typeof hubPostId === 'string' ? hubPostId : null)
      return setHubPostId(id, normalized)
    },
  )

  // Open the file picker and parse the selected JSON. The renderer is
  // responsible for running validation / coverage on the parsed body
  // before invoking IMPORT_APPLY — this keeps validation rules in one
  // place (shared/i18n/validate.ts) and the main process minimal.
  secureHandle(
    IpcChannels.I18N_PACK_IMPORT,
    async (event): Promise<I18nPackImportDialogResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { canceled: true }
      const result = await dialog.showOpenDialog(win, {
        title: 'Import Language Pack',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }
      const filePath = result.filePaths[0]
      try {
        const raw = await readFile(filePath, 'utf-8')
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          return {
            canceled: false,
            filePath,
            fileSizeBytes: Buffer.byteLength(raw, 'utf-8'),
            parseError: String(err),
          }
        }
        return {
          canceled: false,
          raw: parsed,
          filePath,
          fileSizeBytes: Buffer.byteLength(raw, 'utf-8'),
        }
      } catch (err) {
        return { canceled: false, filePath, parseError: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_IMPORT_APPLY,
    async (
      _event,
      raw: unknown,
      options: unknown,
    ): Promise<I18nPackStoreResult<I18nPackMeta>> => {
      const opts = (options && typeof options === 'object') ? options as Record<string, unknown> : {}
      return savePack({
        pack: raw,
        enabled: typeof opts.enabled === 'boolean' ? opts.enabled : true,
        hubPostId: typeof opts.hubPostId === 'string' ? opts.hubPostId : undefined,
        appVersionAtImport: typeof opts.appVersionAtImport === 'string' ? opts.appVersionAtImport : undefined,
        id: typeof opts.id === 'string' ? opts.id : undefined,
      })
    },
  )

  secureHandle(
    IpcChannels.I18N_PACK_EXPORT,
    async (event, id: unknown): Promise<I18nPackStoreResult<{ filePath: string }>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, errorCode: 'IO_ERROR', error: 'No window' }
      return exportPackToDialog(win, id)
    },
  )
}
