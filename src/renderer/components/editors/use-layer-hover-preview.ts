// SPDX-License-Identifier: GPL-2.0-or-later
//
// Layer hover preview: dwelling on a layer key (MO / LT / TG / ... — anything
// `getLayerOpTarget` recognizes) on a key or an encoder direction redraws the
// whole keyboard with the target layer's contents without touching
// `currentLayer`, the selection or the undo history. Leaving it restores the
// real layer immediately.

import { useCallback, useMemo } from 'react'
import { serialize } from '../../../shared/keycodes/keycodes'
import { getLayerOpTarget } from '../../../shared/keycodes/keycodes-classify'
import type { KleKey } from '../../../shared/kle/types'
import { encoderPosKey, posKey } from '../../../shared/kle/pos-key'
import { useSharedHoverBubble } from '../../hooks/use-shared-hover-bubble'
import { useLatestRef } from '../../hooks/use-latest-ref'
import { useHideOnChange } from '../../hooks/use-hide-on-change'
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
  /** True while the Key Popover is open or the picker holds paste
   *  targets. `KeymapPrimaryPane` hides the entry hover bubble while it
   *  is true as well. */
  blocked: boolean
  /** The Auto Layer Preview toggle. Omitted means on. */
  enabled?: boolean
}

export interface UseLayerHoverPreviewOptions extends Omit<LayerHoverPreviewInput, 'blocked' | 'enabled' | 'layerLabel'> {
  remapLabel?: (qmkId: string) => string
  /** Build raw (never remapped) maps, matching the Base tab's own data. */
  raw: boolean
  /** Any mode the preview must stay out of. */
  disabled: boolean
  /** Identifies the visible pack tab; a change cancels the preview. */
  surfaceKey: string
  /** The real layer's keycodes / remap tint as currently displayed. The
   *  hovered key or encoder direction keeps these during a preview so its
   *  inner (tap) rect stays clickable and moving onto it can still cancel
   *  the preview. */
  realKeycodes: Map<string, string>
  realRemappedKeys: Set<string>
  realEncoderKeycodes: Map<string, [string, string]>
  realRemappedEncoders: Set<string>
}

export interface UseLayerHoverPreviewReturn {
  /** The layer being shown instead of `currentLayer`, or null. */
  previewLayer: number | null
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  remappedEncoders: Set<string>
  onKeyHover: (key: KleKey) => void
  onEncoderHover: (encoderIdx: number, dir: number) => void
  /** Ends a key or encoder hover. */
  onKeyHoverEnd: () => void
  /** Drops a pending or visible preview. */
  cancel: () => void
}

/** Where a preview started. Kept as a union because a key's `posKey` and
 *  an encoder direction's `encoderPosKey` can be the same string. */
export type LayerHoverSource =
  | { kind: 'key'; row: number; col: number }
  | { kind: 'encoder'; idx: number; dir: number }

/** The inputs a preview was started under. A preview is only shown while
 *  every field still matches, so an edit, a layer switch or a device
 *  change never renders a stale frame even before the clearing effect
 *  below has run. */
interface PreviewTarget {
  layer: number
  source: LayerHoverSource
  currentLayer: number
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  deviceKey?: string
  surfaceKey: string
}

/** Target layer of a raw keycode read on `currentLayer`. Null for a
 *  missing value, non-layer keycodes, the current layer itself and layers
 *  the keyboard doesn't have. */
function layerOfCode(code: number | undefined, currentLayer: number, layers: number): number | null {
  if (code === undefined) return null
  const target = getLayerOpTarget(serialize(code))
  if (!target) return null
  const { layer } = target
  if (layer < 0 || layer >= layers || layer === currentLayer) return null
  return layer
}

/** Target layer of the key at (row, col) on `currentLayer`, read from the
 *  raw keymap value so a Key Label pack's remapped legend never changes
 *  the answer. */
export function resolveLayerHoverTarget(
  keymap: Map<string, number>,
  currentLayer: number,
  layers: number,
  row: number,
  col: number,
): number | null {
  return layerOfCode(keymap.get(`${currentLayer},${row},${col}`), currentLayer, layers)
}

/** Encoder analogue of `resolveLayerHoverTarget`, for direction `dir`
 *  (0 = CW, 1 = CCW) of encoder `idx`. */
export function resolveEncoderLayerHoverTarget(
  encoderLayout: Map<string, number>,
  currentLayer: number,
  layers: number,
  idx: number,
  dir: number,
): number | null {
  return layerOfCode(encoderLayout.get(`${currentLayer},${idx},${dir}`), currentLayer, layers)
}

