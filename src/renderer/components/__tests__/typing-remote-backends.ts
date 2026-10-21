// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the Data modal's Sync > Typing tests run
// against, both answering from the same VialAPI-shaped spies: a
// plain mock (the spies themselves), and the Tauri shim's members
// over a mocked Tauri IPC, whose commands hand the spies their arguments in
// the members' order. A spy that rejects makes the command fail, so the
// shim's call rejects too. The test file clears the IPC mock after each
// test (`clearMocks`).

import { mockIPC } from '@tauri-apps/api/mocks'
import type { VialAPI } from '../../../shared/types/vial-api'
import { keyboardDataApi } from '../../../tauri-shim/api/keyboard-data'
import { syncDataApi } from '../../../tauri-shim/api/sync-data'
import { typingAnalyticsApi } from '../../../tauri-shim/api/typing-analytics'
import { typingAnalyticsDataApi } from '../../../tauri-shim/api/typing-analytics-data'
import { typingAnalyticsRemoteApi } from '../../../tauri-shim/api/typing-analytics-remote'

type Member =
  | 'listStoredKeyboards'
  | 'typingAnalyticsListKeyboards'
  | 'typingAnalyticsListDeviceInfos'
  | 'typingAnalyticsListRemoteCloudHashes'
  | 'typingAnalyticsListRemoteCloudDays'
  | 'typingAnalyticsFetchRemoteDay'
  | 'typingAnalyticsListLocalDeviceDays'
  | 'typingAnalyticsListItemsForHash'
  | 'typingAnalyticsDeleteDeviceData'
  | 'syncScanRemote'

/** A spy per member, called with the member's own arguments. */
export type TypingRemoteSpies = { [K in Member]: (...args: Parameters<VialAPI[K]>) => unknown }

export interface TypingRemoteBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

export function typingRemoteBackends(spies: TypingRemoteSpies): TypingRemoteBackend[] {
  return [
    { name: 'plain mock', install: () => installVialAPI({ ...spies }) },
    {
      name: 'Tauri shim over mockIPC',
      install: () => {
        mockIPC((cmd, payload) => {
          const a = payload as Record<string, string>
          switch (cmd) {
            case 'list_stored_keyboards': return spies.listStoredKeyboards()
            case 'typing_analytics_list_keyboards': return spies.typingAnalyticsListKeyboards()
            case 'typing_analytics_list_device_infos': return spies.typingAnalyticsListDeviceInfos(a.uid)
            case 'typing_analytics_list_remote_cloud_hashes': return spies.typingAnalyticsListRemoteCloudHashes(a.uid)
            case 'typing_analytics_list_remote_cloud_days':
              return spies.typingAnalyticsListRemoteCloudDays(a.uid, a.machineHash)
            case 'typing_analytics_fetch_remote_day':
              return spies.typingAnalyticsFetchRemoteDay(a.uid, a.machineHash, a.utcDay)
            case 'typing_analytics_list_local_device_days':
              return spies.typingAnalyticsListLocalDeviceDays(a.uid, a.machineHash)
            case 'typing_analytics_list_items_for_hash': return spies.typingAnalyticsListItemsForHash(a.uid, a.machineHash)
            case 'typing_analytics_delete_device_data': {
              const dates = (payload as { dates: string[] | 'all' }).dates
              return spies.typingAnalyticsDeleteDeviceData(a.uid, a.machineHash, dates)
            }
            case 'sync_scan_remote': return spies.syncScanRemote()
            default: throw new Error(`unexpected command ${cmd}`)
          }
        })
        installVialAPI({ ...keyboardDataApi, ...syncDataApi, ...typingAnalyticsApi, ...typingAnalyticsRemoteApi, ...typingAnalyticsDataApi })
      },
    },
  ]
}
