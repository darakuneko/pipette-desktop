// SPDX-License-Identifier: GPL-2.0-or-later
// Decode VIA/Vial layout options from bit-packed u32

/**
 * Decode layout options from a bit-packed u32 into a Map<layoutIndex, selectedOption>.
 *
 * VIA packs layout options in reversed bit order: the last label uses the
 * lowest bits. Each label's choice count determines how many bits it occupies.
 */
export function decodeLayoutOptions(
  options: number,
  labels: (string | string[])[],
): Map<number, number> {
  const result = new Map<number, number>()
  if (options < 0) return result
  let bitPos = 0
  for (let idx = labels.length - 1; idx >= 0; idx--) {
    const label = labels[idx]
    // string = boolean (2 choices), string[] = [label, opt0, opt1, ...] so choices = length - 1
    const numChoices = typeof label === 'string' ? 2 : label.length - 1
    // Boolean: (2-1).bit_length() = 1. Select: (n-1).bit_length(). Matches Python.
    const numBits = numChoices <= 1 ? 0 : 32 - Math.clz32(numChoices - 1)
    const mask = (1 << numBits) - 1
    result.set(idx, (options >>> bitPos) & mask)
    bitPos += numBits
  }
  return result
}
