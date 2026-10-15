// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (default
// app config, sync signed out, no packs, no saved keyboard data, window
// visible). Writes succeed without storing anything. Each group names the
// backend area whose commands take its place; coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'
import { DEFAULT_APP_CONFIG } from '../shared/types/app-config'

export const fakes = {
  // App config store.
  appConfigGetAll: () => Promise.resolve({ ...DEFAULT_APP_CONFIG }),
  appConfigSet: () => Promise.resolve(),

  // Tray.
  trayStatusUpdate: () => Promise.resolve(),

  // Cloud sync, signed out. With no cached Drive status yet, the main
  // process reports the sync format status as null.
  syncAuthStatus: () => Promise.resolve({ authenticated: false }),
  syncPasswordStatus: () => Promise.resolve('noPasswordFile' as const),
  syncHasPendingChanges: () => Promise.resolve(false),
  syncFormatStatus: () => Promise.resolve(null),

  // Startup notification.
  notificationFetch: () => Promise.resolve({ success: false }),

  // Language packs.
  i18nPackList: () => Promise.resolve({ success: true, data: [] }),

  // Window state and zoom.
  windowStartedHidden: () => Promise.resolve(false),
  windowIsVisible: () => Promise.resolve(true),
  setWindowZoom: () => Promise.resolve(),

  // Theme packs.
  themePackList: () => Promise.resolve({ success: true, data: [] }),

  // Key label store.
  keyLabelStoreList: () => Promise.resolve({ success: true, data: [] }),

  // Keyboard settings and metadata stores.
  pipetteSettingsGet: () => Promise.resolve(null),
  pipetteSettingsEnsureDir: () => Promise.resolve({ success: true }),
  pipetteSettingsPatch: () => Promise.resolve({ success: true }),
  keyboardMetaNameIfMissing: () => Promise.resolve(),

  // Snapshot store.
  snapshotStoreList: () => Promise.resolve({ success: true, entries: [] }),

  // Typing run log store.
  typingRunLogList: () => Promise.resolve({ success: true, entries: [] }),
} satisfies Partial<VialAPI>
