// SPDX-License-Identifier: GPL-2.0-or-later
//
// Whether hovering a macro shows its full contents
// (`PipetteSettings.macroHoverPreview`). Provided once in `App.tsx`, around
// both the editor surface and the app-level modals, so the Macro tab of every key picker — including
// the small pickers inside the Combo / Key Override / Alt Repeat Key /
// Tap Dance / Macro modals — reads the same per-keyboard value without
// threading it through each modal's props. No provider means off.

import { createContext, useContext } from 'react'

export const MacroHoverPreviewContext = createContext(false)

export function useMacroHoverPreviewEnabled(): boolean {
  return useContext(MacroHoverPreviewContext)
}
