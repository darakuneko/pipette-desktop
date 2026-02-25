// SPDX-License-Identifier: GPL-2.0-or-later

import { memo } from 'react'
import { findKeycode, type Keycode } from '../../../shared/keycodes/keycodes'

/** Map base keycodes to their shifted keycode counterparts */
const SHIFTED_MAP: Record<string, string> = {
  KC_GRAVE: 'KC_TILD',
  KC_1: 'KC_EXLM',
  KC_2: 'KC_AT',
  KC_3: 'KC_HASH',
  KC_4: 'KC_DLR',
  KC_5: 'KC_PERC',
  KC_6: 'KC_CIRC',
  KC_7: 'KC_AMPR',
  KC_8: 'KC_ASTR',
  KC_9: 'KC_LPRN',
  KC_0: 'KC_RPRN',
  KC_MINUS: 'KC_UNDS',
  KC_EQUAL: 'KC_PLUS',
  KC_LBRACKET: 'KC_LCBR',
  KC_RBRACKET: 'KC_RCBR',
  KC_BSLASH: 'KC_PIPE',
  KC_SCOLON: 'KC_COLN',
  KC_QUOTE: 'KC_DQUO',
  KC_COMMA: 'KC_LT',
  KC_DOT: 'KC_GT',
  KC_SLASH: 'KC_QUES',
}

/** Look up the shifted counterpart of a base keycode, if any */
export function getShiftedKeycode(qmkId: string): Keycode | null {
  const shiftedId = SHIFTED_MAP[qmkId]
  return shiftedId ? findKeycode(shiftedId) ?? null : null
}

export interface SplitKeyProps {
  base: Keycode
  shifted: Keycode
  onClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onHover?: (keycode: Keycode, rect: DOMRect) => void
  onHoverEnd?: () => void
  highlightedKeycodes?: Set<string>
  pickerSelectedKeycodes?: Set<string>
}

function splitTextColor(highlighted?: boolean, selected?: boolean): string {
  if (selected || highlighted) return 'text-accent'
  return 'text-picker-item-text'
}

const SPLIT_HALF_BASE = 'flex-1 cursor-pointer flex items-center justify-center text-[10px] leading-tight whitespace-nowrap transition-colors hover:bg-picker-item-hover'

function SplitKeyInner({
  base,
  shifted,
  onClick,
  onHover,
  onHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
}: SplitKeyProps) {
  const baseHighlighted = highlightedKeycodes?.has(base.qmkId)
  const baseSelected = pickerSelectedKeycodes?.has(base.qmkId)
  const shiftHighlighted = highlightedKeycodes?.has(shifted.qmkId)
  const shiftSelected = pickerSelectedKeycodes?.has(shifted.qmkId)

  let outerVariant: string
  if (baseSelected || shiftSelected) {
    outerVariant = 'border-accent bg-accent/20 ring-1 ring-accent'
  } else if (baseHighlighted || shiftHighlighted) {
    outerVariant = 'border-accent/50 bg-accent/10'
  } else {
    outerVariant = 'border-picker-item-border bg-picker-item-bg'
  }

  const baseLabel = base.label.includes('\n') ? base.label.split('\n')[1] : base.label

  return (
    <div className={`flex h-full w-full flex-col rounded border ${outerVariant}`}>
      <button
        type="button"
        className={`${SPLIT_HALF_BASE} rounded-t ${splitTextColor(shiftHighlighted, shiftSelected)}`}
        onClick={(e) => onClick?.(shifted, e)}
        onMouseEnter={(e) => onHover?.(shifted, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={onHoverEnd}
      >
        {shifted.label}
      </button>
      <button
        type="button"
        className={`${SPLIT_HALF_BASE} rounded-b ${splitTextColor(baseHighlighted, baseSelected)}`}
        onClick={(e) => onClick?.(base, e)}
        onMouseEnter={(e) => onHover?.(base, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={onHoverEnd}
      >
        {baseLabel}
      </button>
    </div>
  )
}

export const SplitKey = memo(SplitKeyInner)
