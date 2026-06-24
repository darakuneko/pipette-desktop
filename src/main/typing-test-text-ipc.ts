// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handlers for the local Typing Test text store.

import { BrowserWindow } from 'electron'
import { IpcChannels } from '../shared/ipc/channels'
import { secureHandle } from './ipc-guard'
import {
  listMetas,
  getRecord,
  renameRecord,
  deleteRecord,
  importFromDialog,
  confirmImportOverwrite,
} from './typing-test-text-store'
import type {
  TypingTestTextMeta,
  TypingTestTextRecord,
  TypingTestTextStoreResult,
} from '../shared/types/typing-test-text-store'

export function setupTypingTestTextStore(): void {
  secureHandle(
    IpcChannels.TYPING_TEST_TEXT_LIST,
    async (): Promise<TypingTestTextStoreResult<TypingTestTextMeta[]>> => {
      try {
        const entries = await listMetas()
        return { success: true, data: entries }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.TYPING_TEST_TEXT_GET,
    async (_event, id: unknown): Promise<TypingTestTextStoreResult<TypingTestTextRecord>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return getRecord(id)
    },
  )

  secureHandle(
    IpcChannels.TYPING_TEST_TEXT_RENAME,
    async (_event, id: unknown, newName: unknown): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
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
    IpcChannels.TYPING_TEST_TEXT_DELETE,
    async (_event, id: unknown): Promise<TypingTestTextStoreResult<void>> => {
      if (typeof id !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      return deleteRecord(id)
    },
  )

  secureHandle(
    IpcChannels.TYPING_TEST_TEXT_IMPORT,
    async (event): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, errorCode: 'IO_ERROR', error: 'No window' }
      return importFromDialog(win)
    },
  )

  secureHandle(
    IpcChannels.TYPING_TEST_TEXT_IMPORT_CONFIRM,
    async (): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => confirmImportOverwrite(),
  )
}
