// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { parseKle } from '../../../shared/kle/kle-parser'
import { findKeycode, type Keycode } from '../../../shared/keycodes/keycodes'
import { KeycodeButton } from './KeycodeButton'

/** Grid multiplier: 1u = 4 grid cells (same as vial-gui QGridLayout) */
const GRID_SCALE = 4

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
  gridRow: number
  gridCol: number
  gridRowSpan: number
  gridColSpan: number
}

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

      keys.push({
        keycode: kc,
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
      className="inline-grid gap-px"
      style={{
        gridTemplateColumns: `repeat(${totalCols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${totalRows}, 11px)`,
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
          <KeycodeButton
            keycode={gk.keycode}
            onClick={onKeycodeClick}
            onHover={onKeycodeHover}
            onHoverEnd={onKeycodeHoverEnd}
            highlighted={highlightedKeycodes?.has(gk.keycode.qmkId)}
            selected={pickerSelectedKeycodes?.has(gk.keycode.qmkId)}
            sizeClass="w-full h-full"
          />
        </div>
      ))}
    </div>
  )
}
