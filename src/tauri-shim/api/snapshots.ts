// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI snapshot store members for the Tauri build
// (src-tauri/src/store_commands/snapshots.rs). The writes of a keyboard's
// snapshots are queued under its uid, the key its pipette settings writes
// share, so they reach the backend one at a time in the order the renderer
// made them; the list and the load read without waiting, as the Electron
// handlers do. A private Hub link crosses as the text of
// JSON.stringify(link), so the backend keeps its keys in their order.

import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import { enqueue } from '../key-queue'

type Result = { success: boolean; error?: string }

export const snapshotsApi = {
  snapshotStoreList: (uid) =>
    call<{ success: boolean; entries?: SnapshotMeta[]; error?: string }>('snapshot_store_list', { uid }),
  snapshotStoreSave: (uid, json, deviceName, label, vilVersion) =>
    enqueue(uid, () =>
      call<{ success: boolean; entry?: SnapshotMeta; error?: string }>('snapshot_store_save', {
        uid,
        json,
        deviceName,
        label,
        vilVersion,
      }),
    ),
  snapshotStoreLoad: (uid, entryId) =>
    call<{ success: boolean; data?: string; error?: string }>('snapshot_store_load', { uid, entryId }),
  snapshotStoreUpdate: (uid, entryId, json, vilVersion, options) =>
    enqueue(uid, () => call<Result>('snapshot_store_update', { uid, entryId, json, vilVersion, options })),
  snapshotStoreRename: (uid, entryId, newLabel) =>
    enqueue(uid, () => call<Result>('snapshot_store_rename', { uid, entryId, newLabel })),
  snapshotStoreDelete: (uid, entryId) => enqueue(uid, () => call<Result>('snapshot_store_delete', { uid, entryId })),
  snapshotStoreSetHubPostId: (uid, entryId, hubPostId) =>
    enqueue(uid, () => call<Result>('snapshot_store_set_hub_post_id', { uid, entryId, hubPostId })),
  snapshotStoreSetHubPrivate: (uid, entryId, link) =>
    enqueue(uid, () => call<Result>('snapshot_store_set_hub_private', { uid, entryId, link: JSON.stringify(link) })),
} satisfies Partial<VialAPI>
