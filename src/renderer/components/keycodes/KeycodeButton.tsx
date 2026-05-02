// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useCallback } from 'react'
import type { Keycode } from '../../../shared/keycodes/keycodes'

interface Props {
  keycode: Keycode
  onClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onDoubleClick?: (keycode: Keycode) => void
  onHover?: (keycode: Keycode, rect: DOMRect) => void
  onHoverEnd?: () => void
  highlighted?: boolean
  selected?: boolean
  sizeClass?: string
  displayLabel?: string
}

function KeycodeButtonInner({ keycode, onClick, onDoubleClick, onHover, onHoverEnd, highlighted, selected, sizeClass, displayLabel }: Props) {
  if (keycode.hidden) return null

  const label = displayLabel ?? keycode.label
  // Match KeyWidget's slice(0, 4) — anything past the 4th `\n` part
  // has no slot in the 2 × 2 quadrant layout, so dropping early keeps
  // the picker and the main keymap visually identical.
  const lines = label.split('\n').slice(0, 4)
  const useQuadrant = lines.length === 4

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onHover?.(keycode, e.currentTarget.getBoundingClientRect())
    },
    [keycode, onHover],
  )

  const size = sizeClass ?? 'w-[44px] h-[44px]'
  const hover = selected ? '' : 'hover:bg-picker-item-hover'
  // Switch to a 2 × 2 grid for 4-part labels so the picker matches
  // KeyWidget. 1/2/3 parts keep the existing flex-col stack.
  const layout = useQuadrant
    ? 'grid grid-cols-2 grid-rows-2 place-items-center'
    : 'flex flex-col items-center justify-center'
  const base = `${layout} rounded border border-transparent p-1 text-xs outline-none cursor-pointer ${hover} active:bg-accent/20 ${size} transition-colors`
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
      onDoubleClick={() => onDoubleClick?.(keycode)}
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
