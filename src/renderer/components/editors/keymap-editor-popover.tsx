// SPDX-License-Identifier: GPL-2.0-or-later

// Bridges the keymap editor's popover state (`PopoverState` — key or
// encoder target) to the KeyPopover widget, resolving the current keycode
// for the clicked position and the mask-only editing flag.

import { KeyPopover } from '../keycodes/KeyPopover'
import { serialize, isMask } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { PopoverState } from './keymap-editor-types'

interface PopoverForStateProps {
  popoverState: NonNullable<PopoverState>
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  currentLayer: number
  layers: number
  onLayerChange?: (layer: number) => void
  layerNames?: string[]
  onKeycodeSelect: (kc: Keycode) => void
  onRawKeycodeSelect: (code: number) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
  quickSelect?: boolean
  previousKeycode?: number
  onUndo?: () => void
  nextKeycode?: number
  onRedo?: () => void
  remapLabel?: (qmkId: string) => string
}

export function PopoverForState({
  popoverState, keymap, encoderLayout, currentLayer, layers,
  onLayerChange, layerNames,
  onKeycodeSelect, onRawKeycodeSelect, onModMaskChange, onClose,
  quickSelect, previousKeycode, onUndo, nextKeycode, onRedo, remapLabel,
}: PopoverForStateProps) {
  const currentKeycode = popoverState.kind === 'key'
    ? keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
    : encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
  const maskOnly = popoverState.maskClicked && isMask(serialize(currentKeycode))
  return (
    <KeyPopover
      anchorRect={popoverState.anchorRect} currentKeycode={currentKeycode} maskOnly={maskOnly} layers={layers}
      currentLayer={currentLayer} onLayerChange={onLayerChange} layerNames={layerNames}
      onKeycodeSelect={onKeycodeSelect} onRawKeycodeSelect={onRawKeycodeSelect} onModMaskChange={onModMaskChange}
      onClose={onClose} quickSelect={quickSelect} previousKeycode={previousKeycode} onUndo={onUndo}
      nextKeycode={nextKeycode} onRedo={onRedo} remapLabel={remapLabel}
    />
  )
}
