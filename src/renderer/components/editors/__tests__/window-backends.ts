// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the Typing Test window hook's tests run
// against, both answering from the same VialAPI-shaped spies: a
// preload-like mock (the spies themselves), and the Tauri shim's window
// members over a mocked Tauri IPC, whose commands hand the spies their
// arguments in the members' order. The test file clears the IPC mock after
// each test (`clearMocks`).

import { mockIPC } from '@tauri-apps/api/mocks'
import type { VialAPI } from '../../../../shared/types/vial-api'
import { windowApi } from '../../../../tauri-shim/api/window'

type WindowMember =
  | 'isAlwaysOnTopSupported'
  | 'setWindowAlwaysOnTop'
  | 'setWindowAspectRatio'
  | 'setWindowCompactMode'
  | 'setWindowOpacity'
/** A spy per member, called with the member's own arguments. */
export type WindowSpies = { [K in WindowMember]: (...args: Parameters<VialAPI[K]>) => unknown }

export interface WindowBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

export function windowBackends(spies: WindowSpies): WindowBackend[] {
  return [
    { name: 'preload-like mock', install: () => installVialAPI({ ...spies }) },
    {
      name: 'Tauri shim over mockIPC',
      install: () => {
        mockIPC((cmd, payload) => {
          const a = payload as Record<string, unknown>
          switch (cmd) {
            case 'is_always_on_top_supported': return spies.isAlwaysOnTopSupported()
            case 'set_window_always_on_top': return spies.setWindowAlwaysOnTop(a.enabled as boolean)
            case 'set_window_aspect_ratio': return spies.setWindowAspectRatio(a.ratio as number)
            case 'set_window_compact_mode':
              return a.compactSize === undefined
                ? spies.setWindowCompactMode(a.enabled as boolean)
                : spies.setWindowCompactMode(a.enabled as boolean, a.compactSize as { width: number; height: number })
            case 'set_window_opacity': return spies.setWindowOpacity(a.opacity as number)
            default: throw new Error(`unexpected command ${cmd}`)
          }
        })
        installVialAPI({ ...windowApi })
      },
    },
  ]
}
