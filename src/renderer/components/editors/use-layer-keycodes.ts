// SPDX-License-Identifier: GPL-2.0-or-later

// Builds the per-layer keycode/remapped-key maps the keymap editor renders
// (current layer, typing-test's effective layer, and — via the returned
// builder callbacks — the layout picker's browsed layer), plus the
// deserialized macro buffer and the set of "configured" TD/Macro tiles to
// highlight in the keycode palette.

import { useCallback, useMemo } from 'react'
import { serialize, isMask } from '../../../shared/keycodes/keycodes'
import { posKey } from '../../../shared/kle/pos-key'
import { deserializeAllMacros, type MacroAction } from '../../../preload/macro'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { EMPTY_KEYCODES, EMPTY_REMAPPED, EMPTY_ENCODER_KEYCODES } from './keymap-editor-types'

export interface UseLayerKeycodesOptions {
  parsedMacros?: MacroAction[][] | null
  macroBuffer?: number[]
  macroCount?: number
  vialProtocol?: number
  tapDanceEntries?: TapDanceEntry[]
  remapLabel?: (qmkId: string) => string
  isRemapped?: (qmkId: string) => boolean
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  currentLayer: number
  typingTestMode?: boolean
  typingTestEffectiveLayer: number
}

export interface LayerKeycodes {
  keycodes: Map<string, string>
  remapped: Set<string>
}

export interface UseLayerKeycodesReturn {
  deserializedMacros?: MacroAction[][]
  /** Keycodes of currently-configured Tap Dance / Macro tiles (e.g.
   *  `"TD(0)"`, `"M2"`), used to highlight them in the keycode palette. */
  configuredKeycodes?: Set<string>
  buildKeycodesForLayer: (layer: number) => LayerKeycodes
  buildEncoderKeycodesForLayer: (layer: number) => Map<string, [string, string]>
  layerKeycodes: Map<string, string>
  remappedKeys: Set<string>
  layerEncoderKeycodes: Map<string, [string, string]>
  typingTestKeycodes: Map<string, string>
  typingTestRemapped: Set<string>
  typingTestEncoderKeycodes: Map<string, [string, string]>
}

export function useLayerKeycodes({
  parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
  remapLabel, isRemapped, keymap, encoderLayout, encoderCount, currentLayer,
  typingTestMode, typingTestEffectiveLayer,
}: UseLayerKeycodesOptions): UseLayerKeycodesReturn {
  // --- Macros ---
  const deserializedMacros = useMemo(
    () => parsedMacros ?? (macroBuffer && macroCount ? deserializeAllMacros(macroBuffer, vialProtocol ?? 0, macroCount) : undefined),
    [parsedMacros, macroBuffer, macroCount, vialProtocol],
  )

  const configuredKeycodes = useMemo(() => {
    const set = new Set<string>()
    if (tapDanceEntries) {
      for (let i = 0; i < tapDanceEntries.length; i++) {
        const e = tapDanceEntries[i]
        if (e.onTap || e.onHold || e.onDoubleTap || e.onTapHold) set.add(`TD(${i})`)
      }
    }
    if (deserializedMacros) {
      for (let i = 0; i < deserializedMacros.length; i++) {
        if (deserializedMacros[i].length > 0) set.add(`M${i}`)
      }
    }
    return set.size > 0 ? set : undefined
  }, [tapDanceEntries, deserializedMacros])

  const remap = remapLabel ?? ((id: string) => id)

  // --- Build keycodes for layers ---
  const buildKeycodesForLayer = useCallback((layer: number) => {
    const keycodes = new Map<string, string>()
    const remapped = new Set<string>()
    const checkRemapped = isRemapped ?? (() => false)
    for (const [key, code] of keymap) {
      const [l, r, c] = key.split(',')
      if (Number(l) === layer) {
        const pos = posKey(Number(r), Number(c))
        const qmkId = serialize(code)
        keycodes.set(pos, remap(qmkId))
        if (!isMask(qmkId) && checkRemapped(qmkId)) remapped.add(pos)
      }
    }
    return { keycodes, remapped }
  }, [keymap, remap, isRemapped])

  const buildEncoderKeycodesForLayer = useCallback((layer: number) => {
    const map = new Map<string, [string, string]>()
    for (let i = 0; i < encoderCount; i++) {
      const cw = encoderLayout.get(`${layer},${i},0`) ?? 0
      const ccw = encoderLayout.get(`${layer},${i},1`) ?? 0
      map.set(String(i), [remap(serialize(cw)), remap(serialize(ccw))])
    }
    return map
  }, [encoderLayout, encoderCount, remap])

  const { keycodes: layerKeycodes, remapped: remappedKeys } = useMemo(() => buildKeycodesForLayer(currentLayer), [buildKeycodesForLayer, currentLayer])
  const layerEncoderKeycodes = useMemo(() => buildEncoderKeycodesForLayer(currentLayer), [buildEncoderKeycodesForLayer, currentLayer])

  const { keycodes: typingTestKeycodes, remapped: typingTestRemapped } = useMemo(
    () => typingTestMode ? buildKeycodesForLayer(typingTestEffectiveLayer) : { keycodes: EMPTY_KEYCODES, remapped: EMPTY_REMAPPED },
    [buildKeycodesForLayer, typingTestEffectiveLayer, typingTestMode])
  const typingTestEncoderKeycodes = useMemo(
    () => typingTestMode ? buildEncoderKeycodesForLayer(typingTestEffectiveLayer) : EMPTY_ENCODER_KEYCODES,
    [buildEncoderKeycodesForLayer, typingTestEffectiveLayer, typingTestMode])

  return {
    deserializedMacros, configuredKeycodes,
    buildKeycodesForLayer, buildEncoderKeycodesForLayer,
    layerKeycodes, remappedKeys, layerEncoderKeycodes,
    typingTestKeycodes, typingTestRemapped, typingTestEncoderKeycodes,
  }
}
