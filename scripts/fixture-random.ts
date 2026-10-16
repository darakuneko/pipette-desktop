// SPDX-License-Identifier: GPL-2.0-or-later
// Seeded pseudo-random numbers for the fixture generators under scripts/, so
// a generator writes the same fixture on every run.

/** Mulberry32: a fixed sequence of unsigned 32-bit integers for `seed`. */
export function random32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}
