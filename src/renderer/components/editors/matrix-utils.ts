// SPDX-License-Identifier: GPL-2.0-or-later

export const POLL_INTERVAL = 20 // ms -- same as Python reference

export function parseMatrixState(data: number[], rows: number, cols: number): Set<string> {
  const pressed = new Set<string>()
  const rowSize = Math.ceil(cols / 8)

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const byteIndex = row * rowSize + (rowSize - 1 - Math.floor(col / 8))
      const bitIndex = col % 8
      if (byteIndex < data.length && (data[byteIndex] >> bitIndex) & 1) {
        pressed.add(`${row},${col}`)
      }
    }
  }
  return pressed
}
