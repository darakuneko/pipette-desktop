// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useCallback } from 'react'
import { serialize, keycodeTooltip, isMask } from '../../../shared/keycodes/keycodes'
import { KeyWidget } from '../keyboard/KeyWidget'
import type { KleKey } from '../../../shared/kle/types'
import { KEY_UNIT } from '../keyboard/constants'

interface Props {
  value: number
  selected: boolean
  selectedMaskPart?: boolean
  onSelect: () => void
  onMaskPartClick?: (part: 'outer' | 'inner') => void
  onDoubleClick?: (rect: DOMRect) => void
  label?: string
}

const DOUBLE_CLICK_DELAY = 250

const FIELD_KEY: KleKey = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  x2: 0,
  y2: 0,
  width2: 1,
  height2: 1,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  color: '',
  labels: Array(12).fill(null) as (string | null)[],
  textColor: Array(12).fill(null) as (string | null)[],
  textSize: Array(12).fill(null) as (number | null)[],
  row: 0,
  col: 0,
  encoderIdx: -1,
  encoderDir: -1,
  layoutIndex: -1,
  layoutOption: -1,
  decal: false,
  nub: false,
  stepped: false,
  ghost: false,
}

const SVG_SIZE = KEY_UNIT

export function KeycodeField({ value, selected, selectedMaskPart, onSelect, onMaskPartClick, onDoubleClick, label }: Props) {
  const qmkId = serialize(value)
  const tooltip = keycodeTooltip(qmkId)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMasked = onMaskPartClick != null && isMask(qmkId)

  const handleClick = useCallback(() => {
    if (isMasked) return // handled by KeyWidget onClick
    if (onDoubleClick) {
      if (clickTimer.current) clearTimeout(clickTimer.current)
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        onSelect()
      }, DOUBLE_CLICK_DELAY)
    } else {
      onSelect()
    }
  }, [onSelect, onDoubleClick, isMasked])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isMasked) return
      if (clickTimer.current) {
        clearTimeout(clickTimer.current)
        clickTimer.current = null
      }
      onDoubleClick?.(e.currentTarget.getBoundingClientRect())
    },
    [onDoubleClick, isMasked],
  )

  const handleKeyWidgetClick = useCallback(
    (_key: KleKey, maskClicked: boolean) => {
      onMaskPartClick?.(maskClicked ? 'inner' : 'outer')
    },
    [onMaskPartClick],
  )

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={tooltip}
      data-testid="keycode-field"
      className="shrink-0"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <svg
        width={SVG_SIZE}
        height={SVG_SIZE}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      >
        <KeyWidget
          kleKey={FIELD_KEY}
          keycode={qmkId}
          selected={selected}
          selectedMaskPart={selectedMaskPart}
          selectedFill={false}
          onClick={isMasked ? handleKeyWidgetClick : undefined}
          hoverMaskParts={isMasked}
        />
      </svg>
    </button>
  )
}
