// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members the Tauri shim answers: the members the backend
// implements, one module per domain under ./api, and the fixed answers of
// ./fakes. Members in neither fall back to the stubs built in
// create-vial-api.ts.

import type { VialAPI } from '../shared/types/vial-api'
import { analyzeFiltersApi } from './api/analyze-filters'
import { appConfigApi } from './api/app-config'
import { deviceApi } from './api/device'
import { favoritesApi } from './api/favorites'
import { filesApi } from './api/files'
import { i18nPacksApi } from './api/i18n-packs'
import { keyLabelsApi } from './api/key-labels'
import { keyboardDataApi } from './api/keyboard-data'
import { runLogsApi } from './api/run-logs'
import { settingsApi } from './api/settings'
import { shellApi } from './api/shell'
import { snapshotsApi } from './api/snapshots'
import { syncPendingApi } from './api/sync-pending'
import { themePacksApi } from './api/theme-packs'
import { typingAnalyticsApi } from './api/typing-analytics'
import { typingAnalyticsKeymapsApi } from './api/typing-analytics-keymaps'
import { typingAnalyticsRangeApi } from './api/typing-analytics-range'
import { typingAnalyticsRecordApi } from './api/typing-analytics-record'
import { typingDatasetsApi } from './api/typing-datasets'
import { typingTextsApi } from './api/typing-texts'
import { windowApi } from './api/window'
import { fakes } from './fakes'

/** The members backed by backend commands, by domain. */
export const real = {
  ...deviceApi,
  ...appConfigApi,
  ...shellApi,
  ...windowApi,
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
  ...i18nPacksApi,
  ...themePacksApi,
} satisfies Partial<VialAPI>

export const implemented: Partial<VialAPI> = { ...real, ...fakes }
