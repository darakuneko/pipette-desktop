// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useId } from 'react'
import { keycodeLabel, isMask, findInnerKeycode } from '../../../shared/keycodes/keycodes'
import type { KleKey } from '../../../shared/kle/types'
import {
  KEY_UNIT,
  KEY_SPACING,
  KEY_BG_COLOR,
  KEY_BORDER_COLOR,
  KEY_SELECTED_COLOR,
  KEY_TEXT_COLOR,
  KEY_MASK_RECT_COLOR,
} from './constants'

interface Props {
  kleKey: KleKey
  keycode: string
  selected?: boolean
  selectedMaskPart?: boolean
  onClick?: (key: KleKey, direction: number, maskClicked: boolean) => void
  onDoubleClick?: (key: KleKey, direction: number, rect: DOMRect, maskClicked: boolean) => void
  scale?: number
}

function EncoderWidgetInner({
  kleKey,
  keycode,
  selected,
  selectedMaskPart,
  onClick,
  onDoubleClick,
  scale = 1,
}: Props) {
  const clipId = useId()
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale

  const x = s * kleKey.x
  const y = s * kleKey.y
  const w = s * kleKey.width - spacing
  const h = s * kleKey.height - spacing
  const r = Math.min(w, h) / 2
  const cx = x + w / 2
  const cy = y + h / 2

  const masked = isMask(keycode)
  const innerSelected = selected && selectedMaskPart && masked
  const fillColor = selected && !innerSelected ? KEY_SELECTED_COLOR : KEY_BG_COLOR
  const labelColor = selected && !innerSelected ? 'var(--content-inverse)' : KEY_TEXT_COLOR
  const fontSize = Math.max(8, Math.min(12, 12 * scale))
  const outerBorderActive = selected && !innerSelected

  // Rotation transform
  const hasRotation = kleKey.rotation !== 0
  const rotX = s * kleKey.rotationX
  const rotY = s * kleKey.rotationY
  const groupTransform = hasRotation
    ? `translate(${rotX}, ${rotY}) rotate(${kleKey.rotation}) translate(${-rotX}, ${-rotY})`
    : undefined

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) { e.stopPropagation(); onClick(kleKey, kleKey.encoderDir, false) }
  }

  const handleDoubleClick = (e: React.MouseEvent<SVGGElement>) => {
    if (onDoubleClick) { e.stopPropagation(); onDoubleClick(kleKey, kleKey.encoderDir, e.currentTarget.getBoundingClientRect(), false) }
  }

  if (!masked) {
    const labelLines = keycodeLabel(keycode).split('\n')
    return (
      <g transform={groupTransform} onClick={handleClick} onDoubleClick={handleDoubleClick} style={{ cursor: handleClick ? 'pointer' : 'default' }}>
        <circle cx={cx} cy={cy} r={r} fill={fillColor}
          stroke={outerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR} strokeWidth={outerBorderActive ? 2 : 1} />
        {labelLines.map((line, i) => (
          <text key={i} x={cx} y={cy + (i - (labelLines.length - 1) / 2) * (fontSize + 2)}
            textAnchor="middle" dominantBaseline="central" fill={labelColor} fontSize={fontSize} fontFamily="sans-serif">
            {line}
          </text>
        ))}
      </g>
    )
  }

  // --- Masked: split display with inner rect clipped to circle ---
  const outerLabel = keycodeLabel(keycode).split('\n')[0]
  const innerLabel = keycodeLabel(findInnerKeycode(keycode)?.qmkId ?? '').split('\n')[0]
  const innerBorderActive = !!innerSelected

  // Inner rect: bottom 50% of circle, fully inside the circle
  const innerRectW = r * 1.4
  const innerRectH = r * 0.7
  const innerRectX = cx - innerRectW / 2
  const innerRectY = cy + r * 0.05
  const innerCorner = r * 0.2

  const outerLabelY = cy - r * 0.35
  const innerLabelY = innerRectY + innerRectH / 2

  const handleInnerClick = (e: React.MouseEvent) => {
    if (onClick) { e.stopPropagation(); onClick(kleKey, kleKey.encoderDir, true) }
  }
  const handleInnerDoubleClick = (e: React.MouseEvent<SVGRectElement>) => {
    e.stopPropagation()
    if (onDoubleClick) {
      const g = e.currentTarget.closest('g')
      const rect = g ? g.getBoundingClientRect() : e.currentTarget.getBoundingClientRect()
      onDoubleClick(kleKey, kleKey.encoderDir, rect, true)
    }
  }

  return (
    <g transform={groupTransform} onClick={handleClick} onDoubleClick={handleDoubleClick} style={{ cursor: handleClick ? 'pointer' : 'default' }}>
      <defs>
        <clipPath id={clipId}>
          <circle cx={cx} cy={cy} r={r - 1} />
        </clipPath>
      </defs>
      {/* Outer circle */}
      <circle cx={cx} cy={cy} r={r} fill={fillColor}
        stroke={outerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR} strokeWidth={outerBorderActive ? 2 : 1} />
      {/* Inner rect clipped to circle — same style as KeyWidget (stroke-only selection) */}
      <rect x={innerRectX} y={innerRectY} width={innerRectW} height={innerRectH}
        rx={innerCorner} ry={innerCorner}
        fill={KEY_MASK_RECT_COLOR}
        stroke={innerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR} strokeWidth={innerBorderActive ? 2 : 1}
        clipPath={`url(#${clipId})`}
        onClick={handleInnerClick} onDoubleClick={handleInnerDoubleClick} style={{ cursor: handleClick ? 'pointer' : 'default' }} />
      {/* Outer label (modifier) */}
      <text x={cx} y={outerLabelY} textAnchor="middle" dominantBaseline="central"
        fill={labelColor} fontSize={fontSize * 0.85} fontFamily="sans-serif" style={{ pointerEvents: 'none' }}>
        {outerLabel}
      </text>
      {/* Inner label (basic key) */}
      <text x={cx} y={innerLabelY} textAnchor="middle" dominantBaseline="central"
        fill={KEY_TEXT_COLOR} fontSize={fontSize} fontFamily="sans-serif" style={{ pointerEvents: 'none' }}>
        {innerLabel}
      </text>
    </g>
  )
}

export const EncoderWidget = memo(EncoderWidgetInner)
