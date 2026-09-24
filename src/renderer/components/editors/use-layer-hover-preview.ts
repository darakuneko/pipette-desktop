// SPDX-License-Identifier: GPL-2.0-or-later
//
// Layer hover preview: dwelling on a layer key (MO / LT / TG / ... — anything
// `getLayerOpTarget` recognizes) redraws the whole keyboard with the target
// layer's contents without touching `currentLayer`, the selection or the
// undo history. Leaving the key restores the real layer immediately.
//
// Only `KeyWidget` emits hover callbacks, so layer keys placed on encoders
// never start a preview.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { serialize } from '../../../shared/keycodes/keycodes'
import { getLayerOpTarget } from '../../../shared/keycodes/keycodes-classify'
import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { useSharedHoverBubble } from '../../hooks/use-shared-hover-bubble'
import { EMPTY_REMAPPED } from './keymap-editor-types'
import { useLayerKeycodes } from './use-layer-keycodes'

/** What `KeymapEditor` hands `KeymapPrimaryPane` for the preview. */
export interface LayerHoverPreviewInput {
  layers: number
  currentLayer: number
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  isRemapped?: (qmkId: string) => boolean
  /** Footer label for a layer, e.g. "Layer 2" or the user's layer name. */
  layerLabel: (layer: number) => string
  /** Changes when the connected keyboard changes. */
  deviceKey?: string
  /** True while the preview is turned off, the Key Popover is open or the
   *  picker holds paste targets. */
  blocked: boolean
}

export interface UseLayerHoverPreviewOptions extends Omit<LayerHoverPreviewInput, 'blocked' | 'layerLabel'> {
  remapLabel?: (qmkId: string) => string
  /** Build raw (never remapped) maps, matching the Base tab's own data. */
  raw: boolean
  /** Any mode the preview must stay out of. */
  disabled: boolean
  /** Identifies the visible pack tab; a change cancels the preview. */
  surfaceKey: string
  /** The real layer's keycodes / remap tint as currently displayed. The
   *  hovered key keeps these during a preview so its inner (tap) rect
   *  stays clickable and moving onto it can still cancel the preview. */
  realKeycodes: Map<string, string>
  realRemappedKeys: Set<string>
}

export interface UseLayerHoverPreviewReturn {
  /** The layer being shown instead of `currentLayer`, or null. */
  previewLayer: number | null
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  remappedEncoders: Set<string>
  onKeyHover: (key: KleKey) => void
  onKeyHoverEnd: () => void
  /** Drops a pending or visible preview. */
  cancel: () => void
}

/** The inputs a preview was started under. A preview is only shown while
 *  every field still matches, so an edit, a layer switch or a device
 *  change never renders a stale frame even before the clearing effect
 *  below has run. */
interface PreviewTarget {
  layer: number
  /** `posKey` of the key that started the preview. */
  pos: string
  currentLayer: number
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  deviceKey?: string
  surfaceKey: string
}

/** Target layer of the key at (row, col) on `currentLayer`, read from the
 *  raw keymap value so a Key Label pack's remapped legend never changes
 *  the answer. Null for non-layer keys, the current layer itself and
 *  layers the keyboard doesn't have. */
export function resolveLayerHoverTarget(
  keymap: Map<string, number>,
  currentLayer: number,
  layers: number,
  row: number,
  col: number,
): number | null {
  const code = keymap.get(`${currentLayer},${row},${col}`)
  if (code === undefined) return null
  const target = getLayerOpTarget(serialize(code))
  if (!target) return null
  const { layer } = target
  if (layer < 0 || layer >= layers || layer === currentLayer) return null
  return layer
}

export function useLayerHoverPreview({
  layers, currentLayer, keymap, encoderLayout, encoderCount, isRemapped, remapLabel,
  deviceKey, raw, disabled, surfaceKey, realKeycodes, realRemappedKeys,
}: UseLayerHoverPreviewOptions): UseLayerHoverPreviewReturn {
  const { target, show, hide } = useSharedHoverBubble<PreviewTarget>()

  // Read through a ref so the hover callbacks stay referentially stable —
  // they reach every memoized `KeyWidget`, and a new function on each
  // keymap edit or layer switch would re-render the whole board. Hover
  // events only arrive after commit, so a layout effect keeps it current.
  const latestRef = useRef({ layers, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey, disabled })
  useLayoutEffect(() => {
    latestRef.current = { layers, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey, disabled }
  }, [layers, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey, disabled])

  const onKeyHover = useCallback((key: KleKey) => {
    const s = latestRef.current
    const layer = s.disabled ? null : resolveLayerHoverTarget(s.keymap, s.currentLayer, s.layers, key.row, key.col)
    if (layer === null) {
      hide()
      return
    }
    show({
      layer, pos: posKey(key.row, key.col), currentLayer: s.currentLayer, keymap: s.keymap, encoderLayout: s.encoderLayout,
      deviceKey: s.deviceKey, surfaceKey: s.surfaceKey,
    })
  }, [show, hide])

  useEffect(() => {
    hide()
  }, [hide, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey, disabled])

  const previewLayer = target
    && !disabled
    && target.currentLayer === currentLayer
    && target.keymap === keymap
    && target.encoderLayout === encoderLayout
    && target.deviceKey === deviceKey
    && target.surfaceKey === surfaceKey
    ? target.layer
    : null

  // Built once per shown preview (the builders are memoized on the
  // keymap / encoder layout / remap inputs), never per hover event.
  const built = useLayerKeycodes({
    keymap, encoderLayout, encoderCount, currentLayer: previewLayer ?? 0,
    remapLabel: raw ? undefined : remapLabel, isRemapped: raw ? undefined : isRemapped,
    typingTestEffectiveLayer: 0, enabled: previewLayer !== null,
  })

  const previewPos = previewLayer !== null && target ? target.pos : null
  const builtRemapped = raw ? EMPTY_REMAPPED : built.remappedKeys
  // Copies, so the maps cached by the builders are never mutated.
  const keycodes = useMemo(() => {
    const base = built.layerKeycodes
    if (previewPos === null || base.get(previewPos) === realKeycodes.get(previewPos)) return base
    const next = new Map(base)
    const real = realKeycodes.get(previewPos)
    if (real === undefined) next.delete(previewPos)
    else next.set(previewPos, real)
    return next
  }, [built.layerKeycodes, previewPos, realKeycodes])
  const remappedKeys = useMemo(() => {
    if (previewPos === null) return builtRemapped
    const real = realRemappedKeys.has(previewPos)
    if (builtRemapped.has(previewPos) === real) return builtRemapped
    const next = new Set(builtRemapped)
    if (real) next.add(previewPos)
    else next.delete(previewPos)
    return next
  }, [builtRemapped, previewPos, realRemappedKeys])

  return {
    previewLayer,
    keycodes,
    encoderKeycodes: built.layerEncoderKeycodes,
    remappedKeys,
    remappedEncoders: raw ? EMPTY_REMAPPED : built.layerEncoderRemapped,
    onKeyHover,
    onKeyHoverEnd: hide,
    cancel: hide,
  }
}
