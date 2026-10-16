// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI typing test text store members for the Tauri build
// (src-tauri/src/store_commands/typing_texts.rs). The rename, the delete and
// the confirmed overwrite of a held import are queued under
// `typing-test-texts`, the key the backend locks, so they reach the backend
// one at a time in the order the renderer made them. The list and the read
// of one text go without waiting, as the Electron handlers read without the
// lock, and so does the import: its dialog waits for the user outside the
// queue, and the backend takes the lock for the save.

import type {
  TypingTestTextMeta,
  TypingTestTextRecord,
  TypingTestTextStoreResult,
} from '../../shared/types/typing-test-text-store'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, type CommandName } from '../ipc'
import { enqueue } from '../key-queue'

/** The write-lock key of the store, the name of its sync unit. */
const KEY = 'typing-test-texts'

const queued = <T>(cmd: CommandName, args?: Record<string, unknown>): Promise<TypingTestTextStoreResult<T>> =>
  enqueue(KEY, () => call<TypingTestTextStoreResult<T>>(cmd, args))

export const typingTextsApi = {
  typingTestTextStoreList: () => call<TypingTestTextStoreResult<TypingTestTextMeta[]>>('typing_test_text_store_list'),
  typingTestTextStoreGet: (id) =>
    call<TypingTestTextStoreResult<TypingTestTextRecord>>('typing_test_text_store_get', { id }),
  typingTestTextStoreRename: (id, newName) =>
    queued<TypingTestTextMeta>('typing_test_text_store_rename', { id, newName }),
  typingTestTextStoreDelete: (id) => queued<void>('typing_test_text_store_delete', { id }),
  typingTestTextStoreImport: () =>
    call<TypingTestTextStoreResult<TypingTestTextMeta>>('typing_test_text_store_import'),
  typingTestTextStoreImportConfirm: () => queued<TypingTestTextMeta>('typing_test_text_store_import_confirm'),
} satisfies Partial<VialAPI>
