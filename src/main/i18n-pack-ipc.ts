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
  reorderActive,
} from './i18n-pack-store'
import type {
  I18nPackMeta,
  I18nPackRecord,
  I18nPackStoreResult,
  I18nPackImportDialogResult,
  I18nPackImportFile,
} from '../shared/types/i18n-store'

/** Read + parse a single file selected via the multi-select import dialog.
 *  Never throws — a read or parse failure is reported via `parseError` so
 *  one bad file in the batch does not abort the rest. */
async function readOneImportFile(filePath: string): Promise<I18nPackImportFile> {
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
    IpcChannels.I18N_PACK_STORE_REORDER,
    // Unlike THEME_PACK_STORE_REORDER's handler, this does not broadcast
    // an *_PACK_CHANGED event — matches every other i18n-pack-store
    // handler (i18n has no broadcast mechanism; the renderer's own
    // CustomEvent covers same-window multi-hook-instance sync). If a
    // second renderer window for the same store ever lands, this
    // handler (and its rename/delete/etc. siblings) would need a
    // broadcast added so the other window's `metas` picks up the
    // reordered result without a manual refresh.
    async (_event, orderedIds: unknown): Promise<I18nPackStoreResult<void>> => {
      if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) {
        return { success: false, errorCode: 'INVALID_FILE', error: 'Invalid order list' }
      }
      return reorderActive(orderedIds as string[])
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
      uploaderName: unknown,
      hubUpdatedAt: unknown,
    ): Promise<I18nPackStoreResult<I18nPackMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const normalized = hubPostId == null
        ? null
        : (typeof hubPostId === 'string' ? hubPostId : null)
      return setHubPostId(
        id,
        normalized,
        typeof uploaderName === 'string' ? uploaderName : undefined,
        typeof hubUpdatedAt === 'string' ? hubUpdatedAt : undefined,
      )
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
      if (!win) return { canceled: true, files: [] }
      const result = await dialog.showOpenDialog(win, {
        title: 'Import Language Pack',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, files: [] }
      }
      const files: I18nPackImportFile[] = []
      for (const filePath of result.filePaths) {
        files.push(await readOneImportFile(filePath))
      }
      return { canceled: false, files }
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
      let matchedBaseVersion: string | null | undefined
      if (opts.matchedBaseVersion === null) matchedBaseVersion = null
      else if (typeof opts.matchedBaseVersion === 'string') matchedBaseVersion = opts.matchedBaseVersion
      let coverage: { totalKeys: number; coveredKeys: number } | null | undefined
      if (opts.coverage === null) coverage = null
      else if (opts.coverage && typeof opts.coverage === 'object') {
        const c = opts.coverage as Record<string, unknown>
        if (typeof c.totalKeys === 'number' && typeof c.coveredKeys === 'number') {
          coverage = { totalKeys: c.totalKeys, coveredKeys: c.coveredKeys }
        }
      }
      let dangerousKeyCount: number | null | undefined
      if (opts.dangerousKeyCount === null) dangerousKeyCount = null
      else if (typeof opts.dangerousKeyCount === 'number') dangerousKeyCount = opts.dangerousKeyCount
      return savePack({
        pack: raw,
        enabled: typeof opts.enabled === 'boolean' ? opts.enabled : true,
        hubPostId: typeof opts.hubPostId === 'string' ? opts.hubPostId : undefined,
        hubUpdatedAt: typeof opts.hubUpdatedAt === 'string' ? opts.hubUpdatedAt : undefined,
        uploaderName: typeof opts.uploaderName === 'string' ? opts.uploaderName : undefined,
        appVersionAtImport: typeof opts.appVersionAtImport === 'string' ? opts.appVersionAtImport : undefined,
        id: typeof opts.id === 'string' ? opts.id : undefined,
        matchedBaseVersion,
        coverage,
        dangerousKeyCount,
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
