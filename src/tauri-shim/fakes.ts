// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (sync
// signed out, no packs, no saved keyboard data), and failed answers for the
// Hub requests whose answer the renderer reads. Writes succeed without
// storing anything. Each group names the backend area whose commands take
// its place; coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'

/** The answer of a Hub member before the backend reaches the Hub. It has
 *  no `error`: without one the renderer shows its own localized failure
 *  message (for the key labels, the search's `keyLabels.errorSearchFailed`
 *  and the row actions' `keyLabels.errorGeneric` through `translateError`;
 *  for the language packs, `i18n.errorGeneric` and the `hub.*Failed`
 *  messages through `localizeHubError`). */
const hubUnavailable = (): Promise<{ success: false }> => Promise.resolve({ success: false })

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

  // Language pack Hub. The renderer reads `success` of these answers
  // without a guard, on its own (the freshness check of Hub-linked packs
  // and the Hub tab's list) or after a local change (the sync after
  // renaming a Hub-linked pack), so each answers a failure rather than
  // nothing. Every caller falls back to its own message when `error` is
  // absent; the freshness check reads no message.
  i18nPackHubTimestamps: hubUnavailable,
  hubListI18nPosts: hubUnavailable,
  hubDownloadI18nPost: hubUnavailable,
  hubUploadI18nPost: hubUnavailable,
  hubUpdateI18nPost: hubUnavailable,
  hubDeleteI18nPost: hubUnavailable,

  // Theme packs.
  themePackList: () => Promise.resolve({ success: true, data: [] }),

  // Key label Hub. The renderer reads the result of each without a guard
  // (`useKeyLabels`, `useHubFreshness`, `useHubSearchList`), so each answers
  // a failure rather than nothing. The Hub detail is read in a try block and
  // stays a stub.
  keyLabelHubList: hubUnavailable,
  keyLabelHubDownload: hubUnavailable,
  keyLabelHubUpload: hubUnavailable,
  keyLabelHubUpdate: hubUnavailable,
  keyLabelHubSync: hubUnavailable,
  keyLabelHubTimestamps: hubUnavailable,
  keyLabelHubDelete: hubUnavailable,

  // Typing run log store.
  typingRunLogList: () => Promise.resolve({ success: true, entries: [] }),
} satisfies Partial<VialAPI>
