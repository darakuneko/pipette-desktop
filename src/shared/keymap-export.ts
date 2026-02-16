// SPDX-License-Identifier: GPL-2.0-or-later
// Generate QMK-compatible keymap.c from current keymap state

import type { KleKey } from './kle/types'
import { filterVisibleKeys } from './kle/filter-keys'

export interface KeymapExportInput {
  layers: number
  keys: KleKey[]
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  layoutOptions: Map<number, number>
  serializeKeycode: (code: number) => string
}

function groupKeysByRow(keys: KleKey[]): KleKey[][] {
  if (keys.length === 0) return []

  const sorted = [...keys].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })

  const rows: KleKey[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const rowStart = rows[rows.length - 1][0]
    const curr = sorted[i]
    if (Math.abs(curr.y - rowStart.y) > 0.3) {
      rows.push([curr])
    } else {
      rows[rows.length - 1].push(curr)
    }
  }

  return rows
}

function generateLayerLayout(
  layer: number,
  normalKeys: KleKey[],
  keymap: Map<string, number>,
  serializeKeycode: (code: number) => string,
): string {
  const rows = groupKeysByRow(normalKeys)
  const lines: string[] = []

  for (let r = 0; r < rows.length; r++) {
    const codes = rows[r].map((key) => {
      const code = keymap.get(`${layer},${key.row},${key.col}`) ?? 0
      return serializeKeycode(code)
    })
    const suffix = r < rows.length - 1 ? ',' : ''
    lines.push(`        ${codes.join(', ')}${suffix}`)
  }

  return `    [${layer}] = LAYOUT(\n${lines.join('\n')}\n    )`
}

function generateEncoderLayer(
  layer: number,
  encoderCount: number,
  encoderLayout: Map<string, number>,
  serializeKeycode: (code: number) => string,
): string {
  const entries: string[] = []
  for (let i = 0; i < encoderCount; i++) {
    // encoderLayout stores: dir 0=CW, dir 1=CCW
    const cw = encoderLayout.get(`${layer},${i},0`) ?? 0
    const ccw = encoderLayout.get(`${layer},${i},1`) ?? 0
    entries.push(`ENCODER_CCW_CW(${serializeKeycode(ccw)}, ${serializeKeycode(cw)})`)
  }
  return `    [${layer}] = { ${entries.join(', ')} }`
}

export function generateKeymapC(input: KeymapExportInput): string {
  const {
    layers,
    keys,
    keymap,
    encoderLayout,
    encoderCount,
    layoutOptions,
    serializeKeycode,
  } = input

  const visibleKeys = filterVisibleKeys(keys, layoutOptions)
  const normalKeys = visibleKeys.filter((k) => k.encoderIdx === -1)

  const layerBlocks = Array.from({ length: layers }, (_, l) =>
    generateLayerLayout(l, normalKeys, keymap, serializeKeycode),
  )

  const sections = [
    `/* SPDX-License-Identifier: GPL-2.0-or-later */`,
    `#include QMK_KEYBOARD_H`,
    '',
    `const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {`,
    `${layerBlocks.join(',\n')},`,
    `};`,
  ]

  if (encoderCount > 0) {
    const encoderBlocks = Array.from({ length: layers }, (_, l) =>
      generateEncoderLayer(l, encoderCount, encoderLayout, serializeKeycode),
    )
    sections.push(
      '',
      `const uint16_t PROGMEM encoder_map[][NUM_ENCODERS][NUM_DIRECTIONS] = {`,
      `${encoderBlocks.join(',\n')},`,
      `};`,
    )
  }

  return sections.join('\n') + '\n'
}
