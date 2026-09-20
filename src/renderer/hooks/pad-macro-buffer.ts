// SPDX-License-Identifier: GPL-2.0-or-later

/** Resizes `buffer` to exactly `size` bytes: zero-padded when shorter,
 *  truncated when longer. A truncated result always ends in a 0 byte —
 *  firmware macro playback reads the buffer until it hits a NUL terminator,
 *  so a cut-down buffer must still carry one. */
export function padMacroBuffer(buffer: number[], size: number): number[] {
  if (buffer.length <= size) {
    const padded = buffer.slice()
    while (padded.length < size) padded.push(0)
    return padded
  }
  const truncated = buffer.slice(0, size)
  if (size > 0) truncated[size - 1] = 0
  return truncated
}
