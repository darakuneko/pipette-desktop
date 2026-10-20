// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI keymap snapshot members for the Tauri build
// (src-tauri/src/analytics_commands/keymaps.rs). The snapshot to save
// crosses as the text of JSON.stringify(snapshot), taken when the member is
// called, so the backend stores and compares the keymap and layout with
// their keys in the order the renderer built them. The pick and the list
// pass their arguments as they are; the backend checks them. None of them
// waits for another call.

import type { TypingKeymapSnapshot, TypingKeymapSnapshotSummary } from '../../shared/types/typing-analytics'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const typingAnalyticsKeymapsApi = {
  typingAnalyticsSaveKeymapSnapshot: (partial) =>
    call<{ saved: boolean; savedAt: number | null }>('typing_analytics_save_keymap_snapshot', {
      snapshot: JSON.stringify(partial) as string | undefined,
    }),
  typingAnalyticsGetKeymapSnapshotForRange: (uid, fromMs, toMs) =>
    call<TypingKeymapSnapshot | null>('typing_analytics_get_keymap_snapshot_for_range', { uid, fromMs, toMs }),
  typingAnalyticsListKeymapSnapshots: (uid) =>
    call<TypingKeymapSnapshotSummary[]>('typing_analytics_list_keymap_snapshots', { uid }),
} satisfies Partial<VialAPI>
