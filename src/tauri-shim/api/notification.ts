// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI notification member for the Tauri build: the startup notices
// (src-tauri/src/notification_commands.rs).

import type { NotificationFetchResult } from '../../shared/types/notification'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const notificationApi = {
  notificationFetch: () => call<NotificationFetchResult>('notification_fetch'),
} satisfies Partial<VialAPI>
