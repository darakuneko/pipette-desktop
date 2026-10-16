// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI recording members of the typing analytics for the Tauri build
// (src-tauri/src/analytics_commands/record.rs). The renderer sends each
// event after the previous one has settled and the flush after them, so the
// shim sends them as they come, in that order. An event crosses as JSON:
// what JSON cannot carry (a NaN or infinite time) arrives as null, which the
// backend rejects as the Electron handler rejects a non-finite number.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const typingAnalyticsRecordApi = {
  typingAnalyticsEvent: async (event) => {
    await call<null>('typing_analytics_event', { event })
  },
  typingAnalyticsFlush: async (uid) => {
    await call<null>('typing_analytics_flush', { uid })
  },
} satisfies Partial<VialAPI>
