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
  /** SINGLE PREDICATE (Plan-qwerty-select-no-rewrite v7): `remapKind` is
   *  ALREADY the unified "does the active pack want a keymap rewrite"
   *  signal (see `useDevicePrefs.ts` — it's gated on `keymapApplicable &&
   *  buildKeymapRewriteTable(map).ok`, not `.ok` alone); combined with
   *  `keymap.size > 0`, this is the SAME condition `requestApply` itself
   *  requires, so tab AND Apply-button visibility both collapse onto this
   *  one boolean rather than needing separate checks that could disagree.
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
  /** Resets back to the simulation/pack tab — called by the host's own
   *  uid/keymap-size clear effect (which also clears history / exits View
   *  Matrix mode, so it stays in `KeymapEditor` rather than moving here). */
  resetPackTab: () => void
}

/** Simulation/Base tab (Plan-qwerty-select-no-rewrite v7 — シミュレーション
 * タブ方式). Which of the two vertical tabs (pack-name simulation vs. the
 * real "Base" keymap) is showing when `remapKind === 'simulated'` shows them
 * at all. Defaults to the simulation tab; a user switch to Base persists
 * only until the next uid change (via `resetPackTab`) or a layout change
 * (tracked internally below), not across a select change or a re-render. */
export function useKeymapPackTabs({
  keyboardLayout, remapKind, keymap, encoderLayout, encoderCount, currentLayer,
  typingTestMode, viewMatrixActive, handleDeselect,
  parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
  remapLabel, layerKeycodes, layerEncoderKeycodes, remappedKeys, layerEncoderRemapped,
}: UseKeymapPackTabsOptions): UseKeymapPackTabsReturn {
  const [packTab, setPackTab] = useState<KeymapPackTab>('pack')

  const resetPackTab = useCallback(() => { setPackTab('pack') }, [])

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

  // Reset to the simulation tab whenever the selected Key Label / layout
  // changes (the footer's Keyboard Layout select — `keyboardLayout` here is
  // the exact same value `useDevicePrefs.layout` feeds into `remapKind`'s
  // own derivation). Without this, a user parked on the Base tab who then
  // picks a different pack sees no visible change: the newly selected
  // pack's simulated keymap only ever renders on the pack tab, and
  // `remapKind` alone can't signal the switch since it stays `'simulated'`
  // across two different permutation packs. Same prev-value-ref idiom as
  // the host's own uid reset effect (kept separate there — that effect also
  // clears history/View Matrix, which a same-uid layout change must not
  // trigger) — only acts on an actual change, not on mount or every
  // render, so a manual tab click right after a layout change isn't
  // immediately undone by a stray re-render.
  const prevKeyboardLayoutRef = useRef(keyboardLayout)
  useEffect(() => {
    if (keyboardLayout !== prevKeyboardLayoutRef.current) {
      prevKeyboardLayoutRef.current = keyboardLayout
      setPackTab('pack')
    }
  }, [keyboardLayout])

  // FIX C (external review): a keymap must actually be loaded for a
  // Rewrite to mean anything — `useKeymapApplyPrompt.requestApply` already
  // no-ops when `keymapEditable` is false (App.tsx passes `keyboard.keymap
  // .size > 0` into that hook), but nothing here previously folded that
  // into tab/button VISIBILITY, so a permutation pack could show a
  // tabs+Apply UI that silently did nothing when clicked. Derived straight
  // from this component's own `keymap` prop — the exact same `Map` App.tsx
  // reads `.size` off of for the hook — rather than a second prop that
  // could drift out of sync with it.
  const keymapEditable = keymap.size > 0
  const showPackTabs = remapKind === 'simulated' && keymapEditable && !typingTestMode && !viewMatrixActive
  const packTabReadOnly = showPackTabs && packTab === 'pack'

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

  // Base tab's data source (Plan-qwerty-select-no-rewrite v7): the SAME
  // "no tabs" `<KeyboardPane>` JSX renders both the plain (no-tabs) state
  // and `showPackTabs && packTab === 'base'` — only these source variables
  // differ between the two. Raw/identity (`baseLayer*`, `EMPTY_REMAPPED`,
  // `undefined` remapLabel) while on the Base tab; otherwise the normal
  // `remapLabel`/`isRemapped`-driven values every other state (JIS, QWERTY,
  // View Matrix, ...) already used.
  const onBaseTab = showPackTabs && packTab === 'base'
  const primaryKeycodes = onBaseTab ? baseLayerKeycodes : layerKeycodes
  const primaryEncoderKeycodes = onBaseTab ? baseLayerEncoderKeycodes : layerEncoderKeycodes
  const primaryRemappedKeys = onBaseTab ? EMPTY_REMAPPED : remappedKeys
  const primaryRemappedEncoders = onBaseTab ? EMPTY_REMAPPED : layerEncoderRemapped
  const primaryRemapLabel = onBaseTab ? undefined : remapLabel

  return {
    packTab, showPackTabs, packTabReadOnly,
    primaryKeycodes, primaryEncoderKeycodes, primaryRemappedKeys, primaryRemappedEncoders, primaryRemapLabel,
    handlePackTabChange, resetPackTab,
  }
}
