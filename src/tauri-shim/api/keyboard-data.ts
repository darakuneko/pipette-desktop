// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the stored keyboards and the keyboard names for
// the Tauri build (src-tauri/src/store_commands/keyboard_data.rs). Recording
// a keyboard's name is a write of the keyboard names, queued under their
// key so names recorded one after another are written in that order.

import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import type { StoredKeyboardInfo } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import { enqueue } from '../key-queue'

export const keyboardDataApi = {
  listStoredKeyboards: () => call<StoredKeyboardInfo[]>('list_stored_keyboards'),
  keyboardMetaNameIfMissing: (uid, name) =>
    enqueue(KEYBOARD_META_SYNC_UNIT, async () => {
      await call<void>('keyboard_meta_name_if_missing', { uid, name })
    }),
} satisfies Partial<VialAPI>
