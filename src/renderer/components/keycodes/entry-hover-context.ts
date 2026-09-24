// SPDX-License-Identifier: GPL-2.0-or-later
//
// Whether hovering an entry shows it in full
// (`PipetteSettings.entryHoverPreview`, "Hover Details"). Provided once in
// `App.tsx`, around both the editor surface and the app-level modals, so
// the tile tabs of every key picker — including the small pickers inside
// the Combo / Key Override / Alt Repeat Key / Tap Dance / Macro modals —
// read the same per-keyboard value without threading it through each
// modal's props. No provider means off.

import { createContext, useContext } from 'react'

export const EntryHoverPreviewContext = createContext(false)

export function useEntryHoverPreviewEnabled(): boolean {
  return useContext(EntryHoverPreviewContext)
}
