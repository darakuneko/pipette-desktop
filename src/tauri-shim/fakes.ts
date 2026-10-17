// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for the VialAPI members the renderer awaits during startup
// and while connecting a keyboard and opening its editor, for areas the
// backend does not implement yet: the values of a fresh install (no
// startup notification). Writes succeed without storing anything. Each
// group names the backend area whose commands take its place;
// coverage.test.ts lists them.

import type { VialAPI } from '../shared/types/vial-api'

export const fakes = {
  // Tray.
  trayStatusUpdate: () => Promise.resolve(),

  // Startup notification.
  notificationFetch: () => Promise.resolve({ success: false }),
} satisfies Partial<VialAPI>
