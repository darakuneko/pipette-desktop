// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI app config members for the Tauri build. The backend
// (src-tauri/src/app_config.rs) keeps <userData>/config.json as the
// Electron main process does with electron-store. A value crosses as the
// text of JSON.stringify(value): the backend parses that text as
// JSON.parse would, so what it stores is exactly what electron-store, which
// writes JSON.stringify of the value, would store. An undefined value has
// no text and arrives as no value, which the backend refuses as
// electron-store does.

import type { AppConfig } from '../../shared/types/app-config'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const appConfigApi = {
  appConfigGetAll: () => call<AppConfig>('app_config_get_all'),
  appConfigSet: async (key, value) => {
    await call<void>('app_config_set', { key, value: JSON.stringify(value) })
  },
} satisfies Partial<VialAPI>
