// SPDX-License-Identifier: GPL-2.0-or-later
// Layout option bit packing/unpacking (VIA reversed bit order)

/** Parse layout labels into structured option definitions */
export interface LayoutOption {
  index: number
  labels: string[] // [label] for boolean, [label, opt0, opt1, ...] for select
}

export function parseLayoutLabels(
  labels: (string | string[])[] | undefined,
): LayoutOption[] {
  if (!labels) return []
  return labels.map((label, index) => {
    if (typeof label === 'string') {
      return { index, labels: [label] }
    }
    return { index, labels: label }
  })
}

/** Get the number of bits needed for a layout option */
export function optionBits(option: LayoutOption): number {
  // Boolean (single string label → labels = [name]): 1 bit
  if (option.labels.length <= 1) return 1
  // Array labels: [name, choice0, choice1, ...], numChoices = labels.length - 1
  const numChoices = option.labels.length - 1
  // Matches VIA/Python (numChoices - 1).bit_length()
  if (numChoices <= 1) return 0
  return 32 - Math.clz32(numChoices - 1)
}

/** Unpack layout options from a packed integer (VIA reversed bit order) */
export function unpackLayoutOptions(
  packed: number,
  options: LayoutOption[],
): Map<number, number> {
  const result = new Map<number, number>()
  // -1 is the sentinel for "not yet loaded"; treat as empty
  if (packed < 0) return result
  // VIA packs options in reverse order
  const reversed = [...options].reverse()
  let bitOffset = 0
  for (const opt of reversed) {
    const bits = optionBits(opt)
    const mask = (1 << bits) - 1
    const value = (packed >>> bitOffset) & mask
    result.set(opt.index, value)
    bitOffset += bits
  }
  return result
}

/** Pack layout options into an integer (VIA reversed bit order) */
export function packLayoutOptions(
  values: Map<number, number>,
  options: LayoutOption[],
): number {
  const reversed = [...options].reverse()
  let packed = 0
  let bitOffset = 0
  for (const opt of reversed) {
    const bits = optionBits(opt)
    const value = values.get(opt.index) ?? 0
    packed |= (value & ((1 << bits) - 1)) << bitOffset
    bitOffset += bits
  }
  return packed
}
