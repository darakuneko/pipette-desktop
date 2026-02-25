// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { parseKle } from '../../../shared/kle/kle-parser'
import { findKeycode, type Keycode } from '../../../shared/keycodes/keycodes'
import type { SplitKeyMode } from '../../../shared/types/app-config'
import { KeycodeButton } from './KeycodeButton'
import { getRemapDisplayLabel, getSplitRemapProps } from './KeycodeGrid'
import { SplitKey, getShiftedKeycode } from './SplitKey'

/** Grid multiplier: 1u = 4 grid cells (same as vial-gui QGridLayout) */
const GRID_SCALE = 4

interface SteppedKeyInfo {
  left: number
  top: number
  width: number
  height: number
  clipPath: string
}

/** Detect a stepped key and return its bounding box + clip-path, or undefined for normal keys */
function computeSteppedKeyInfo(
  w: number, h: number,
  x2: number, y2: number, w2: number, h2: number,
): SteppedKeyInfo | undefined {
  if (x2 === 0 && y2 === 0 && w2 === w && h2 === h) return undefined

  const left = Math.min(0, x2)
  const top = Math.min(0, y2)
  const bboxW = Math.max(w, x2 + w2) - left
  const bboxH = Math.max(h, y2 + h2) - top

  // Primary and secondary rects as percentages of bounding box
  const px = -left / bboxW * 100
  const prx = (-left + w) / bboxW * 100
  const pby = (-top + h) / bboxH * 100
  const sx = (x2 - left) / bboxW * 100
  const srx = (x2 - left + w2) / bboxW * 100
  const sby = (y2 - top + h2) / bboxH * 100

  // L-shape polygon vertices (percentages of bounding box)
  const pts: [number, number][] = [
    [sx, 0], [srx, 0], [prx, pby], [px, pby], [px, sby], [sx, sby],
  ]

  const p = (v: number) => `${v.toFixed(1)}%`
  const clipPath = `polygon(${pts.map(([x, y]) => `${p(x)} ${p(y)}`).join(', ')})`

  return { left, top, width: bboxW, height: bboxH, clipPath }
}

interface Props {
  kle: unknown[][]
  onKeycodeClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onKeycodeHover?: (keycode: Keycode, rect: DOMRect) => void
  onKeycodeHoverEnd?: () => void
  highlightedKeycodes?: Set<string>
  pickerSelectedKeycodes?: Set<string>
  splitKeyMode?: SplitKeyMode
  remapLabel?: (qmkId: string) => string
}

interface GridKey {
  keycode: Keycode
  shiftedKeycode: Keycode | null
  gridRow: number
  gridCol: number
  gridRowSpan: number
  gridColSpan: number
  clipPath?: string
}

export function DisplayKeyboard({
  kle,
  onKeycodeClick,
  onKeycodeHover,
  onKeycodeHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
  splitKeyMode,
  remapLabel,
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

      const stepped = computeSteppedKeyInfo(
        key.width, key.height, key.x2, key.y2, key.width2, key.height2,
      )

      // For stepped keys, use the bounding box; for normal keys, use key dimensions directly
      const originX = key.x + (stepped?.left ?? 0)
      const originY = key.y + (stepped?.top ?? 0)
      const spanW = stepped?.width ?? key.width
      const spanH = stepped?.height ?? key.height
      const col = Math.round(originX * GRID_SCALE)
      const row = Math.round(originY * GRID_SCALE)
      const colSpan = Math.round(spanW * GRID_SCALE)
      const rowSpan = Math.round(spanH * GRID_SCALE)

      const shiftedKc = splitKeyMode !== 'flat' ? getShiftedKeycode(kc.qmkId) : null

      keys.push({
        keycode: kc,
        shiftedKeycode: shiftedKc,
        gridRow: row + 1, // CSS grid is 1-indexed
        gridCol: col + 1,
        gridRowSpan: rowSpan,
        gridColSpan: colSpan,
        clipPath: stepped?.clipPath,
      })

      maxCol = Math.max(maxCol, col + colSpan)
      maxRow = Math.max(maxRow, row + rowSpan)
    }

    return { gridKeys: keys, totalCols: maxCol, totalRows: maxRow }
  }, [kle, splitKeyMode])

  return (
    <div
      className="inline-grid gap-1"
      style={{
        gridTemplateColumns: `repeat(${totalCols}, 8px)`,
        gridTemplateRows: `repeat(${totalRows}, 8px)`,
      }}
    >
      {gridKeys.map((gk) => {
        const isSelected = pickerSelectedKeycodes?.has(gk.keycode.qmkId)
        const isHighlighted = highlightedKeycodes?.has(gk.keycode.qmkId)

        const buttonContent = gk.shiftedKeycode ? (
          <SplitKey
            base={gk.keycode}
            shifted={gk.shiftedKeycode}
            onClick={onKeycodeClick}
            onHover={onKeycodeHover}
            onHoverEnd={onKeycodeHoverEnd}
            highlightedKeycodes={highlightedKeycodes}
            pickerSelectedKeycodes={pickerSelectedKeycodes}
            {...getSplitRemapProps(gk.keycode.qmkId, remapLabel)}
          />
        ) : (
          <KeycodeButton
            keycode={gk.keycode}
            onClick={onKeycodeClick}
            onHover={onKeycodeHover}
            onHoverEnd={onKeycodeHoverEnd}
            highlighted={isHighlighted}
            selected={isSelected}
            sizeClass="w-full h-full"
            displayLabel={getRemapDisplayLabel(gk.keycode.qmkId, remapLabel)}
          />
        )

        return (
          <div
            key={gk.keycode.qmkId}
            style={{
              gridRow: `${gk.gridRow} / span ${gk.gridRowSpan}`,
              gridColumn: `${gk.gridCol} / span ${gk.gridColSpan}`,
            }}
          >
            {gk.clipPath ? (
              <div className="h-full w-full" style={{ clipPath: gk.clipPath }}>
                {buttonContent}
              </div>
            ) : (
              buttonContent
            )}
          </div>
        )
      })}
    </div>
  )
}
