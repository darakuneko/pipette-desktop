// SPDX-License-Identifier: GPL-2.0-or-later
// Values with the parts JSON cannot carry, for fixtures whose Rust side
// rebuilds the same JavaScript value: NaN, ±Infinity and -0 become
// `{ "$n": "NaN" | "Infinity" | "-Infinity" | "-0" }`, and an undefined
// property or array element becomes `{ "$u": true }`. The Rust tests of
// src-tauri/crates/pipette-typing-analytics read them back (tests/common).

export function tagged(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $n: 'NaN' }
    if (value === Infinity) return { $n: 'Infinity' }
    if (value === -Infinity) return { $n: '-Infinity' }
    if (Object.is(value, -0)) return { $n: '-0' }
    return value
  }
  if (value === undefined) return { $u: true }
  if (Array.isArray(value)) return value.map(tagged)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tagged(v)]))
  }
  return value
}
