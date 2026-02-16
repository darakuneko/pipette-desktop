// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, memo } from 'react'
import type { KleKey } from '../../../shared/kle/types'
import { KeyWidget } from './KeyWidget'
import { EncoderWidget } from './EncoderWidget'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING } from './constants'

interface Props {
  keys: KleKey[]
  keycodes: Map<string, string>
  maskKeycodes?: Map<string, string>
  encoderKeycodes?: Map<string, [string, string]>
  selectedKey?: { row: number; col: number } | null
  selectedEncoder?: { idx: number; dir: number } | null
  pressedKeys?: Set<string>
  highlightedKeys?: Set<string>
  everPressedKeys?: Set<string>
  remappedKeys?: Set<string>
  multiSelectedKeys?: Set<string>
  layoutOptions?: Map<number, number>
  selectedMaskPart?: boolean
  onKeyClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onKeyDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onEncoderClick?: (key: KleKey, direction: number) => void
  onEncoderDoubleClick?: (key: KleKey, direction: number, rect: DOMRect) => void
  readOnly?: boolean
  scale?: number
}

function KeyboardWidgetInner({
  keys,
  keycodes,
  maskKeycodes,
  encoderKeycodes,
  selectedKey,
  selectedEncoder,
  selectedMaskPart,
  pressedKeys,
  highlightedKeys,
  everPressedKeys,
  remappedKeys,
  multiSelectedKeys,
  layoutOptions,
  onKeyClick,
  onKeyDoubleClick,
  onEncoderClick,
  onEncoderDoubleClick,
  readOnly = false,
  scale = 1,
}: Props) {
  // Filter keys based on layout options
  const visibleKeys = useMemo(() => {
    if (!layoutOptions || layoutOptions.size === 0) return keys
    return keys.filter((key) => {
      if (key.layoutIndex < 0) return true
      const selectedOption = layoutOptions.get(key.layoutIndex)
      if (selectedOption === undefined) return key.layoutOption === 0
      return key.layoutOption === selectedOption
    })
  }, [keys, layoutOptions])

  // Calculate SVG bounds (track min to normalize position)
  const bounds = useMemo(() => {
    const pad2 = KEYBOARD_PADDING * 2
    if (visibleKeys.length === 0) {
      return { width: pad2, height: pad2, originX: -KEYBOARD_PADDING, originY: -KEYBOARD_PADDING }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const s = KEY_UNIT * scale
    const spacing = KEY_SPACING * scale
    for (const key of visibleKeys) {
      const kx0 = s * key.x
      const ky0 = s * key.y
      const kx1 = s * (key.x + key.width) - spacing
      const ky1 = s * (key.y + key.height) - spacing
      if (kx0 < minX) minX = kx0
      if (ky0 < minY) minY = ky0
      if (kx1 > maxX) maxX = kx1
      if (ky1 > maxY) maxY = ky1
    }
    return {
      width: maxX - minX + pad2,
      height: maxY - minY + pad2,
      originX: minX - KEYBOARD_PADDING,
      originY: minY - KEYBOARD_PADDING,
    }
  }, [visibleKeys, scale])

  return (
    <svg
      width={bounds.width}
      height={bounds.height}
      viewBox={`${bounds.originX} ${bounds.originY} ${bounds.width} ${bounds.height}`}
      className="select-none"
    >
      {visibleKeys.map((key, idx) => {
        const isEncoder = key.encoderIdx >= 0

        if (isEncoder) {
          const encKey = String(key.encoderIdx)
          const [cw, ccw] = encoderKeycodes?.get(encKey) ?? ['KC_NO', 'KC_NO']
          const keycode = key.encoderDir === 0 ? cw : ccw
          const isSelected =
            selectedEncoder?.idx === key.encoderIdx &&
            selectedEncoder?.dir === key.encoderDir
          return (
            <EncoderWidget
              key={`enc-${key.encoderIdx}-${key.encoderDir}-${idx}`}
              kleKey={key}
              keycode={keycode}
              selected={isSelected}
              onClick={readOnly ? undefined : onEncoderClick}
              onDoubleClick={readOnly ? undefined : onEncoderDoubleClick}
              scale={scale}
            />
          )
        }

        const posKey = `${key.row},${key.col}`
        const keycode = keycodes.get(posKey) ?? 'KC_NO'
        const maskKeycode = maskKeycodes?.get(posKey)
        const isSelected =
          selectedKey?.row === key.row && selectedKey?.col === key.col

        return (
          <KeyWidget
            key={`key-${key.row}-${key.col}-${idx}`}
            kleKey={key}
            keycode={keycode}
            maskKeycode={maskKeycode}
            selected={isSelected}
            multiSelected={multiSelectedKeys?.has(posKey)}
            selectedMaskPart={isSelected ? selectedMaskPart : undefined}
            pressed={pressedKeys?.has(posKey)}
            highlighted={highlightedKeys?.has(posKey)}
            everPressed={everPressedKeys?.has(posKey)}
            remapped={remappedKeys?.has(posKey)}
            onClick={readOnly ? undefined : onKeyClick}
            onDoubleClick={readOnly ? undefined : onKeyDoubleClick}
            scale={scale}
          />
        )
      })}
    </svg>
  )
}

export const KeyboardWidget = memo(KeyboardWidgetInner)
