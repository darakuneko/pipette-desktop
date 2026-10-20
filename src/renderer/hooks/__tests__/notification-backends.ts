// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the startup notice tests run against,
// both answering with the same spy: a plain mock (the spy itself),
// and the Tauri shim's notification member over a mocked Tauri IPC, whose
// `notification_fetch` command answers with what the spy resolves (or
// rejects with what it rejects with). `install` puts the notice member on
// top of `base`, the other members a test needs, the same in both. The
// test file clears the IPC mock after each test (`clearMocks`).

import { mockIPC } from '@tauri-apps/api/mocks'
import type { NotificationFetchResult } from '../../../shared/types/notification'
import { notificationApi } from '../../../tauri-shim/api/notification'

export interface NotificationBackend {
  name: string
  install: (base: object) => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

export function notificationBackends(notificationFetch: () => Promise<NotificationFetchResult>): NotificationBackend[] {
  return [
    { name: 'plain mock', install: (base) => installVialAPI({ ...base, notificationFetch }) },
    {
      name: 'Tauri shim over mockIPC',
      install: (base) => {
        mockIPC((cmd) => {
          if (cmd !== 'notification_fetch') throw new Error(`unexpected command ${cmd}`)
          return notificationFetch()
        })
        installVialAPI({ ...base, ...notificationApi })
      },
    },
  ]
}
