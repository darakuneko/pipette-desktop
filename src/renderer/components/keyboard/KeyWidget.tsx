// SPDX-License-Identifier: GPL-2.0-or-later

import { memo } from 'react'
import {
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../../shared/keycodes/keycodes'
import type { KleKey } from '../../../shared/kle/types'
import {
  KEY_UNIT,
  KEY_SPACING,
  KEY_ROUNDNESS,
  KEY_BG_COLOR,
  KEY_BORDER_COLOR,
  KEY_SELECTED_COLOR,
  KEY_MULTI_SELECTED_COLOR,
  KEY_PRESSED_COLOR,
  KEY_EVER_PRESSED_COLOR,
  KEY_HIGHLIGHT_COLOR,
  KEY_TEXT_COLOR,
  KEY_REMAP_COLOR,
  KEY_MASK_RECT_COLOR,
} from './constants'

interface Props {
  kleKey: KleKey
  keycode: string
  maskKeycode?: string
  selected?: boolean
  multiSelected?: boolean
  selectedMaskPart?: boolean
  pressed?: boolean
  highlighted?: boolean
  everPressed?: boolean
  remapped?: boolean
  onClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  scale?: number
}

function KeyWidgetInner({
  kleKey,
  keycode,
  maskKeycode,
  selected,
  multiSelected,
  selectedMaskPart,
  pressed,
  highlighted,
  everPressed,
  remapped,
  onClick,
  onDoubleClick,
  scale = 1,
}: Props) {
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale
  const corner = s * KEY_ROUNDNESS

  // Key rectangle (flat style matching picker buttons)
  const x = s * kleKey.x
  const y = s * kleKey.y
  const w = s * kleKey.width - spacing
  const h = s * kleKey.height - spacing

  // Key fill color (always use theme colors, ignore KLE color overrides)
  // Priority: pressed > selected > multiSelected > highlighted > everPressed > default
  // For masked keys with inner selected, use default fill (stroke-only selection)
  const masked = isMask(keycode)
  const innerSelected = selected && selectedMaskPart && masked
  let fillColor = KEY_BG_COLOR
  let invertText = false
  if (pressed) fillColor = KEY_PRESSED_COLOR
  else if (selected && !innerSelected) { fillColor = KEY_SELECTED_COLOR; invertText = true }
  else if (multiSelected) fillColor = KEY_MULTI_SELECTED_COLOR
  else if (highlighted) { fillColor = KEY_HIGHLIGHT_COLOR; invertText = true }
  else if (everPressed) fillColor = KEY_EVER_PRESSED_COLOR

  // Label text color: inverted when key is selected/highlighted, remap color
  // for remapped keys in non-mask mode, default otherwise
  let labelColor = KEY_TEXT_COLOR
  if (invertText) labelColor = 'var(--content-inverse)'
  else if (remapped) labelColor = KEY_REMAP_COLOR

  // Label
  const outerLabel = keycodeLabel(keycode)
  const innerLabel = maskKeycode
    ? keycodeLabel(maskKeycode)
    : masked
      ? keycodeLabel(findInnerKeycode(keycode)?.qmkId ?? '')
      : ''

  // Text rendering: split by \n for multi-line labels
  const labelLines = outerLabel.split('\n')
  const fontSize = Math.max(8, Math.min(12, 12 * scale))

  // Rotation transform
  const hasRotation = kleKey.rotation !== 0
  const rotX = s * kleKey.rotationX
  const rotY = s * kleKey.rotationY

  // Second rect (for stepped/ISO keys)
  const has2 =
    kleKey.width2 !== kleKey.width ||
    kleKey.height2 !== kleKey.height ||
    kleKey.x2 !== 0 ||
    kleKey.y2 !== 0
  const x2 = x + s * kleKey.x2
  const y2 = y + s * kleKey.y2
  const w2 = s * kleKey.width2 - spacing
  const h2 = s * kleKey.height2 - spacing

  // Inner rect geometry for masked keys (inset on all sides)
  const innerPad = 2 * scale
  const innerX = x + innerPad
  const innerY = y + h * 0.4 + innerPad
  const innerW = Math.max(0, w - innerPad * 2)
  const innerH = Math.max(0, h * 0.6 - innerPad * 2)
  const innerCorner = corner * 0.8

  // Border state: outer gets accent only when outer is selected,
  // inner rect gets accent only when inner is selected
  const outerBorderActive = selected && !innerSelected
  const innerBorderActive = !!innerSelected
  const isClickable = !kleKey.decal

  // Stroke color and width for outer key rects
  let outerStroke = KEY_BORDER_COLOR
  let outerStrokeWidth = 1
  if (outerBorderActive) {
    outerStroke = KEY_SELECTED_COLOR
    outerStrokeWidth = 2
  } else if (multiSelected) {
    outerStroke = KEY_MULTI_SELECTED_COLOR
    outerStrokeWidth = 2
  }

  const handleClick = (e: React.MouseEvent) => {
    if (onClick && isClickable) {
      e.stopPropagation()
      onClick(kleKey, false, { ctrlKey: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey })
    }
  }

  const handleInnerClick = (e: React.MouseEvent) => {
    if (onClick && isClickable) {
      e.stopPropagation()
      onClick(kleKey, true, { ctrlKey: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey })
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<SVGGElement>) => {
    if (onDoubleClick && isClickable) {
      onDoubleClick(kleKey, e.currentTarget.getBoundingClientRect(), false)
    }
  }

  const handleInnerDoubleClick = (e: React.MouseEvent<SVGRectElement>) => {
    e.stopPropagation()
    if (onDoubleClick && isClickable) {
      const g = e.currentTarget.closest('g')
      const rect = g ? g.getBoundingClientRect() : e.currentTarget.getBoundingClientRect()
      onDoubleClick(kleKey, rect, true)
    }
  }

  const groupTransform = hasRotation
    ? `translate(${rotX}, ${rotY}) rotate(${kleKey.rotation}) translate(${-rotX}, ${-rotY})`
    : undefined

  return (
    <g
      transform={groupTransform}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      style={{ cursor: isClickable ? 'pointer' : 'default' }}
    >
      {/* Key rect (flat style) */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={corner}
        ry={corner}
        fill={fillColor}
        stroke={outerStroke}
        strokeWidth={outerStrokeWidth}
      />
      {has2 && (
        <rect
          x={x2}
          y={y2}
          width={w2}
          height={h2}
          rx={corner}
          ry={corner}
          fill={fillColor}
          stroke={outerStroke}
          strokeWidth={outerStrokeWidth}
        />
      )}

      {/* Inner rect for masked keys */}
      {masked && innerW > 0 && innerH > 0 && (
        <rect
          data-testid="mask-inner-rect"
          x={innerX}
          y={innerY}
          width={innerW}
          height={innerH}
          rx={innerCorner}
          ry={innerCorner}
          fill={KEY_MASK_RECT_COLOR}
          stroke={innerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR}
          strokeWidth={innerBorderActive ? 2 : 1}
          onClick={handleInnerClick}
          onDoubleClick={handleInnerDoubleClick}
        />
      )}

      {/* Key label */}
      {masked ? (
        <>
          {/* Outer (modifier) label - top portion */}
          <text
            x={x + w / 2}
            y={y + h * 0.25}
            textAnchor="middle"
            dominantBaseline="central"
            fill={labelColor}
            fontSize={fontSize * 0.85}
            fontFamily="sans-serif"
            style={{ pointerEvents: 'none' }}
          >
            {keycodeLabel(findOuterKeycode(keycode)?.qmkId ?? keycode).replace(/\n?\(kc\)$/, '')}
          </text>
          {/* Inner (base) label - always use normal text color against inner rect bg */}
          <text
            x={x + w / 2}
            y={innerY + innerH / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fill={KEY_TEXT_COLOR}
            fontSize={fontSize * 0.85}
            fontFamily="sans-serif"
            style={{ pointerEvents: 'none' }}
          >
            {innerLabel}
          </text>
        </>
      ) : (
        labelLines.map((line, i) => (
          <text
            key={i}
            x={x + w / 2}
            y={y + (h / (labelLines.length + 1)) * (i + 1)}
            textAnchor="middle"
            dominantBaseline="central"
            fill={labelColor}
            fontSize={fontSize}
            fontFamily="sans-serif"
          >
            {line}
          </text>
        ))
      )}
    </g>
  )
}

export const KeyWidget = memo(KeyWidgetInner)
