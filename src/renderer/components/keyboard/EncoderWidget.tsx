// SPDX-License-Identifier: GPL-2.0-or-later

import { memo } from 'react'
import { keycodeLabel } from '../../../shared/keycodes/keycodes'
import type { KleKey } from '../../../shared/kle/types'
import {
  KEY_UNIT,
  KEY_SPACING,
  KEY_BG_COLOR,
  KEY_BORDER_COLOR,
  KEY_SELECTED_COLOR,
  KEY_TEXT_COLOR,
} from './constants'

interface Props {
  kleKey: KleKey
  keycode: string
  selected?: boolean
  onClick?: (key: KleKey, direction: number) => void
  onDoubleClick?: (key: KleKey, direction: number, rect: DOMRect) => void
  scale?: number
}

function EncoderWidgetInner({
  kleKey,
  keycode,
  selected,
  onClick,
  onDoubleClick,
  scale = 1,
}: Props) {
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale

  const x = s * kleKey.x
  const y = s * kleKey.y
  const w = s * kleKey.width - spacing
  const h = s * kleKey.height - spacing
  const r = Math.min(w, h) / 2
  const cx = x + w / 2
  const cy = y + h / 2

  const fillColor = selected ? KEY_SELECTED_COLOR : KEY_BG_COLOR
  const labelColor = selected ? 'var(--content-inverse)' : KEY_TEXT_COLOR
  const fontSize = Math.max(8, Math.min(12, 12 * scale))
  const label = keycodeLabel(keycode)
  const labelLines = label.split('\n')

  // Rotation transform
  const hasRotation = kleKey.rotation !== 0
  const rotX = s * kleKey.rotationX
  const rotY = s * kleKey.rotationY
  const groupTransform = hasRotation
    ? `translate(${rotX}, ${rotY}) rotate(${kleKey.rotation}) translate(${-rotX}, ${-rotY})`
    : undefined

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.stopPropagation()
      onClick(kleKey, kleKey.encoderDir)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<SVGGElement>) => {
    if (onDoubleClick) {
      e.stopPropagation()
      onDoubleClick(kleKey, kleKey.encoderDir, e.currentTarget.getBoundingClientRect())
    }
  }

  return (
    <g transform={groupTransform} onClick={handleClick} onDoubleClick={handleDoubleClick} style={{ cursor: 'pointer' }}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={fillColor}
        stroke={selected ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR}
        strokeWidth={selected ? 2 : 1}
      />
      {labelLines.map((line, i) => (
        <text
          key={i}
          x={cx}
          y={cy + (i - (labelLines.length - 1) / 2) * (fontSize + 2)}
          textAnchor="middle"
          dominantBaseline="central"
          fill={labelColor}
          fontSize={fontSize}
          fontFamily="sans-serif"
        >
          {line}
        </text>
      ))}
    </g>
  )
}

export const EncoderWidget = memo(EncoderWidgetInner)
