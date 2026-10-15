// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members the Tauri shim answers: the members the backend
// implements, one module per domain under ./api, and the fixed answers of
// ./fakes. Members in neither fall back to the stubs built in
// create-vial-api.ts.

import type { VialAPI } from '../shared/types/vial-api'
import { appConfigApi } from './api/app-config'
import { deviceApi } from './api/device'
import { favoritesApi } from './api/favorites'
import { filesApi } from './api/files'
import { keyboardDataApi } from './api/keyboard-data'
import { shellApi } from './api/shell'
import { snapshotsApi } from './api/snapshots'
import { syncPendingApi } from './api/sync-pending'
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
  ...snapshotsApi,
} satisfies Partial<VialAPI>

export const implemented: Partial<VialAPI> = { ...real, ...fakes }
