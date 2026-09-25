// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { KeyboardLayoutId } from '../../hooks/useKeyboardLayout'
import type { RemapKind } from '../keyboard/constants'
import { EMPTY_REMAPPED } from './keymap-editor-types'
import type { KeymapPackTab } from './KeymapPackTabs'
import { useLayerKeycodes } from './use-layer-keycodes'

export interface UseKeymapPackTabsOptions {
  keyboardLayout?: KeyboardLayoutId
  remapKind?: RemapKind
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  currentLayer: number
  typingTestMode?: boolean
  viewMatrixActive: boolean
  handleDeselect: () => void
  parsedMacros?: MacroAction[][] | null
  macroBuffer?: number[]
  macroCount?: number
  vialProtocol?: number
  tapDanceEntries?: TapDanceEntry[]
  remapLabel?: (qmkId: string) => string
  layerKeycodes: Map<string, string>
  layerEncoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  layerEncoderRemapped: Set<string>
}

export interface UseKeymapPackTabsReturn {
  packTab: KeymapPackTab
  /** SINGLE PREDICATE: `remapKind` is ALREADY the unified "does the
   *  active pack want a keymap rewrite" signal (see `useDevicePrefs.ts`
   *  — it's gated on `keymapApplicable && buildKeymapRewriteTable(map).ok`,
   *  not `.ok` alone); combined with `keymap.size > 0`, this is the SAME
   *  condition `requestApply` itself requires, so tab AND Apply-button
   *  visibility both collapse onto this one boolean rather than needing
   *  separate checks that could disagree.
   *  Suppressed during typing test / View Matrix mode too, neither of
   *  which has a concept of a second (Base) keymap surface to switch to. */
  showPackTabs: boolean
  /** True exactly while the visible pane is the read-only simulation tab —
   *  gates both `KeyboardPane`'s own `readOnly` and every picker edit path,
   *  belt-and-braces on top of `handlePackTabChange` already clearing any
   *  live selection when this becomes true. */
  packTabReadOnly: boolean
  primaryKeycodes: Map<string, string>
  primaryEncoderKeycodes: Map<string, [string, string]>
  primaryRemappedKeys: Set<string>
  primaryRemappedEncoders: Set<string>
  primaryRemapLabel?: (qmkId: string) => string
  handlePackTabChange: (tab: KeymapPackTab) => void
  /** Resets back to the Default (`'base'`) tab and clears the selection —
   *  called by the host's own uid/keymap-size clear effect (which also
   *  clears history / exits View Matrix mode, so it stays in `KeymapEditor`
   *  rather than moving here). */
  resetPackTab: () => void
  /** Reports the user's own pick in the footer's Key Labels select. A
   *  different layout marks the coming `keyboardLayout` change so it opens
   *  the pack tab; the layout already shown opens the pack tab at once
   *  (when the tabs are shown) and marks nothing. */
  notifyUserLayoutChange: (layout: string) => void
}

/** Simulation/Base tab. Which of the two vertical tabs (the real "Base"
 * keymap, labeled Default, vs. the pack-name simulation) is showing when
 * `remapKind === 'simulated'` shows them at all. Defaults to Default; the
 * tab choice persists across ordinary re-renders and stays until either
 * `resetPackTab()` runs (called by the host on a uid change or when the
 * keymap empties) or the user picks a different layout in the footer (see
 * the `keyboardLayout` change effect below). */
