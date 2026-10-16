// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI theme pack members for the Tauri build
// (src-tauri/src/store_commands/theme_packs.rs). The writes are queued under
// `themes/index`, the key the backend locks, so they reach the backend one
// at a time in the order the renderer made them. The list, a read of one
// pack or of a name, and a dialog go without waiting, as in Electron: the
// list writes nothing, and the backend locks each save itself.
//
// An imported pack is checked here with validateThemePack before it is
// queued, as the Electron store checks it before taking its lock; a pack
// that fails answers INVALID_FILE with the check's errors without a call
// to the backend, which checks every pack again and answers the same. The pack JSON and the import options cross as JSON
// text, and the import dialog's file texts are parsed here
// (api/pack-import.ts). The backend sends theme-pack:changed after each
// successful change, to the page that made it too.

import { IpcChannels } from '../../shared/ipc/channels'
import { validateThemePack } from '../../shared/theme/validate'
import type { ThemePackMeta, ThemePackRecord, ThemePackStoreResult } from '../../shared/types/theme-store'
import type { VialAPI } from '../../shared/types/vial-api'
import type { PackImportRead } from '../generated/PackImportRead'
import { call, subscribe } from '../ipc'
import { enqueue } from '../key-queue'
import { jsonText, parseImportFiles } from './pack-import'

/** The write-lock key of the theme packs, the name of their index's sync
 *  unit. */
const KEY = 'themes/index'

/** The text of the files chosen in the import dialog. */
export function openImport(): Promise<PackImportRead> {
  return call('theme_pack_import')
}

export const themePacksApi = {
  themePackList: () => call<ThemePackStoreResult<ThemePackMeta[]>>('theme_pack_store_list'),
  themePackGet: (id) => call<ThemePackStoreResult<ThemePackRecord>>('theme_pack_store_get', { id }),
  themePackRename: (id, newName) =>
    enqueue(KEY, () => call<ThemePackStoreResult<ThemePackMeta>>('theme_pack_store_rename', { id, newName })),
  themePackDelete: (id) => enqueue(KEY, () => call<ThemePackStoreResult<void>>('theme_pack_store_delete', { id })),
  themePackSetHubPostId: (id, hubPostId, uploaderName, hubUpdatedAt) =>
    enqueue(KEY, () =>
      call<ThemePackStoreResult<ThemePackMeta>>('theme_pack_store_set_hub_post_id', {
        id,
        hubPostId,
        uploaderName,
        hubUpdatedAt,
      }),
    ),
  themePackHasName: (name, excludeId) =>
    call<ThemePackStoreResult<boolean>>('theme_pack_store_has_name', { name, excludeId }),
  themePackReorder: (orderedIds) => {
    const sent = Array.isArray(orderedIds) ? [...orderedIds] : orderedIds
    return enqueue(KEY, () => call<ThemePackStoreResult<void>>('theme_pack_store_reorder', { orderedIds: sent }))
  },
  themePackImport: async () => parseImportFiles(await openImport()),
  // The preload sends `options ?? {}`.
  themePackImportApply: (raw, options) => {
    const checked = validateThemePack(raw)
    if (!checked.ok) {
      return Promise.resolve({ success: false, errorCode: 'INVALID_FILE', error: checked.errors.join('; ') })
    }
    const args = { raw: jsonText(raw), options: jsonText(options ?? {}) }
    return enqueue(KEY, () => call<ThemePackStoreResult<ThemePackMeta>>('theme_pack_import_apply', args))
  },
  themePackExport: (id) => call<ThemePackStoreResult<{ filePath: string }>>('theme_pack_export', { id }),
  themePackOnChanged: (callback) => subscribe<unknown>(IpcChannels.THEME_PACK_CHANGED, () => callback()),
} satisfies Partial<VialAPI>
