// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useCallback } from 'react'
import { serialize, keycodeLabel, keycodeTooltip } from '../../../shared/keycodes/keycodes'

interface Props {
  value: number
  selected: boolean
  onSelect: () => void
  onDoubleClick?: (rect: DOMRect) => void
  label?: string
}

const DOUBLE_CLICK_DELAY = 250

export function KeycodeField({ value, selected, onSelect, onDoubleClick, label }: Props) {
  const qmkId = serialize(value)
  const display = keycodeLabel(qmkId)
  const tooltip = keycodeTooltip(qmkId)
  const lines = display.split('\n')
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleClick = useCallback(() => {
    if (onDoubleClick) {
      if (clickTimer.current) clearTimeout(clickTimer.current)
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        onSelect()
      }, DOUBLE_CLICK_DELAY)
    } else {
      onSelect()
    }
  }, [onSelect, onDoubleClick])

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

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={tooltip}
      data-testid="keycode-field"
      className={`flex flex-col items-center justify-center w-[44px] h-[44px] rounded border p-1 text-xs overflow-hidden transition-colors ${
        selected
          ? 'border-accent bg-accent/10 ring-2 ring-accent/30 text-accent'
          : 'border-picker-item-border bg-picker-item-bg text-picker-item-text hover:bg-picker-item-hover hover:border-accent'
      }`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {lines.map((line, i) => (
        <span key={i} className="leading-tight whitespace-nowrap text-[10px]">
          {line}
        </span>
      ))}
    </button>
  )
}
