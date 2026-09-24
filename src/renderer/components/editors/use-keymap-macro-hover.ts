// SPDX-License-Identifier: GPL-2.0-or-later
//
// Macro hover bubble on the editable keymap: dwelling on a key or an
// encoder direction whose keycode on the real current layer is a macro
// (M0, M1, …) shows that macro's full contents. The macro number comes
// from the raw keymap / encoder value, never from the displayed legend, so
// a Key Label pack's remapped label or a layer hover preview drawn on the
// board never changes the answer.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { getMacroIndex } from '../../../shared/keycodes/keycodes'
import type { KleKey } from '../../../shared/kle/types'
import type { MacroAction } from '../../../preload/macro'
import { useMacroHover, type MacroHoverBubbleState } from '../keycodes/use-macro-hover'

/** Macro number of a raw keycode, or null for anything else. */
export function macroIndexOf(code: number | undefined): number | null {
  if (code === undefined) return null
  const index = getMacroIndex(code)
  return index < 0 ? null : index
}

export interface UseKeymapMacroHoverOptions {
  macros?: MacroAction[][]
  /** The Settings / Import toggle. */
  enabled: boolean
  /** Any mode the bubble must stay out of. */
  disabled: boolean
  currentLayer: number
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  /** Changes when the connected keyboard changes. */
  deviceKey?: string
  /** Identifies the visible pack tab. */
  surfaceKey: string
}

export interface UseKeymapMacroHoverReturn {
  bubble: MacroHoverBubbleState | null
  /** `KeyWidget`'s hover callback. Referentially stable. */
  onKeyHover: (key: KleKey, keycode: string, rect: DOMRect) => void
  /** `EncoderWidget`'s hover callback. Referentially stable. */
  onEncoderHover: (encoderIdx: number, dir: number, rect: DOMRect) => void
  /** Cancels a pending open and closes the bubble. Referentially stable. */
  hide: () => void
}

export function useKeymapMacroHover({
  macros, enabled, disabled, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey,
}: UseKeymapMacroHoverOptions): UseKeymapMacroHoverReturn {
  const active = enabled && !disabled
  const { bubble, showMacro, hide } = useMacroHover(macros, active)

  // Read through a ref so the hover callbacks keep one identity — they
  // reach every memoized key and encoder widget.
  const latestRef = useRef({ active, currentLayer, keymap, encoderLayout })
  useLayoutEffect(() => {
    latestRef.current = { active, currentLayer, keymap, encoderLayout }
  }, [active, currentLayer, keymap, encoderLayout])

  // `mapKey` only runs while the bubble is on, so a hover with the bubble
  // off never looks up or decodes a keycode.
  const showAt = useCallback((mapKey: (s: typeof latestRef.current) => number | undefined, rect: DOMRect) => {
    const s = latestRef.current
    const index = s.active ? macroIndexOf(mapKey(s)) : null
    if (index === null) hide()
    else showMacro(index, rect)
  }, [showMacro, hide])

  const onKeyHover = useCallback((key: KleKey, _keycode: string, rect: DOMRect) => {
    showAt((s) => s.keymap.get(`${s.currentLayer},${key.row},${key.col}`), rect)
  }, [showAt])

  const onEncoderHover = useCallback((encoderIdx: number, dir: number, rect: DOMRect) => {
    showAt((s) => s.encoderLayout.get(`${s.currentLayer},${encoderIdx},${dir}`), rect)
  }, [showAt])

  // A layer switch, keymap edit or keyboard change may put a different
  // keycode under the pointer, so the bubble closes until the next hover.
  useEffect(() => {
    hide()
  }, [hide, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey])

  return { bubble, onKeyHover, onEncoderHover, hide }
}
