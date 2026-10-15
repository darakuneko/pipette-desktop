// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members the Tauri backend answers. Each entry is the member's
// implementation; members not listed here fall back to the stubs built in
// create-vial-api.ts.
//
// The device and protocol members talk to the backend (./device-api). The
// other entries are the calls the renderer awaits during startup and while
// connecting a keyboard and opening its editor, answered with the values of
// a fresh install: default app config, sync signed out, no packs, no saved
// keyboard data, window visible. Writes succeed without storing anything.

import type { VialAPI } from '../shared/types/vial-api'
import { DEFAULT_APP_CONFIG } from '../shared/types/app-config'
import { deviceApi } from './device-api'

export const implemented: Partial<VialAPI> = {
  ...deviceApi,

  appConfigGetAll: () => Promise.resolve({ ...DEFAULT_APP_CONFIG }),
  appConfigSet: () => Promise.resolve(),
  trayStatusUpdate: () => Promise.resolve(),

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
  setWindowZoom: () => Promise.resolve(),

  themePackList: () => Promise.resolve({ success: true, data: [] }),
  keyLabelStoreList: () => Promise.resolve({ success: true, data: [] }),

  pipetteSettingsGet: () => Promise.resolve(null),
  pipetteSettingsEnsureDir: () => Promise.resolve({ success: true }),
  pipetteSettingsPatch: () => Promise.resolve({ success: true }),
  keyboardMetaNameIfMissing: () => Promise.resolve(),
  snapshotStoreList: () => Promise.resolve({ success: true, entries: [] }),
  typingRunLogList: () => Promise.resolve({ success: true, entries: [] }),
}
