// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI typing analytics members that read Drive in the Tauri build
// (src-tauri/src/sync_commands/analytics_remote.rs): whether another device
// has typing data on Drive, its devices and days, and the fetch of one of
// its days. Each passes its arguments as they are; the backend checks them
// and answers `false` or an empty list for a rejected argument, and rejects
// when Drive fails.
// coverage.test.ts lists the members each of these modules holds.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const typingAnalyticsRemoteApi = {
  typingAnalyticsHasRemote: () => call<boolean>('typing_analytics_has_remote'),
  typingAnalyticsListRemoteCloudHashes: (uid) => call<string[]>('typing_analytics_list_remote_cloud_hashes', { uid }),
  typingAnalyticsListRemoteCloudDays: (uid, machineHash) =>
    call<string[]>('typing_analytics_list_remote_cloud_days', { uid, machineHash }),
  typingAnalyticsFetchRemoteDay: (uid, machineHash, utcDay) =>
    call<boolean>('typing_analytics_fetch_remote_day', { uid, machineHash, utcDay }),
} satisfies Partial<VialAPI>
