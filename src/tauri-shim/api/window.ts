// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI window members for the Tauri build: the zoom and the main
// window's visibility (src-tauri/src/window_commands.rs). The backend sends
// the window's show and hide as the window:visibility-changed event
// (src-tauri/src/main_window.rs), which the Electron main process sends on
// the same channel.

import { IpcChannels } from '../../shared/ipc/channels'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, subscribe } from '../ipc'

export const windowApi = {
  setWindowZoom: async (zoom) => {
    await call<void>('set_window_zoom', { zoom })
  },
  windowShow: () => call<boolean>('window_show'),
  windowHide: async () => {
    await call<void>('window_hide')
  },
  windowStartedHidden: () => call<boolean>('window_started_hidden'),
  windowIsVisible: () => call<boolean>('window_is_visible'),
  onWindowVisibilityChanged: (callback) => subscribe<boolean>(IpcChannels.WINDOW_VISIBILITY_CHANGED, callback),
} satisfies Partial<VialAPI>
