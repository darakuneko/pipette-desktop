// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI app config members for the Tauri build. The backend
// (src-tauri/src/app_config.rs) keeps <userData>/config.json as the
// Electron main process does with electron-store. A value crosses as the
// text of JSON.stringify(value): the backend parses that text as
// JSON.parse would, so for every value an AppConfig field can hold it stores
// what electron-store, which writes JSON.stringify of the value, would
// store. A function or Symbol nested in an object is dropped by
// JSON.stringify here, where Electron's IPC refuses to clone it. An undefined
// value has no text and arrives as no value, which the backend refuses as
// electron-store does.

import type { AppConfig } from '../../shared/types/app-config'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

// The end of the last appConfigSet. Each set is sent only after the one
// before it has finished: the backend runs commands concurrently, and the
// Electron build applies the renderer's sets in the order they were made,
// so the last one wins. A failed set does not hold up the ones after it.
let lastSet: Promise<unknown> = Promise.resolve()

export const appConfigApi = {
  appConfigGetAll: () => call<AppConfig>('app_config_get_all'),
  appConfigSet: (key, value) => {
    const set = lastSet.then(async () => {
      await call<void>('app_config_set', { key, value: JSON.stringify(value) })
    })
    lastSet = set.catch(() => undefined)
    return set
  },
} satisfies Partial<VialAPI>
