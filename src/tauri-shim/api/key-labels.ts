// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI key label store members for the Tauri build
// (src-tauri/src/store_commands/key_labels.rs). The writes are queued under
// `key-labels`, the key the backend locks, so they reach the backend one at
// a time in the order the renderer made them. The lists are queued too: a
// list can write the built-in QWERTY entry, and a list made after a write
// reads what it wrote. The read of one label and the name check go without
// waiting, and so do the import and the export: their dialogs
// wait for the user outside the queue, and the backend takes the lock for
// each save.

import type {
  KeyLabelImportBatchResult,
  KeyLabelMeta,
  KeyLabelRecord,
  KeyLabelStoreResult,
} from '../../shared/types/key-label-store'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, type CommandName } from '../ipc'
import { enqueue } from '../key-queue'

/** The write-lock key of the store, the name of its sync unit. */
const KEY = 'key-labels'

const queued = <T>(cmd: CommandName, args?: Record<string, unknown>): Promise<KeyLabelStoreResult<T>> =>
  enqueue(KEY, () => call<KeyLabelStoreResult<T>>(cmd, args))

export const keyLabelsApi = {
  keyLabelStoreList: () => queued<KeyLabelMeta[]>('key_label_store_list'),
  keyLabelStoreListAll: () => queued<KeyLabelMeta[]>('key_label_store_list_all'),
  keyLabelStoreGet: (id) => call<KeyLabelStoreResult<KeyLabelRecord>>('key_label_store_get', { id }),
  keyLabelStoreRename: (id, newName) => queued<KeyLabelMeta>('key_label_store_rename', { id, newName }),
  keyLabelStoreDelete: (id) => queued<void>('key_label_store_delete', { id }),
  keyLabelStoreImport: () => call<KeyLabelStoreResult<KeyLabelImportBatchResult>>('key_label_store_import'),
  keyLabelStoreExport: (id) => call<KeyLabelStoreResult<{ filePath: string }>>('key_label_store_export', { id }),
  keyLabelStoreReorder: (orderedIds) => queued<void>('key_label_store_reorder', { orderedIds }),
  keyLabelStoreSetHubPostId: (id, hubPostId) =>
    queued<KeyLabelMeta>('key_label_store_set_hub_post_id', { id, hubPostId }),
  keyLabelStoreHasName: (name, excludeId) =>
    call<KeyLabelStoreResult<boolean>>('key_label_store_has_name', { name, excludeId }),
} satisfies Partial<VialAPI>
