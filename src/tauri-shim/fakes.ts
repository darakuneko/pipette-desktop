// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (no
// startup notification), and failed answers for the Hub
// requests whose answer the renderer reads. Writes succeed without
// storing anything. Each group names the backend area whose commands take
// its place; coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'

/** The answer of a Hub member before the backend reaches the Hub. It has
 *  no `error`: without one the renderer shows its own localized failure
 *  message (the search's `keyLabels.errorSearchFailed` and the row
 *  actions' `keyLabels.errorGeneric` through `translateError`). */
const hubUnavailable = (): Promise<{ success: false }> => Promise.resolve({ success: false })

export const fakes = {
  // Tray.
  trayStatusUpdate: () => Promise.resolve(),

  // Startup notification.
  notificationFetch: () => Promise.resolve({ success: false }),

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
} satisfies Partial<VialAPI>
