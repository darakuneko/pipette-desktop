// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members the Tauri shim answers: the members the backend
// implements, one module per domain under ./api, and the fixed answers of
// ./fakes (none). Members in neither fall back to the stubs built in
// create-vial-api.ts (none: coverage.test.ts checks that every member is
// implemented).

import type { VialAPI } from '../shared/types/vial-api'
import { analyzeFiltersApi } from './api/analyze-filters'
import { appConfigApi } from './api/app-config'
import { deviceApi } from './api/device'
import { favoritesApi } from './api/favorites'
import { filesApi } from './api/files'
import { i18nPacksApi } from './api/i18n-packs'
import { keyLabelsApi } from './api/key-labels'
import { keyboardDataApi } from './api/keyboard-data'
import { notificationApi } from './api/notification'
import { updateApi } from './api/update'
import { runLogsApi } from './api/run-logs'
import { settingsApi } from './api/settings'
import { shellApi } from './api/shell'
import { snapshotsApi } from './api/snapshots'
import { syncAuthApi } from './api/sync-auth'
import { syncDataApi } from './api/sync-data'
import { syncExecuteApi } from './api/sync-execute'
import { syncPasswordApi } from './api/sync-password'
import { syncPasswordChangeApi } from './api/sync-password-change'
import { syncPendingApi } from './api/sync-pending'
import { syncResetApi } from './api/sync-reset'
import { themePacksApi } from './api/theme-packs'
import { trayApi } from './api/tray'
import { typingAnalyticsApi } from './api/typing-analytics'
import { typingAnalyticsDataApi } from './api/typing-analytics-data'
import { typingAnalyticsKeymapsApi } from './api/typing-analytics-keymaps'
import { typingAnalyticsRangeApi } from './api/typing-analytics-range'
import { typingAnalyticsRecordApi } from './api/typing-analytics-record'
import { typingAnalyticsRemoteApi } from './api/typing-analytics-remote'
import { typingDatasetsApi } from './api/typing-datasets'
import { typingTextsApi } from './api/typing-texts'
import { windowApi } from './api/window'
import { hubAccountApi } from './api/hub-account'
import { hubPostsApi } from './api/hub-posts'
import { hubFavoriteApi } from './api/hub-favorite'
import { hubAnalyticsApi } from './api/hub-analytics'
import { hubPacksApi } from './api/hub-packs'
import { keyLabelHubApi } from './api/key-label-hub'
import { fakes } from './fakes'

/** The members backed by backend commands, by domain. */
export const real = {
  ...deviceApi,
  ...appConfigApi,
  ...shellApi,
  ...windowApi,
  ...trayApi,
  ...notificationApi,
  ...updateApi,
  ...syncPendingApi,
  ...filesApi,
  ...keyboardDataApi,
  ...favoritesApi,
  ...keyLabelsApi,
  ...typingTextsApi,
  ...snapshotsApi,
  ...analyzeFiltersApi,
  ...runLogsApi,
  ...typingAnalyticsKeymapsApi,
  ...typingAnalyticsRecordApi,
  ...settingsApi,
  ...typingDatasetsApi,
  ...typingAnalyticsApi,
  ...typingAnalyticsRangeApi,
  ...typingAnalyticsDataApi,
  ...i18nPacksApi,
  ...themePacksApi,
  ...syncAuthApi,
  ...syncPasswordApi,
  ...syncExecuteApi,
  ...syncPasswordChangeApi,
  ...syncDataApi,
  ...syncResetApi,
  ...typingAnalyticsRemoteApi,
  ...hubAccountApi,
  ...hubPostsApi,
  ...hubFavoriteApi,
  ...hubAnalyticsApi,
  ...hubPacksApi,
  ...keyLabelHubApi,
} satisfies Partial<VialAPI>

export const implemented: Partial<VialAPI> = { ...real, ...fakes }
