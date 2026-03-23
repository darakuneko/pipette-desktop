// SPDX-License-Identifier: GPL-2.0-or-later

import type { KleKey } from '../../../shared/kle/types'

export interface KeyWidgetProps {
  kleKey: KleKey
  keycode: string // keycode name for display label
  maskKeycode?: string // Inner keycode for masked keys
  selected?: boolean
  multiSelected?: boolean
  pressed?: boolean
  everPressed?: boolean
  onClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  scale?: number
}

export interface EncoderWidgetProps {
  kleKey: KleKey
  keycode: string
  selected?: boolean
  selectedMaskPart?: boolean
  onClick?: (key: KleKey, direction: number, maskClicked: boolean) => void
  onDoubleClick?: (key: KleKey, direction: number, rect: DOMRect, maskClicked: boolean) => void
  scale?: number
}

export interface KeyboardWidgetProps {
  keys: KleKey[]
  keycodes: Map<string, string> // "row,col" -> keycode name
  maskKeycodes?: Map<string, string> // "row,col" -> inner keycode name (for masked keys)
  encoderKeycodes?: Map<string, [string, string]> // "idx" -> [CW, CCW]
  selectedKey?: { row: number; col: number } | null
  selectedEncoder?: { idx: number; dir: 0 | 1 } | null
  pressedKeys?: Set<string> // "row,col"
  everPressedKeys?: Set<string> // "row,col"
  multiSelectedKeys?: Set<string> // "row,col"
  layoutOptions?: Map<number, number> // layoutIndex -> layoutOption
  onKeyClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onKeyDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onEncoderClick?: (key: KleKey, direction: number, maskClicked: boolean) => void
  onEncoderDoubleClick?: (key: KleKey, direction: number, rect: DOMRect, maskClicked: boolean) => void
  readOnly?: boolean
  scale?: number
}
