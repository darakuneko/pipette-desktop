// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (default
// app config, sync signed out, no packs, no saved keyboard data, window
// visible). Writes succeed without storing anything. Each entry names the
// backend area whose commands take its place; coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'
import { DEFAULT_APP_CONFIG } from '../shared/types/app-config'

export const fakes = {
  // App config store.
  appConfigGetAll: () => Promise.resolve({ ...DEFAULT_APP_CONFIG }),
  // App config store.
  appConfigSet: () => Promise.resolve(),
  // Tray.
  trayStatusUpdate: () => Promise.resolve(),

  // Cloud sync.
  syncAuthStatus: () => Promise.resolve({ authenticated: false }),
  // Cloud sync.
  syncPasswordStatus: () => Promise.resolve('noPasswordFile' as const),
  // Cloud sync.
  syncHasPendingChanges: () => Promise.resolve(false),
  // Cloud sync. Signed out there is no cached Drive status yet, which the
  // main process reports as null.
  syncFormatStatus: () => Promise.resolve(null),

  // Startup notification.
  notificationFetch: () => Promise.resolve({ success: false }),
  // Language packs.
  i18nPackList: () => Promise.resolve({ success: true, data: [] }),

  // Window state.
  windowStartedHidden: () => Promise.resolve(false),
  // Window state.
  windowIsVisible: () => Promise.resolve(true),
  // Window zoom.
  setWindowZoom: () => Promise.resolve(),

  // Theme packs.
  themePackList: () => Promise.resolve({ success: true, data: [] }),
  // Key label store.
  keyLabelStoreList: () => Promise.resolve({ success: true, data: [] }),

  // Keyboard settings store.
  pipetteSettingsGet: () => Promise.resolve(null),
  // Keyboard settings store.
  pipetteSettingsEnsureDir: () => Promise.resolve({ success: true }),
  // Keyboard settings store.
  pipetteSettingsPatch: () => Promise.resolve({ success: true }),
  // Keyboard metadata store.
  keyboardMetaNameIfMissing: () => Promise.resolve(),
  // Snapshot store.
  snapshotStoreList: () => Promise.resolve({ success: true, entries: [] }),
  // Typing run log store.
  typingRunLogList: () => Promise.resolve({ success: true, entries: [] }),
} satisfies Partial<VialAPI>
