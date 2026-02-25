// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useCallback } from 'react'
import type { Keycode } from '../../../shared/keycodes/keycodes'

interface Props {
  keycode: Keycode
  onClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onHover?: (keycode: Keycode, rect: DOMRect) => void
  onHoverEnd?: () => void
  highlighted?: boolean
  selected?: boolean
  sizeClass?: string
  displayLabel?: string
}

function KeycodeButtonInner({ keycode, onClick, onHover, onHoverEnd, highlighted, selected, sizeClass, displayLabel }: Props) {
  if (keycode.hidden) return null

  const label = displayLabel ?? keycode.label
  const lines = label.split('\n')

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onHover?.(keycode, e.currentTarget.getBoundingClientRect())
    },
    [keycode, onHover],
  )

  const size = sizeClass ?? 'w-[44px] h-[44px]'
  const hover = selected ? '' : 'hover:bg-picker-item-hover'
  const base = `flex flex-col items-center justify-center rounded border border-transparent p-1 text-xs outline-none ${hover} active:bg-accent/20 ${size} transition-colors`
  let variant: string
  if (selected) {
    variant = 'bg-accent/20 text-accent'
  } else if (highlighted) {
    variant = 'bg-accent/10 text-accent'
  } else if (displayLabel != null) {
    variant = 'bg-picker-item-bg text-key-label-remap'
  } else {
    variant = 'bg-picker-item-bg text-picker-item-text'
  }

  return (
    <button
      type="button"
      className={`${base} ${variant}`}
      onClick={(e) => onClick?.(keycode, e)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onHoverEnd}
    >
      {lines.map((line, i) => (
        <span key={i} className="leading-tight whitespace-nowrap text-[10px]">
          {line}
        </span>
      ))}
    </button>
  )
}

export const KeycodeButton = memo(KeycodeButtonInner)
