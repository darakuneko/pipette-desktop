// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the tray hooks' tests run against, both
// handing the same spy the status a hook reports: a plain mock (the
// spy itself), and the Tauri shim's tray member over a mocked Tauri IPC,
// whose `tray_status_update` command passes the spy its `status` argument.
// `extra` holds the other members a test needs, the same in both. The test
// file clears the IPC mock after each test (`clearMocks`).

import { mockIPC } from '@tauri-apps/api/mocks'
import type { TrayStatus } from '../../../shared/types/vial-api'
import { trayApi } from '../../../tauri-shim/api/tray'

export interface TrayBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

export function trayBackends(trayStatusUpdate: (status: TrayStatus) => unknown, extra: object = {}): TrayBackend[] {
  return [
    { name: 'plain mock', install: () => installVialAPI({ ...extra, trayStatusUpdate }) },
    {
      name: 'Tauri shim over mockIPC',
      install: () => {
        mockIPC((cmd, payload) => {
          if (cmd !== 'tray_status_update') throw new Error(`unexpected command ${cmd}`)
          trayStatusUpdate((payload as { status: TrayStatus }).status)
          return null
        })
        installVialAPI({ ...extra, ...trayApi })
      },
    },
  ]
}
