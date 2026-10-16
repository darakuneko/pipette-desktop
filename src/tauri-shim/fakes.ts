// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (sync
// signed out, no packs, no saved keyboard data). Writes
// succeed without storing anything. Each group names the backend area
// whose commands take its place; coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'

/** The answer of a Hub member before the backend reaches the Hub. */
const HUB_UNAVAILABLE = { success: false, error: 'Hub is not available' } as const

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

  // Key label Hub. The renderer reads the result of each without a guard
  // (`useKeyLabels`, `useHubFreshness`, `useHubSearchList`), so each answers
  // a failure rather than nothing. The Hub detail is read in a try block and
  // stays a stub.
  keyLabelHubList: () => Promise.resolve(HUB_UNAVAILABLE),
  keyLabelHubDownload: () => Promise.resolve(HUB_UNAVAILABLE),
  keyLabelHubUpload: () => Promise.resolve(HUB_UNAVAILABLE),
  keyLabelHubUpdate: () => Promise.resolve(HUB_UNAVAILABLE),
  keyLabelHubSync: () => Promise.resolve(HUB_UNAVAILABLE),
  keyLabelHubTimestamps: () => Promise.resolve(HUB_UNAVAILABLE),
  keyLabelHubDelete: () => Promise.resolve(HUB_UNAVAILABLE),

  // Typing run log store.
  typingRunLogList: () => Promise.resolve({ success: true, entries: [] }),
} satisfies Partial<VialAPI>
