// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members that hand things to the system
// (src-tauri/src/shell.rs). The backend checks the URL: anything but an
// http or https URL rejects.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const shellApi = {
  openExternal: async (url) => {
    await call<void>('open_external', { url })
  },
} satisfies Partial<VialAPI>