/** `set` with `key` in it exactly when `present`; `set` itself when that
 *  already holds, a copy otherwise. */
function withMember(set: Set<string>, key: string, present: boolean): Set<string> {
  if (set.has(key) === present) return set
  const next = new Set(set)
  if (present) next.add(key)
  else next.delete(key)
  return next
}

/** What `KeyboardWidget` draws for an encoder missing from its map. */
const NO_ENCODER_KEYCODES: [string, string] = ['KC_NO', 'KC_NO']

export function useLayerHoverPreview({
  layers, currentLayer, keymap, encoderLayout, encoderCount, isRemapped, remapLabel,
  deviceKey, raw, disabled, surfaceKey, realKeycodes, realRemappedKeys, realEncoderKeycodes, realRemappedEncoders,
}: UseLayerHoverPreviewOptions): UseLayerHoverPreviewReturn {
  const { target, show, hide } = useSharedHoverBubble<PreviewTarget>()

  // Read through a ref so the hover callbacks stay referentially stable —
  // they reach every memoized key and encoder widget, and a new function on each
  // keymap edit or layer switch would re-render the whole board.
  const latestRef = useLatestRef({ layers, currentLayer, keymap, encoderLayout, deviceKey, surfaceKey, disabled })

  const showFrom = useCallback((source: LayerHoverSource) => {
    const s = latestRef.current
    const layer = s.disabled ? null
      : source.kind === 'key' ? resolveLayerHoverTarget(s.keymap, s.currentLayer, s.layers, source.row, source.col)
        : resolveEncoderLayerHoverTarget(s.encoderLayout, s.currentLayer, s.layers, source.idx, source.dir)
    if (layer === null) {
      hide()
      return
    }
    show({
      layer, source, currentLayer: s.currentLayer, keymap: s.keymap, encoderLayout: s.encoderLayout,
      deviceKey: s.deviceKey, surfaceKey: s.surfaceKey,
    })
  }, [latestRef, show, hide])

  const onKeyHover = useCallback((key: KleKey) => {
    showFrom({ kind: 'key', row: key.row, col: key.col })
  }, [showFrom])

  const onEncoderHover = useCallback((idx: number, dir: number) => {
    showFrom({ kind: 'encoder', idx, dir })
  }, [showFrom])

  useHideOnChange(hide, [currentLayer, keymap, encoderLayout, deviceKey, surfaceKey, disabled])

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

  const source = previewLayer !== null && target ? target.source : null
  const previewPos = source?.kind === 'key' ? posKey(source.row, source.col) : null
  const encoderIdx = source?.kind === 'encoder' ? source.idx : null
  const encoderDir = source?.kind === 'encoder' ? source.dir : null
  const builtRemapped = raw ? EMPTY_REMAPPED : built.remappedKeys
  const builtEncoderRemapped = raw ? EMPTY_REMAPPED : built.layerEncoderRemapped
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
  const remappedKeys = useMemo(
    () => (previewPos === null ? builtRemapped : withMember(builtRemapped, previewPos, realRemappedKeys.has(previewPos))),
    [builtRemapped, previewPos, realRemappedKeys],
  )
  // Only the hovered direction goes back to the real layer; the other one
  // keeps the target layer's keycode. The [CW, CCW] pair is copied too,
  // since the cached map shares its pairs.
  const encoderKeycodes = useMemo(() => {
    const base = built.layerEncoderKeycodes
    if (encoderIdx === null || (encoderDir !== 0 && encoderDir !== 1)) return base
    const id = String(encoderIdx)
    const shown = base.get(id) ?? NO_ENCODER_KEYCODES
    const real = (realEncoderKeycodes.get(id) ?? NO_ENCODER_KEYCODES)[encoderDir]
    if (shown[encoderDir] === real) return base
    const pair: [string, string] = [shown[0], shown[1]]
    pair[encoderDir] = real
    return new Map(base).set(id, pair)
  }, [built.layerEncoderKeycodes, encoderIdx, encoderDir, realEncoderKeycodes])
  const remappedEncoders = useMemo(() => {
    if (encoderIdx === null || encoderDir === null) return builtEncoderRemapped
    const pos = encoderPosKey(encoderIdx, encoderDir)
    return withMember(builtEncoderRemapped, pos, realRemappedEncoders.has(pos))
  }, [builtEncoderRemapped, encoderIdx, encoderDir, realRemappedEncoders])

  return {
    previewLayer,
    keycodes,
    encoderKeycodes,
    remappedKeys,
    remappedEncoders,
    onKeyHover,
    onEncoderHover,
    onKeyHoverEnd: hide,
    cancel: hide,
  }
}
