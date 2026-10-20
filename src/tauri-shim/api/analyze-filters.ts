// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI Analyze filter store members for the Tauri build
// (src-tauri/src/store_commands/analyze_filters.rs). The writes of a
// keyboard's filters are queued under its uid, the key its snapshot and
// pipette settings writes share, so they reach the backend one at a time in
// the order the renderer made them; the list and the load read without
// waiting. The two Hub members only record the link on the entry. A private
// Hub link crosses as the text of JSON.stringify(link), taken when the
// member is called, so the backend keeps its keys in their order.

import type { AnalyzeFilterSnapshotMeta } from '../../shared/types/analyze-filter-store'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import { enqueue } from '../key-queue'

type Result = { success: boolean; error?: string }

export const analyzeFiltersApi = {
  analyzeFilterStoreList: (uid) =>
    call<{ success: boolean; entries?: AnalyzeFilterSnapshotMeta[]; error?: string }>('analyze_filter_store_list', {
      uid,
    }),
  analyzeFilterStoreSave: (uid, json, label, summary) =>
    enqueue(uid, () =>
      call<{ success: boolean; entry?: AnalyzeFilterSnapshotMeta; error?: string }>('analyze_filter_store_save', {
        uid,
        json,
        label,
        summary,
      }),
    ),
  analyzeFilterStoreLoad: (uid, entryId) =>
    call<{ success: boolean; data?: string; error?: string }>('analyze_filter_store_load', { uid, entryId }),
  analyzeFilterStoreUpdate: (uid, entryId, json) =>
    enqueue(uid, () => call<Result>('analyze_filter_store_update', { uid, entryId, json })),
  analyzeFilterStoreRename: (uid, entryId, newLabel) =>
    enqueue(uid, () => call<Result>('analyze_filter_store_rename', { uid, entryId, newLabel })),
  analyzeFilterStoreDelete: (uid, entryId) =>
    enqueue(uid, () => call<Result>('analyze_filter_store_delete', { uid, entryId })),
  analyzeFilterStoreSetHubPostId: (uid, entryId, hubPostId) =>
    enqueue(uid, () => call<Result>('analyze_filter_store_set_hub_post_id', { uid, entryId, hubPostId })),
  analyzeFilterStoreSetHubPrivate: (uid, entryId, link) => {
    const text = JSON.stringify(link)
    return enqueue(uid, () => call<Result>('analyze_filter_store_set_hub_private', { uid, entryId, link: text }))
  },
} satisfies Partial<VialAPI>
