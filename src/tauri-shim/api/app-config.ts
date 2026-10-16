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
import { enqueue } from '../key-queue'

// Each set is sent only after the one before it has finished: the backend
// runs commands concurrently, and the Electron build applies the renderer's
// sets in the order they were made, so the last one wins. A failed set
// rejects its own call and does not hold up the ones after it.
const SET_QUEUE_KEY = 'app-config'

/** The app config once every set made before this call has finished, as
 *  the Electron main process reads it after applying the sets that came
 *  before. */
export function readAppConfigAfterSets(): Promise<AppConfig> {
  return enqueue(SET_QUEUE_KEY, () => call<AppConfig>('app_config_get_all'))
}

/** Settles once every set made before this call has finished, for a
 *  command whose backend reads the config (as the Electron main process
 *  runs a handler after applying the sets that came before it). */
export function afterAppConfigSets(): Promise<void> {
  return enqueue(SET_QUEUE_KEY, async () => {})
}

export const appConfigApi = {
  appConfigGetAll: () => call<AppConfig>('app_config_get_all'),
  appConfigSet: (key, value) =>
    enqueue(SET_QUEUE_KEY, async () => {
      await call<void>('app_config_set', { key, value: JSON.stringify(value) })
    }),
} satisfies Partial<VialAPI>