export function useKeymapPackTabs({
  keyboardLayout, remapKind, keymap, encoderLayout, encoderCount, currentLayer,
  typingTestMode, viewMatrixActive, handleDeselect,
  parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
  remapLabel, layerKeycodes, layerEncoderKeycodes, remappedKeys, layerEncoderRemapped,
}: UseKeymapPackTabsOptions): UseKeymapPackTabsReturn {
  const [packTab, setPackTab] = useState<KeymapPackTab>('base')
  const userLayoutChangeRef = useRef(false)

  // Clears the selection too: a key selected on the previous keyboard (or
  // on a keymap that has since emptied) must not survive into the fresh
  // Default tab.
  const resetPackTab = useCallback(() => {
    userLayoutChangeRef.current = false
    setPackTab('base')
    handleDeselect()
  }, [handleDeselect])

  // Switching TO the simulation tab also drops any live selection/multi-
  // select/picker-selection state — belt-and-braces on top of that pane's
  // own `readOnly` (which already blocks every click/dblclick path into
  // it): without this, a key selected on Base right before switching tabs
  // would stay selected in the (invisible) shared selection state, and a
  // picker click while viewing the simulation tab would still paste into
  // it.
  const handlePackTabChange = useCallback((tab: KeymapPackTab) => {
    setPackTab(tab)
    if (tab === 'pack') handleDeselect()
  }, [handleDeselect])

  const prevKeyboardLayoutRef = useRef(keyboardLayout)
  // Latest `showPackTabs` for `notifyUserLayoutChange`, which runs from an
  // event handler outside this render.
  const showPackTabsRef = useRef(false)
  // Re-picking the layout already shown never changes `keyboardLayout`, so
  // the effect below would never consume a mark for it — it is handled
  // here instead, and no mark is left for a later unrelated change.
  const notifyUserLayoutChange = useCallback((layout: string) => {
    if (layout !== prevKeyboardLayoutRef.current) {
      userLayoutChangeRef.current = true
    } else if (showPackTabsRef.current) {
      handlePackTabChange('pack')
    }
  }, [handlePackTabChange])

  // Opens the pack tab when the user picks a different Key Label layout in
  // the footer, so the new pack's simulated keymap shows at once
  // (`remapKind` stays `'simulated'` across two permutation packs, so it
  // can't signal the switch). `keyboardLayout` also changes when the saved
  // prefs are restored on connect / uid change — in the same render as the
  // host's reset or any number of renders later — and that value looks the
  // same as a user pick. So the footer handler marks its own pick through
  // `notifyUserLayoutChange` (via `KeymapEditorHandle`) rather than this
  // effect guessing from timing; unmarked changes (prefs restore, the reset
  // to QWERTY after a successful Apply) leave the tab alone. Acts only on
  // an actual value change, so an unrelated re-render never undoes a
  // manual tab click. `handlePackTabChange` clears the selection, same as
  // a manual switch to the pack tab.
  useEffect(() => {
    if (keyboardLayout === prevKeyboardLayoutRef.current) return
    prevKeyboardLayoutRef.current = keyboardLayout
    if (!userLayoutChangeRef.current) return
    userLayoutChangeRef.current = false
    handlePackTabChange('pack')
  }, [keyboardLayout, handlePackTabChange])

  // A keymap must actually be loaded for a Rewrite to mean anything —
  // `useKeymapApplyPrompt.requestApply` already no-ops when
  // `keymapEditable` is false (App.tsx passes `keyboard.keymap.size > 0`
  // into that hook). Derived straight from this component's own `keymap`
  // prop — the exact same `Map` App.tsx reads `.size` off of for the
  // hook — rather than a second prop that could drift out of sync with it.
  const keymapEditable = keymap.size > 0
  const showPackTabs = remapKind === 'simulated' && keymapEditable && !typingTestMode && !viewMatrixActive
  const packTabReadOnly = showPackTabs && packTab === 'pack'
  useEffect(() => { showPackTabsRef.current = showPackTabs }, [showPackTabs])

  // Raw (never remapped) keycodes for the Base tab — same underlying
  // keymap/macro data as `layerKeycodes` above, built with `remapLabel`/
  // `isRemapped` omitted so `useLayerKeycodes` falls back to identity (see
  // its own `remap`/`checkRemapped` defaults). `enabled` skips the whole
  // O(keymap size) build (and the duplicate macro parse) whenever this
  // instance's output isn't actually being shown — tabs hidden, or the
  // simulation tab active — rather than paying for it every render.
  const { layerKeycodes: baseLayerKeycodes, layerEncoderKeycodes: baseLayerEncoderKeycodes } = useLayerKeycodes({
    parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
    keymap, encoderLayout, encoderCount, currentLayer,
    typingTestMode: false, typingTestEffectiveLayer: 0,
    enabled: showPackTabs && packTab === 'base',
  })

  // Base tab's data source: the SAME "no tabs" `<KeyboardPane>` JSX
  // renders both the plain (no-tabs) state and
  // `showPackTabs && packTab === 'base'` — only these source variables
  // differ between the two. Raw/identity (`baseLayer*`, `EMPTY_REMAPPED`,
  // `undefined` remapLabel) while on the Base tab; otherwise the normal
  // `remapLabel`/`isRemapped`-driven values every other state (JIS,
  // QWERTY, View Matrix, ...) already uses.
  const onBaseTab = showPackTabs && packTab === 'base'
  const primaryKeycodes = onBaseTab ? baseLayerKeycodes : layerKeycodes
  const primaryEncoderKeycodes = onBaseTab ? baseLayerEncoderKeycodes : layerEncoderKeycodes
  const primaryRemappedKeys = onBaseTab ? EMPTY_REMAPPED : remappedKeys
  const primaryRemappedEncoders = onBaseTab ? EMPTY_REMAPPED : layerEncoderRemapped
  const primaryRemapLabel = onBaseTab ? undefined : remapLabel

  return {
    packTab, showPackTabs, packTabReadOnly,
    primaryKeycodes, primaryEncoderKeycodes, primaryRemappedKeys, primaryRemappedEncoders, primaryRemapLabel,
    handlePackTabChange, resetPackTab, notifyUserLayoutChange,
  }
}
