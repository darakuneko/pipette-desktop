// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI language pack members for the Tauri build
// (src-tauri/src/store_commands/i18n_packs.rs). The writes are queued under
// `i18n/index`, the key the backend locks, so they reach the backend one at
// a time in the order the renderer made them. The list is queued too: it
// may create the built-in English entry, which Electron does in the same
// write queue. A read of one pack or of a name goes without waiting, as in
// Electron, and so does a dialog: the backend locks each save itself.
//
// The pack JSON and the import options cross as JSON text, and the import
// dialog's file texts are parsed here (api/pack-import.ts).

import { IpcChannels } from '../../shared/ipc/channels'
import type { I18nPackMeta, I18nPackRecord, I18nPackStoreResult } from '../../shared/types/i18n-store'
import type { VialAPI } from '../../shared/types/vial-api'
import type { PackImportRead } from '../generated/PackImportRead'
import { call, subscribe } from '../ipc'
import { enqueue } from '../key-queue'
import { jsonText, parseImportFiles } from './pack-import'

/** The write-lock key of the language packs, the name of their index's
 *  sync unit. */
const KEY = 'i18n/index'

/** The text of the files chosen in the import dialog. */
export function openImport(): Promise<PackImportRead> {
  return call('i18n_pack_import')
}

export const i18nPacksApi = {
  i18nPackList: () => enqueue(KEY, () => call<I18nPackStoreResult<I18nPackMeta[]>>('i18n_pack_store_list')),
  i18nPackGet: (id) => call<I18nPackStoreResult<I18nPackRecord>>('i18n_pack_store_get', { id }),
  i18nPackRename: (id, newName) =>
    enqueue(KEY, () => call<I18nPackStoreResult<I18nPackMeta>>('i18n_pack_store_rename', { id, newName })),
  i18nPackSetEnabled: (id, enabled) =>
    enqueue(KEY, () => call<I18nPackStoreResult<I18nPackMeta>>('i18n_pack_store_set_enabled', { id, enabled })),
  i18nPackRefreshCoverage: (id, values) => {
    const sent = values && structuredClone(values)
    return enqueue(KEY, () =>
      call<I18nPackStoreResult<I18nPackMeta>>('i18n_pack_store_refresh_coverage', { id, values: sent }),
    )
  },
  i18nPackDelete: (id) => enqueue(KEY, () => call<I18nPackStoreResult<void>>('i18n_pack_store_delete', { id })),
  i18nPackSetHubPostId: (id, hubPostId, uploaderName, hubUpdatedAt) =>
    enqueue(KEY, () =>
      call<I18nPackStoreResult<I18nPackMeta>>('i18n_pack_store_set_hub_post_id', {
        id,
        hubPostId,
        uploaderName,
        hubUpdatedAt,
      }),
    ),
  i18nPackHasName: (name, excludeId) =>
    call<I18nPackStoreResult<boolean>>('i18n_pack_store_has_name', { name, excludeId }),
  i18nPackReorder: (orderedIds) => {
    const sent = Array.isArray(orderedIds) ? [...orderedIds] : orderedIds
    return enqueue(KEY, () => call<I18nPackStoreResult<void>>('i18n_pack_store_reorder', { orderedIds: sent }))
  },
  i18nPackImport: async () => parseImportFiles(await openImport()),
  // The preload sends `options ?? {}`.
  i18nPackImportApply: (raw, options) => {
    const args = { raw: jsonText(raw), options: jsonText(options ?? {}) }
    return enqueue(KEY, () => call<I18nPackStoreResult<I18nPackMeta>>('i18n_pack_import_apply', args))
  },
  i18nPackExport: (id) => call<I18nPackStoreResult<{ filePath: string }>>('i18n_pack_export', { id }),
  i18nPackOnChanged: (callback) => subscribe<unknown>(IpcChannels.I18N_PACK_CHANGED, () => callback()),
} satisfies Partial<VialAPI>
