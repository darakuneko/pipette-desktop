// SPDX-License-Identifier: GPL-2.0-or-later

/** Resizes `buffer` to exactly `size` bytes: zero-padded when shorter,
 *  truncated when longer. A truncated result always has its final byte
 *  forced to 0 — the firmware's macro playback reads the buffer until it
 *  hits a NUL terminator, so cutting a buffer down must still leave one in
 *  place even if the byte at that position wasn't a terminator. */
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
