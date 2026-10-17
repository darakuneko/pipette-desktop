// SPDX-License-Identifier: GPL-2.0-or-later
// Inputs of the Hub golden files that would be too large to write out:
// `{ "$repeat": s, "count": n }` stands for `s` repeated `n` times. The
// Rust tests of src-tauri/crates/pipette-hub expand them the same way
// before calling the code under test.

export interface Repeat {
  $repeat: string
  count: number
}

export function repeat(s: string, count: number): Repeat {
  return { $repeat: s, count }
}

function isRepeat(value: unknown): value is Repeat {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Repeat).$repeat === 'string' &&
    typeof (value as Repeat).count === 'number' &&
    Object.keys(value).length === 2
  )
}

/** `value` with every `{ $repeat, count }` replaced by its string. */
export function expand(value: unknown): unknown {
  if (isRepeat(value)) return value.$repeat.repeat(value.count)
  if (Array.isArray(value)) return value.map(expand)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]))
  }
  return value
}
