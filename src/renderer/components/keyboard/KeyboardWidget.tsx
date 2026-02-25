// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, memo } from 'react'
import type { KleKey } from '../../../shared/kle/types'
import { repositionLayoutKeys } from '../../../shared/kle/filter-keys'
import { KeyWidget } from './KeyWidget'
import { EncoderWidget } from './EncoderWidget'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING } from './constants'

/** Rotate point (px, py) by `angle` degrees around center (cx, cy). */
export function rotatePoint(
  px: number,
  py: number,
  angle: number,
  cx: number,
  cy: number,
): [number, number] {
  const rad = (angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

/** Compute bounding-box corners of a key (both rects), accounting for rotation. */
function keyCorners(
  key: KleKey,
  s: number,
  spacing: number,
): [number, number][] {
  const x0 = s * key.x
  const y0 = s * key.y
  const x1 = s * (key.x + key.width) - spacing
  const y1 = s * (key.y + key.height) - spacing
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  // Include secondary rect corners for stepped/ISO keys
  const has2 =
    key.width2 !== key.width ||
    key.height2 !== key.height ||
    key.x2 !== 0 ||
    key.y2 !== 0
  if (has2) {
    const sx0 = x0 + s * key.x2
    const sy0 = y0 + s * key.y2
    const sx1 = s * (key.x + key.x2 + key.width2) - spacing
    const sy1 = s * (key.y + key.y2 + key.height2) - spacing
    corners.push([sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1])
  }
  if (key.rotation === 0) return corners
  const cx = s * key.rotationX
  const cy = s * key.rotationY
  return corners.map(([px, py]) => rotatePoint(px, py, key.rotation, cx, cy))
}

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
  // Reposition selected layout alternatives to align with option 0, then filter
  const visibleKeys = useMemo(() => {
    if (!layoutOptions || layoutOptions.size === 0) return keys
    const repositioned = repositionLayoutKeys(keys, layoutOptions)
    return repositioned.filter((key) => {
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
      for (const [cx, cy] of keyCorners(key, s, spacing)) {
        if (cx < minX) minX = cx
        if (cy < minY) minY = cy
        if (cx > maxX) maxX = cx
        if (cy > maxY) maxY = cy
      }
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
      {/* Render non-selected keys first, then selected key on top so its
          stroke is never hidden by adjacent keys painted later in DOM order */}
      {visibleKeys.map((key, idx) => {
        const isEncoder = key.encoderIdx >= 0
        const isSelected = isEncoder
          ? selectedEncoder?.idx === key.encoderIdx && selectedEncoder?.dir === key.encoderDir
          : selectedKey?.row === key.row && selectedKey?.col === key.col
        if (isSelected) return null

        if (isEncoder) {
          const encKey = String(key.encoderIdx)
          const [cw, ccw] = encoderKeycodes?.get(encKey) ?? ['KC_NO', 'KC_NO']
          return (
            <EncoderWidget
              key={`enc-${key.encoderIdx}-${key.encoderDir}-${idx}`}
              kleKey={key}
              keycode={key.encoderDir === 0 ? cw : ccw}
              selected={false}
              onClick={readOnly ? undefined : onEncoderClick}
              onDoubleClick={readOnly ? undefined : onEncoderDoubleClick}
              scale={scale}
            />
          )
        }

        const posKey = `${key.row},${key.col}`
        return (
          <KeyWidget
            key={`key-${key.row}-${key.col}-${idx}`}
            kleKey={key}
            keycode={keycodes.get(posKey) ?? 'KC_NO'}
            maskKeycode={maskKeycodes?.get(posKey)}
            selected={false}
            multiSelected={multiSelectedKeys?.has(posKey)}
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
      {/* Selected key rendered last for top z-order */}
      {visibleKeys.map((key, idx) => {
        const isEncoder = key.encoderIdx >= 0
        const isSelected = isEncoder
          ? selectedEncoder?.idx === key.encoderIdx && selectedEncoder?.dir === key.encoderDir
          : selectedKey?.row === key.row && selectedKey?.col === key.col
        if (!isSelected) return null

        if (isEncoder) {
          const encKey = String(key.encoderIdx)
          const [cw, ccw] = encoderKeycodes?.get(encKey) ?? ['KC_NO', 'KC_NO']
          return (
            <EncoderWidget
              key={`enc-${key.encoderIdx}-${key.encoderDir}-${idx}`}
              kleKey={key}
              keycode={key.encoderDir === 0 ? cw : ccw}
              selected
              onClick={readOnly ? undefined : onEncoderClick}
              onDoubleClick={readOnly ? undefined : onEncoderDoubleClick}
              scale={scale}
            />
          )
        }

        const posKey = `${key.row},${key.col}`
        return (
          <KeyWidget
            key={`key-${key.row}-${key.col}-${idx}`}
            kleKey={key}
            keycode={keycodes.get(posKey) ?? 'KC_NO'}
            maskKeycode={maskKeycodes?.get(posKey)}
            selected
            multiSelected={multiSelectedKeys?.has(posKey)}
            selectedMaskPart={selectedMaskPart}
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
