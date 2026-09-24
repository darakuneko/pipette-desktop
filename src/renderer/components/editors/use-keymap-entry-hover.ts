// SPDX-License-Identifier: GPL-2.0-or-later
//
// Entry hover bubble on the editable keymap: dwelling on a key or an
// encoder direction whose keycode on the real current layer is a macro
// (M0, M1, …) or a Tap Dance (TD(0), TD(1), …) shows that entry in full.
// Combo / Key Override / Alt Repeat Key entries have no keycode of their
// own, so they only show from their picker tiles. The entry comes from the
// raw keymap / encoder value, never from the displayed legend, so a Key
// Label pack's remapped label or a layer hover preview drawn on the board
// never changes the answer.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { getMacroIndex, getTapDanceIndex, isTapDanceKeycode } from '../../../shared/keycodes/keycodes'
import type { KleKey } from '../../../shared/kle/types'
import type { MacroAction } from '../../../preload/macro'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { HoverEntryKind, HoverEntrySources } from '../keycodes/hover-entry'
import { useEntryHover, type EntryHoverBubbleState } from '../keycodes/use-entry-hover'

/** The macro or Tap Dance a raw keycode points at, or null for anything
 *  else. `getTapDanceIndex` only reads the low byte, so the Tap Dance
 *  range is checked first. */
export function hoverTargetOf(code: number | undefined): { kind: HoverEntryKind; index: number } | null {
  if (code === undefined) return null
  if (isTapDanceKeycode(code)) return { kind: 'tapDance', index: getTapDanceIndex(code) }
  const index = getMacroIndex(code)
  return index < 0 ? null : { kind: 'macro', index }
}

export interface UseKeymapEntryHoverOptions {
  macros?: MacroAction[][]
  tapDance?: TapDanceEntry[]
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

export interface UseKeymapEntryHoverReturn {
  bubble: EntryHoverBubbleState | null
  /** `KeyWidget`'s hover callback. Referentially stable. */
  onKeyHover: (key: KleKey, keycode: string, rect: DOMRect) => void
  /** `EncoderWidget`'s hover callback. Referentially stable. */
  onEncoderHover: (encoderIdx: number, dir: number, rect: DOMRect) => void
  /** Cancels a pending open and closes the bubble. Referentially stable. */
  hide: () => void
}

export function useKeymapEntryHover({
  macros, tapDance, enabled, disabled, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey,
}: UseKeymapEntryHoverOptions): UseKeymapEntryHoverReturn {
  const active = enabled && !disabled
  const sources = useMemo<HoverEntrySources>(() => ({ macro: macros, tapDance }), [macros, tapDance])
  const { bubble, showEntry, hide } = useEntryHover(sources, active)

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
    const target = s.active ? hoverTargetOf(mapKey(s)) : null
    if (target === null) hide()
    else showEntry(target.kind, target.index, rect)
  }, [showEntry, hide])

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
