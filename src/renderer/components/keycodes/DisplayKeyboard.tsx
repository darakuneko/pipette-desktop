// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useMemo } from 'react'
import { parseKle } from '../../../shared/kle/kle-parser'
import { findKeycode, type Keycode } from '../../../shared/keycodes/keycodes'
import { KeycodeButton } from './KeycodeButton'

/** Grid multiplier: 1u = 4 grid cells (same as vial-gui QGridLayout) */
const GRID_SCALE = 4

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

interface Props {
  kle: unknown[][]
  onKeycodeClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onKeycodeHover?: (keycode: Keycode, rect: DOMRect) => void
  onKeycodeHoverEnd?: () => void
  highlightedKeycodes?: Set<string>
  pickerSelectedKeycodes?: Set<string>
}

interface GridKey {
  keycode: Keycode
  shiftedKeycode: Keycode | null
  gridRow: number
  gridCol: number
  gridRowSpan: number
  gridColSpan: number
}

interface SplitKeyProps {
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

const SplitKey = memo(SplitKeyInner)

export function DisplayKeyboard({
  kle,
  onKeycodeClick,
  onKeycodeHover,
  onKeycodeHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
}: Props) {
  const { gridKeys, totalCols, totalRows } = useMemo(() => {
    const layout = parseKle(kle)
    const keys: GridKey[] = []
    let maxCol = 0
    let maxRow = 0

    for (const key of layout.keys) {
      const qmkId = key.labels[0]
      if (!qmkId) continue
      const kc = findKeycode(qmkId)
      if (!kc) continue

      const col = Math.round(key.x * GRID_SCALE)
      const row = Math.round(key.y * GRID_SCALE)
      const colSpan = Math.round(key.width * GRID_SCALE)
      const rowSpan = Math.round(key.height * GRID_SCALE)

      const shiftedQmkId = SHIFTED_MAP[kc.qmkId]
      const shiftedKc = shiftedQmkId ? findKeycode(shiftedQmkId) ?? null : null

      keys.push({
        keycode: kc,
        shiftedKeycode: shiftedKc,
        gridRow: row + 1, // CSS grid is 1-indexed
        gridCol: col + 1,
        gridRowSpan: rowSpan,
        gridColSpan: colSpan,
      })

      maxCol = Math.max(maxCol, col + colSpan)
      maxRow = Math.max(maxRow, row + rowSpan)
    }

    return { gridKeys: keys, totalCols: maxCol, totalRows: maxRow }
  }, [kle])

  return (
    <div
      className="inline-grid gap-1"
      style={{
        gridTemplateColumns: `repeat(${totalCols}, 8px)`,
        gridTemplateRows: `repeat(${totalRows}, 8px)`,
      }}
    >
      {gridKeys.map((gk) => (
        <div
          key={gk.keycode.qmkId}
          style={{
            gridRow: `${gk.gridRow} / span ${gk.gridRowSpan}`,
            gridColumn: `${gk.gridCol} / span ${gk.gridColSpan}`,
          }}
        >
          {gk.shiftedKeycode ? (
            <SplitKey
              base={gk.keycode}
              shifted={gk.shiftedKeycode}
              onClick={onKeycodeClick}
              onHover={onKeycodeHover}
              onHoverEnd={onKeycodeHoverEnd}
              highlightedKeycodes={highlightedKeycodes}
              pickerSelectedKeycodes={pickerSelectedKeycodes}
            />
          ) : (
            <KeycodeButton
              keycode={gk.keycode}
              onClick={onKeycodeClick}
              onHover={onKeycodeHover}
              onHoverEnd={onKeycodeHoverEnd}
              highlighted={highlightedKeycodes?.has(gk.keycode.qmkId)}
              selected={pickerSelectedKeycodes?.has(gk.keycode.qmkId)}
              sizeClass="w-full h-full"
            />
          )}
        </div>
      ))}
    </div>
  )
}
