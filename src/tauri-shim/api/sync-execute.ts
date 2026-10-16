// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members that run the sync in the Tauri build and report on it:
// the sync of a scope, the Analyze sync, the sync format status, and the
// progress, format and applied-unit events. The sync of a scope, the sync
// format status and the three events are the backend's
// (src-tauri/src/sync_commands/{execute,preflight}.rs), on the channels the
// Electron main process uses; the Analyze sync is not backed by a backend
// command yet and falls back to the fixed answer of fakes.ts.
// coverage.test.ts lists the members each of these modules holds.

import { IpcChannels } from '../../shared/ipc/channels'
import type { SyncFormatStatus, SyncOperationResult, SyncProgress } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, subscribe } from '../ipc'

export const syncExecuteApi = {
  syncExecute: (direction, scope?) =>
    call<SyncOperationResult>('sync_execute', scope === undefined ? { direction } : { direction, scope }),
  syncFormatStatus: () => call<SyncFormatStatus | null>('sync_format_status'),
  syncOnProgress: (callback) => subscribe<SyncProgress>(IpcChannels.SYNC_PROGRESS, callback),
  syncOnFormatStatusChanged: (callback) =>
    subscribe<SyncFormatStatus | null>(IpcChannels.SYNC_FORMAT_STATUS_CHANGED, callback),
  syncOnUnitApplied: (callback) =>
    subscribe<{ syncUnit: string }>(IpcChannels.SYNC_UNIT_APPLIED, (payload) => callback(payload.syncUnit)),
} satisfies Partial<VialAPI>
