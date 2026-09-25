// SPDX-License-Identifier: GPL-2.0-or-later
//
// The per-keyboard key picker tab order (`PipetteSettings.keycodeTabOrder`).
// Provided once by `PickerPrefsProvider.tsx`, around both the editor surface
// and the app-level modals, so every `TabbedKeycodes` — the keymap editor's
// picker and the pickers inside the Tap Dance / Combo / Key Override / Alt
// Repeat Key / Macro editors — shows the same order. No provider means the
// default order and no saving.

import { createContext, useContext } from 'react'

export interface KeycodeTabOrderValue {
  /** Saved full order, or `undefined` for the default order. */
  order: string[] | undefined
  /** `undefined` restores the default order and clears the saved one. */
  setOrder: (order: string[] | undefined) => void
  /** Changes when the connected keyboard changes; an open reorder mode
   *  closes on a change. */
  scopeKey: string | null
}

export const KeycodeTabOrderContext = createContext<KeycodeTabOrderValue>({
  order: undefined,
  setOrder: () => {},
  scopeKey: null,
})

export function useKeycodeTabOrder(): KeycodeTabOrderValue {
  return useContext(KeycodeTabOrderContext)
}
