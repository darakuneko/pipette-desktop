// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (sync
// signed out, no packs, no saved keyboard data). Writes
// succeed without storing anything. Each group names the backend area
// whose commands take its place; coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'

export const fakes = {
  // Tray.
  trayStatusUpdate: () => Promise.resolve(),

  // Cloud sync, signed out. With no cached Drive status yet, the main
  // process reports the sync format status as null.
  syncAuthStatus: () => Promise.resolve({ authenticated: false }),
  syncPasswordStatus: () => Promise.resolve('noPasswordFile' as const),
  syncFormatStatus: () => Promise.resolve(null),

  // Startup notification.
  notificationFetch: () => Promise.resolve({ success: false }),

  // Language packs.
  i18nPackList: () => Promise.resolve({ success: true, data: [] }),

  // Theme packs.
  themePackList: () => Promise.resolve({ success: true, data: [] }),

  // Key label store.
  keyLabelStoreList: () => Promise.resolve({ success: true, data: [] }),

  // Keyboard settings store.
  pipetteSettingsGet: () => Promise.resolve(null),
  pipetteSettingsEnsureDir: () => Promise.resolve({ success: true }),
  pipetteSettingsPatch: () => Promise.resolve({ success: true }),

  // Snapshot store.
  snapshotStoreList: () => Promise.resolve({ success: true, entries: [] }),

  // Typing run log store.
  typingRunLogList: () => Promise.resolve({ success: true, entries: [] }),
} satisfies Partial<VialAPI>
