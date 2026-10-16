// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI Data modal members of the typing analytics for the Tauri
// build (src-tauri/src/analytics_commands/data.rs): the deletes of this
// device's days or all of its data, the delete of another device's data,
// the export and the import. Each passes its arguments as they are; the
// backend checks them as the Electron handlers do and answers as they do
// (`{ success, error? }` for the deletes and the import). The import works
// offline: a file matches a local day file only.

import type { TypingAnalyticsImportResult } from '../../shared/types/typing-analytics'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

type Result = { success: boolean; error?: string }

export const typingAnalyticsDataApi = {
  typingAnalyticsDeleteItems: (uid, dates) => call<Result>('typing_analytics_delete_items', { uid, dates }),
  typingAnalyticsDeleteAll: (uid) => call<Result>('typing_analytics_delete_all', { uid }),
  typingAnalyticsDeleteDeviceData: (uid, machineHash, dates) =>
    call<Result>('typing_analytics_delete_device_data', { uid, machineHash, dates }),
  typingAnalyticsExport: (uid, dates) =>
    call<{ written: number; cancelled: boolean }>('typing_analytics_export', { uid, dates }),
  typingAnalyticsImport: () => call<TypingAnalyticsImportResult>('typing_analytics_import'),
} satisfies Partial<VialAPI>
