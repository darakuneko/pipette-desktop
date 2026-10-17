// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI tray member for the Tauri build: the connected keyboard and
// the REC counters the renderer reports for the tray icon
// (src-tauri/src/tray.rs).

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const trayApi = {
  trayStatusUpdate: async (status) => {
    await call<void>('tray_status_update', { status })
  },
} satisfies Partial<VialAPI>
