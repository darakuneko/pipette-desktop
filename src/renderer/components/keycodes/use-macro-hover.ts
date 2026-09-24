// SPDX-License-Identifier: GPL-2.0-or-later
//
// State for the macro hover bubble: one shared bubble per surface (the
// Macro tab tile grid, the editable keymap pane), opened after the shared
// 300 ms dwell. The bubble reads its actions from the current `macros` on
// every render, so an edit to the hovered macro shows up right away and a
// macro that becomes empty closes it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { MacroAction } from '../../../preload/macro'
import { useSharedHoverBubble } from '../../hooks/use-shared-hover-bubble'

export interface MacroHoverBubbleState {
  /** Macro number, shown as `M{index}`. */
  index: number
  actions: MacroAction[]
  /** Viewport rect of the hovered tile / key the bubble anchors to. */
  rect: DOMRect
}

export interface UseMacroHoverReturn {
  /** The bubble to show, or null. */
  bubble: MacroHoverBubbleState | null
  /** Schedules the bubble for macro `index`, or closes it when that macro
   *  is empty, missing or the hover is turned off. Referentially stable. */
  showMacro: (index: number, rect: DOMRect) => void
  /** Cancels a pending open and closes the bubble. Referentially stable. */
  hide: () => void
}

export function useMacroHover(macros: MacroAction[][] | undefined, enabled: boolean): UseMacroHoverReturn {
  const { target, show, hide } = useSharedHoverBubble<{ index: number; rect: DOMRect }>()

  // Read through a ref so `showMacro` keeps one identity across macro
  // edits — it reaches memoized key / encoder widgets. Hover events only
  // arrive after commit, so a layout effect keeps it current.
  const latestRef = useRef({ macros, enabled })
  useLayoutEffect(() => {
    latestRef.current = { macros, enabled }
  }, [macros, enabled])

  const showMacro = useCallback((index: number, rect: DOMRect) => {
    const s = latestRef.current
    if (!s.enabled || !s.macros?.[index]?.length) {
      hide()
      return
    }
    show({ index, rect })
  }, [show, hide])

  // Turning the hover off drops a pending open as well as a shown bubble.
  useEffect(() => {
    if (!enabled) hide()
  }, [enabled, hide])

  const actions = target && enabled ? macros?.[target.index] : undefined
  // Kept stable while the target and its actions are, so the bubble only
  // re-measures when something it shows changed.
  const bubble = useMemo(
    () => (target && actions?.length ? { index: target.index, actions, rect: target.rect } : null),
    [target, actions],
  )
  return { bubble, showMacro, hide }
}
