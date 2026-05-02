// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handlers for the local Key Label store.

import { BrowserWindow } from 'electron'
import { IpcChannels } from '../shared/ipc/channels'
import { secureHandle } from './ipc-guard'
import {
  listMetas,
  listAllMetas,
  getRecord,
  renameRecord,
  deleteRecord,
  setHubPostId,
  importFromDialog,
  exportToDialog,
  hasActiveName,
  reorderActive,
} from './key-label-store'
import type {
  KeyLabelMeta,
  KeyLabelRecord,
  KeyLabelStoreResult,
} from '../shared/types/key-label-store'

export function setupKeyLabelStore(): void {
  secureHandle(
    IpcChannels.KEY_LABEL_STORE_LIST,
    async (): Promise<KeyLabelStoreResult<KeyLabelMeta[]>> => {
      try {
        const entries = await listMetas()
        return { success: true, data: entries }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_LIST_ALL,
    async (): Promise<KeyLabelStoreResult<KeyLabelMeta[]>> => {
      try {
        const entries = await listAllMetas()
        return { success: true, data: entries }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_GET,
    async (_event, id: unknown): Promise<KeyLabelStoreResult<KeyLabelRecord>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return getRecord(id)
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_RENAME,
    async (_event, id: unknown, newName: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      if (typeof newName !== 'string') {
        return { success: false, errorCode: 'INVALID_NAME', error: 'Invalid name' }
      }
      return renameRecord(id, newName)
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_DELETE,
    async (_event, id: unknown): Promise<KeyLabelStoreResult<void>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return deleteRecord(id)
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_SET_HUB_POST_ID,
    async (
      _event,
      id: unknown,
      hubPostId: unknown,
    ): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const normalized = hubPostId == null ? null : (typeof hubPostId === 'string' ? hubPostId : null)
      return setHubPostId(id, normalized)
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_IMPORT,
    async (event): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, errorCode: 'IO_ERROR', error: 'No window' }
      return importFromDialog(win)
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_EXPORT,
    async (event, id: unknown): Promise<KeyLabelStoreResult<{ filePath: string }>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, errorCode: 'IO_ERROR', error: 'No window' }
      return exportToDialog(win, id)
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_REORDER,
    async (_event, orderedIds: unknown): Promise<KeyLabelStoreResult<void>> => {
      if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) {
        return { success: false, errorCode: 'INVALID_FILE', error: 'Invalid order list' }
      }
      return reorderActive(orderedIds as string[])
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_STORE_HAS_NAME,
    async (_event, name: unknown, excludeId: unknown): Promise<KeyLabelStoreResult<boolean>> => {
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
}
