// SPDX-License-Identifier: GPL-2.0-or-later
// KLE (Keyboard Layout Editor) parser
// Ported from vial-gui kle_serial.py
// Based on https://github.com/ijprest/kle-serial

import type { KleKey, KeyboardLayout } from './types'

// Label alignment map: maps logical label positions to physical positions
// based on the alignment flags (a=0..7)
const labelMap: readonly (readonly number[])[] = [
  //  0   1   2   3   4   5   6   7   8   9  10  11    align flags
  [0, 6, 2, 8, 9, 11, 3, 5, 1, 4, 7, 10], // 0 = no centering
  [1, 7, -1, -1, 9, 11, 4, -1, -1, -1, -1, 10], // 1 = center x
  [3, -1, 5, -1, 9, 11, -1, -1, 4, -1, -1, 10], // 2 = center y
  [4, -1, -1, -1, 9, 11, -1, -1, -1, -1, -1, 10], // 3 = center x & y
  [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1], // 4 = center front (default)
  [1, 7, -1, -1, 10, -1, 4, -1, -1, -1, -1, -1], // 5 = center front & x
  [3, -1, 5, -1, 10, -1, -1, -1, 4, -1, -1, -1], // 6 = center front & y
  [4, -1, -1, -1, 10, -1, -1, -1, -1, -1, -1, -1], // 7 = center front & x & y
]

/** Reorder labels from input order into the canonical 12-position layout */
function reorderLabels<T>(labels: T[], align: number): (T | null)[] {
  const ret: (T | null)[] = new Array<T | null>(12).fill(null)
  const mapping = labelMap[align]
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== undefined && labels[i] !== null && labels[i] !== '') {
      const pos = mapping[i]
      if (pos >= 0) {
        ret[pos] = labels[i]
      }
    }
  }
  return ret
}

/** Properties that can appear in KLE JSON objects */
interface KleProperties {
  r?: number
  rx?: number
  ry?: number
  a?: number
  f?: number
  f2?: number
  fa?: number[]
  p?: string
  c?: string
  t?: string
  x?: number
  y?: number
  w?: number
  h?: number
  x2?: number
  y2?: number
  w2?: number
  h2?: number
  n?: boolean
  l?: boolean
  d?: boolean
  g?: boolean
  sm?: string
  sb?: string
  st?: string
}

