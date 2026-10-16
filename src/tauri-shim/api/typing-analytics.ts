// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI typing analytics members that read the cache directly
// (src-tauri/src/analytics_commands/queries.rs): the keyboards with data and
// their daily summaries. A filter list the renderer leaves out is sent as
// the empty list, as the preload's defaults send it.

import type { TypingDailySummary, TypingKeyboardSummary } from '../../shared/types/typing-analytics'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const typingAnalyticsApi = {
  typingAnalyticsListKeyboards: () => call<TypingKeyboardSummary[]>('typing_analytics_list_keyboards'),
  typingAnalyticsListItems: (uid, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDailySummary[]>('typing_analytics_list_items', { uid, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListItemsLocal: (uid, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDailySummary[]>('typing_analytics_list_items_local', { uid, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListItemsForHash: (uid, machineHash, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDailySummary[]>('typing_analytics_list_items_for_hash', { uid, machineHash, appScopes, typingTestScopes, runIdScopes }),
} satisfies Partial<VialAPI>
