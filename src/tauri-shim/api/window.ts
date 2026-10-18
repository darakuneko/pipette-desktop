// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI window members for the Tauri build: the zoom, the main
// window's visibility and the window of the Typing Test's view-only mode
// (src-tauri/src/window_commands.rs). The backend sends
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
  setWindowCompactMode: (enabled, compactSize) =>
    call<{ width: number; height: number } | null>('set_window_compact_mode', { enabled, compactSize }),
  setWindowAspectRatio: async (ratio) => {
    await call<void>('set_window_aspect_ratio', { ratio })
  },
  setWindowAlwaysOnTop: async (enabled) => {
    await call<void>('set_window_always_on_top', { enabled })
  },
  setWindowOpacity: async (opacity) => {
    await call<void>('set_window_opacity', { opacity })
  },
  setWindowMinSize: async (width, height) => {
    await call<void>('set_window_min_size', { width, height })
  },
  isAlwaysOnTopSupported: () => call<boolean>('is_always_on_top_supported'),
  onWindowVisibilityChanged: (callback) => subscribe<boolean>(IpcChannels.WINDOW_VISIBILITY_CHANGED, callback),
} satisfies Partial<VialAPI>