/** Parse KLE JSON rows into a KeyboardLayout */
export function parseKle(rows: unknown[][]): KeyboardLayout {
  const keys: KleKey[] = []

  // Current key state (carried between keys, some properties reset after each key)
  let currentX = 0
  let currentY = 0
  let currentWidth = 1
  let currentHeight = 1
  let currentX2 = 0
  let currentY2 = 0
  let currentWidth2 = 0
  let currentHeight2 = 0
  let currentRotation = 0
  let currentRotationX = 0
  let currentRotationY = 0
  let currentColor = '#cccccc'
  let currentNub = false
  let currentStepped = false
  let currentDecal = false
  let currentGhost = false
  let currentTextColor: (string | null)[] = new Array<string | null>(12).fill(null)
  let currentTextSize: (number | null)[] = []

  // Cluster tracking for rotation
  let clusterX = 0
  let clusterY = 0

  // Alignment (default = 4 = center front)
  let align = 4

  // Default text properties
  let defaultTextColor = '#000000'
  let defaultTextSize = 3

  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue
    }

    for (let k = 0; k < row.length; k++) {
      const item = row[k]

      if (typeof item === 'string') {
        // String item = key label. Create a new key.
        const width2 = currentWidth2 === 0 ? currentWidth : currentWidth2
        const height2 = currentHeight2 === 0 ? currentHeight : currentHeight2

        const labels = reorderLabels(item.split('\n'), align)
        const textSize = reorderLabels(currentTextSize, align)

        // Clean up: null out text properties where there is no label
        const cleanTextColor: (string | null)[] = [...currentTextColor]
        const cleanTextSize: (number | null)[] = [...textSize]
        for (let i = 0; i < 12; i++) {
          if (labels[i] === null || labels[i] === undefined) {
            cleanTextSize[i] = null
            cleanTextColor[i] = null
          }
          if (cleanTextSize[i] === defaultTextSize) {
            cleanTextSize[i] = null
          }
          if (cleanTextColor[i] === defaultTextColor) {
            cleanTextColor[i] = null
          }
        }

        const newKey: KleKey = {
          x: currentX,
          y: currentY,
          width: currentWidth,
          height: currentHeight,
          x2: currentX2,
          y2: currentY2,
          width2,
          height2,
          rotation: currentRotation,
          rotationX: currentRotationX,
          rotationY: currentRotationY,
          color: currentColor,
          labels,
          textColor: cleanTextColor,
          textSize: cleanTextSize,
          row: 0,
          col: 0,
          encoderIdx: -1,
          encoderDir: -1,
          layoutIndex: -1,
          layoutOption: -1,
          decal: currentDecal,
          nub: currentNub,
          stepped: currentStepped,
          ghost: currentGhost,
        }

        // Parse key labels for row/col, encoder, and layout info
        parseKeyLabels(newKey)

        keys.push(newKey)

        // Advance x position and reset transient properties
        currentX += currentWidth
        currentWidth = 1
        currentHeight = 1
        currentX2 = 0
        currentY2 = 0
        currentWidth2 = 0
        currentHeight2 = 0
        currentNub = false
        currentStepped = false
        currentDecal = false
      } else if (typeof item === 'object' && item !== null) {
        const props = item as KleProperties

        // Rotation must be specified on the first key in a row
        if (k !== 0 && ('r' in props || 'rx' in props || 'ry' in props)) {
          throw new Error('Rotation can only be specified on the first key in a row')
        }

        if (props.r !== undefined) {
          currentRotation = props.r
        }
        if (props.rx !== undefined) {
          currentRotationX = props.rx
          clusterX = props.rx
          currentX = clusterX
          currentY = clusterY
        }
        if (props.ry !== undefined) {
          currentRotationY = props.ry
          clusterY = props.ry
          currentX = clusterX
          currentY = clusterY
        }
        if (props.a !== undefined) {
          align = props.a
        }
        if (props.f !== undefined) {
          defaultTextSize = props.f
          currentTextSize = []
        }
        if (props.f2 !== undefined) {
          for (let i = 1; i < 12; i++) {
            currentTextSize[i] = props.f2
          }
        }
        if (props.fa !== undefined) {
          currentTextSize = props.fa
        }
        if (props.c !== undefined) {
          currentColor = props.c
        }
        if (props.t !== undefined) {
          const split = props.t.split('\n')
          if (split[0] !== '') {
            defaultTextColor = split[0]
          }
          currentTextColor = reorderLabels(split, align) as (string | null)[]
        }
        if (props.x !== undefined) {
          currentX += props.x
        }
        if (props.y !== undefined) {
          currentY += props.y
        }
        if (props.w !== undefined) {
          currentWidth = props.w
          currentWidth2 = props.w
        }
        if (props.h !== undefined) {
          currentHeight = props.h
          currentHeight2 = props.h
        }
        if (props.x2 !== undefined) {
          currentX2 = props.x2
        }
        if (props.y2 !== undefined) {
          currentY2 = props.y2
        }
        if (props.w2 !== undefined) {
          currentWidth2 = props.w2
        }
        if (props.h2 !== undefined) {
          currentHeight2 = props.h2
        }
        if (props.n !== undefined) {
          currentNub = props.n
        }
        if (props.l !== undefined) {
          currentStepped = props.l
        }
        if (props.d !== undefined) {
          currentDecal = props.d
        }
        if (props.g !== undefined && props.g) {
          currentGhost = props.g
        }
      }
    }

    // End of row: advance y, reset x to rotation origin
    currentY += 1
    currentX = currentRotationX
  }

  return { keys }
}

/** Extract row/col, encoder info, and layout options from key labels */
function parseKeyLabels(key: KleKey): void {
  // labels[4] = "e" indicates an encoder key (Vial convention)
  if (key.labels[4] === 'e') {
    // Encoder: labels[0] = "encoderIdx,direction"
    if (key.labels[0] && key.labels[0].includes(',')) {
      const parts = key.labels[0].split(',')
      key.encoderIdx = parseInt(parts[0], 10)
      key.encoderDir = parseInt(parts[1], 10)
    }
  } else if (key.decal || (key.labels[0] && key.labels[0].includes(','))) {
    // Normal key: labels[0] = "row,col"
    if (key.labels[0] && key.labels[0].includes(',')) {
      const parts = key.labels[0].split(',')
      key.row = parseInt(parts[0], 10)
      key.col = parseInt(parts[1], 10)
    }
  }

  // labels[8] = "layoutIndex,layoutOption" (bottom-right corner)
  if (key.labels[8] && key.labels[8].includes(',')) {
    const parts = key.labels[8].split(',')
    key.layoutIndex = parseInt(parts[0], 10)
    key.layoutOption = parseInt(parts[1], 10)
  }
}
