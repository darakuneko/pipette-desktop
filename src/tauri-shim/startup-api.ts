// SPDX-License-Identifier: GPL-2.0-or-later
// VialAPI members the renderer awaits during startup, answered with the
// values of a fresh install: default app config, no devices, sync signed
// out, no language packs, window visible.

import type { VialAPI } from '../shared/types/vial-api'
import { DEFAULT_APP_CONFIG } from '../shared/types/app-config'

export const startupApi: Partial<VialAPI> = {
  appConfigGetAll: () => Promise.resolve({ ...DEFAULT_APP_CONFIG }),
  appConfigSet: () => Promise.resolve(),
  trayStatusUpdate: () => Promise.resolve(),

  listDevices: () => Promise.resolve([]),

  syncAuthStatus: () => Promise.resolve({ authenticated: false }),
  syncPasswordStatus: () => Promise.resolve('noPasswordFile'),
  syncHasPendingChanges: () => Promise.resolve(false),
  // Signed out there is no cached Drive status yet, which the main process
  // reports as null.
  syncFormatStatus: () => Promise.resolve(null),

  notificationFetch: () => Promise.resolve({ success: false }),
  i18nPackList: () => Promise.resolve({ success: true, data: [] }),

  windowStartedHidden: () => Promise.resolve(false),
  windowIsVisible: () => Promise.resolve(true),
}
