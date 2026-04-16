// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { serialize, keycodeTooltip, isMask } from '../../../shared/keycodes/keycodes'
import { KeyWidget } from '../keyboard/KeyWidget'
import type { KleKey } from '../../../shared/kle/types'
import { KEY_UNIT, KEY_SPACING, KEY_FACE_INSET } from '../keyboard/constants'

interface Props {
  value: number
  selected: boolean
  selectedMaskPart?: boolean
  onSelect: () => void
  onMaskPartClick?: (part: 'outer' | 'inner') => void
  onDoubleClick?: (rect: DOMRect) => void
  onDelete?: () => void
  noTooltip?: boolean
  disabled?: boolean
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

// Crop viewBox to tightly frame the visible key face
// Face rect starts at (INSET, INSET) with size (UNIT - SPACING - 2*INSET)
const FACE_ORIGIN = KEY_FACE_INSET
const FACE_SIZE = KEY_UNIT - KEY_SPACING - 2 * KEY_FACE_INSET
export const KEYCODE_FIELD_SIZE = Math.round(FACE_SIZE)

export function KeycodeField({ value, selected, selectedMaskPart, onSelect, onMaskPartClick, onDoubleClick, onDelete, noTooltip, disabled, label }: Props) {
  const { t } = useTranslation()
  const qmkId = serialize(value)
  const tooltip = noTooltip ? undefined : keycodeTooltip(qmkId)
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
      if (clickTimer.current) {
        clearTimeout(clickTimer.current)
        clickTimer.current = null
      }
      onDoubleClick?.(e.currentTarget.getBoundingClientRect())
    },
    [onDoubleClick],
  )

  const handleKeyWidgetClick = useCallback(
    (_key: KleKey, maskClicked: boolean) => {
      onMaskPartClick?.(maskClicked ? 'inner' : 'outer')
    },
    [onMaskPartClick],
  )

  const handleKeyWidgetDoubleClick = useCallback(
    (_key: KleKey, rect: DOMRect, _maskClicked: boolean) => {
      onDoubleClick?.(rect)
    },
    [onDoubleClick],
  )

  const keyButton = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={tooltip}
      data-testid="keycode-field"
      disabled={disabled}
      className={`flex shrink-0 rounded-sm ring-1 ${disabled ? 'cursor-default' : 'cursor-pointer'} ${selected ? 'ring-accent' : `ring-picker-item-border ${disabled ? '' : 'hover:ring-accent'}`}`}
      onClick={handleClick}
      onDoubleClick={isMasked ? undefined : handleDoubleClick}
    >
      <svg
        width={KEYCODE_FIELD_SIZE}
        height={KEYCODE_FIELD_SIZE}
        viewBox={`${FACE_ORIGIN} ${FACE_ORIGIN} ${FACE_SIZE} ${FACE_SIZE}`}
      >
        <KeyWidget
          kleKey={FIELD_KEY}
          keycode={qmkId}
          selected={selected}
          selectedMaskPart={selectedMaskPart}
          selectedFill={false}
          onClick={isMasked ? handleKeyWidgetClick : undefined}
          onDoubleClick={isMasked ? handleKeyWidgetDoubleClick : undefined}
          hoverMaskParts={isMasked}
        />
      </svg>
    </button>
  )

  if (!onDelete) return keyButton

  return (
    <div className="group relative">
      {keyButton}
      <button
        type="button"
        data-testid="keycode-delete"
        aria-label={t('editor.macro.deleteKeycode')}
        className="absolute -top-2 -right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
