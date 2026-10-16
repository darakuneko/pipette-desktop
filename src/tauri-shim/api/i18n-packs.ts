// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI language pack members for the Tauri build
// (src-tauri/src/store_commands/i18n_packs.rs). The writes are queued under
// `i18n/index`, the key the backend locks, so they reach the backend one at
// a time in the order the renderer made them. The list is queued too: it
// may create the built-in English entry, which Electron does in the same
// write queue. A read of one pack or of a name goes without waiting, as in
// Electron, and so does a dialog: the backend locks each save itself.
//
// The pack JSON and the import options cross as the text of
// JSON.stringify, so the backend keeps their key order. The import dialog
// answers the text of each chosen file, parsed here with JSON.parse into
// the `{ filePath, raw, fileSizeBytes }` or `{ …, parseError }` the
// Electron handler answers (src/main/pack-import-dialog.ts).

import { IpcChannels } from '../../shared/ipc/channels'
import type { I18nPackMeta, I18nPackRecord, I18nPackStoreResult } from '../../shared/types/i18n-store'
import type { PackImportDialogResult, PackImportFile } from '../../shared/types/pack-import'
import type { VialAPI } from '../../shared/types/vial-api'
import type { PackImportRead } from '../generated/PackImportRead'
import { call, subscribe } from '../ipc'
import { enqueue } from '../key-queue'

/** The write-lock key of the language packs, the name of their index's
 *  sync unit. */
const KEY = 'i18n/index'

/** The text of the files chosen in the import dialog. */
export function openImport(): Promise<PackImportRead> {
  return call('i18n_pack_import')
}

/** The import dialog's answer as the renderer gets it, each file parsed on
 *  its own. */
export function parseImportFiles(read: PackImportRead): PackImportDialogResult {
  const files = read.files.map((file): PackImportFile => {
    const { filePath, text, fileSizeBytes } = file
    if (text === undefined) return { filePath, parseError: file.readError }
    try {
      const raw: unknown = JSON.parse(text)
      return { filePath, raw, fileSizeBytes }
    } catch (err) {
      return { filePath, fileSizeBytes, parseError: String(err) }
    }
  })
  return { canceled: read.canceled, files }
}

/** `value` as JSON text, or undefined when it has none (`undefined`). */
function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value) as string | undefined
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
