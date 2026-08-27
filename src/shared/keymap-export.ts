// SPDX-License-Identifier: GPL-2.0-or-later
// Generate QMK-compatible keymap.c from current keymap state

import type { CustomKeycodeDefinition } from './keycodes/keycodes'

export interface KeymapExportInput {
  layers: number
  matrixRows: number
  matrixCols: number
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  serializeKeycode: (code: number) => string
  customKeycodes?: CustomKeycodeDefinition[]
}

function generateLayerMatrix(
  layer: number,
  matrixRows: number,
  matrixCols: number,
  keymap: Map<string, number>,
  serializeKeycode: (code: number) => string,
): string {
  const rowLines = Array.from({ length: matrixRows }, (_, r) => {
    const codes = Array.from({ length: matrixCols }, (_, c) =>
      serializeKeycode(keymap.get(`${layer},${r},${c}`) ?? 0),
    )
    return `        { ${codes.join(', ')} }`
  })

  return `    [${layer}] = {\n${rowLines.join(',\n')}\n    }`
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

function generateCustomKeycodeEnum(customKeycodes: CustomKeycodeDefinition[]): string | null {
  if (customKeycodes.length === 0) return null

  const entries = customKeycodes.map((c, i) => {
    const name = c.name ?? `USER${String(i).padStart(2, '0')}`
    return i === 0 ? `    ${name} = QK_KB_0,` : `    ${name},`
  })

  return [`enum custom_keycodes {`, ...entries, `};`].join('\n')
}

export function generateKeymapC(input: KeymapExportInput): string {
  const {
    layers,
    matrixRows,
    matrixCols,
    keymap,
    encoderLayout,
    encoderCount,
    serializeKeycode,
    customKeycodes,
  } = input

  if (!Number.isInteger(matrixRows) || !Number.isInteger(matrixCols) || matrixRows <= 0 || matrixCols <= 0) {
    throw new Error('matrix dimensions unavailable')
  }

  const layerBlocks = Array.from({ length: layers }, (_, l) =>
    generateLayerMatrix(l, matrixRows, matrixCols, keymap, serializeKeycode),
  )

  const sections = [
    `/* SPDX-License-Identifier: GPL-2.0-or-later */`,
    `#include QMK_KEYBOARD_H`,
    '',
  ]

  const enumBlock = customKeycodes ? generateCustomKeycodeEnum(customKeycodes) : null
  if (enumBlock) {
    sections.push(enumBlock, '')
  }

  sections.push(
    `/* Keymap is written in raw matrix order, keymaps[layer][row][col]; unwired`,
    ` * matrix positions are KC_NO. This is what the LAYOUT() macro expands to. */`,
    `const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {`,
    `${layerBlocks.join(',\n')},`,
    `};`,
  )

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
