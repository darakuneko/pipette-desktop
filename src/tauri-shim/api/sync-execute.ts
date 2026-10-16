// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members that run the sync in the Tauri build and report on it:
// the sync of a scope, the Analyze sync, the sync format status, and the
// progress, format and applied-unit events. The sync format status and its
// event are the backend's (src-tauri/src/sync_commands/preflight.rs), on the
// channel the Electron main process uses; the others are not backed by a
// backend command yet and fall back to the fixed answer of fakes.ts or the
// stub of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import { IpcChannels } from '../../shared/ipc/channels'
import type { SyncFormatStatus } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, subscribe } from '../ipc'

export const syncExecuteApi = {
  syncFormatStatus: () => call<SyncFormatStatus | null>('sync_format_status'),
  syncOnFormatStatusChanged: (callback) =>
    subscribe<SyncFormatStatus | null>(IpcChannels.SYNC_FORMAT_STATUS_CHANGED, callback),
} satisfies Partial<VialAPI>
