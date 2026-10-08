// SPDX-License-Identifier: GPL-2.0-or-later

/** Structural equality for JSON-shaped values (settings fields and the
 *  state built from them). */
export function isSameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
