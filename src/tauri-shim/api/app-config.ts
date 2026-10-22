// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI app config members for the Tauri build. The backend
// (src-tauri/src/app_config.rs) keeps <userData>/config.json. A value
// crosses as the text of JSON.stringify(value): the backend parses that
// text as JSON.parse would, so for every value an AppConfig field can hold
// it stores what JSON.stringify of the value says. A function or Symbol
// nested in an object is dropped by JSON.stringify here. An undefined value
// has no text and arrives as no value, which the backend refuses.

import type { AppConfig } from '../../shared/types/app-config'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import { enqueue } from '../key-queue'

// Each set is sent only after the one before it has finished: the backend
// runs commands concurrently, and the renderer's sets apply in the order
// they were made, so the last one wins. A failed set
// rejects its own call and does not hold up the ones after it.
const SET_QUEUE_KEY = 'app-config'

/** The app config once every set made before this call has finished. */
export function readAppConfigAfterSets(): Promise<AppConfig> {
  return enqueue(SET_QUEUE_KEY, () => call<AppConfig>('app_config_get_all'))
}

/** Settles once every set made before this call has finished, for a
 *  command whose backend reads the config. */
export function afterAppConfigSets(): Promise<void> {
  return enqueue(SET_QUEUE_KEY, async () => {})
}

export const appConfigApi = {
  appConfigGetAll: () => call<AppConfig>('app_config_get_all'),
  appConfigSet: (key, value) =>
    enqueue(SET_QUEUE_KEY, async () => {
      await call<void>('app_config_set', { key, value: JSON.stringify(value) })
    }),
  appConfigLogDir: () => call<string>('app_config_log_dir'),
} satisfies Partial<VialAPI>
