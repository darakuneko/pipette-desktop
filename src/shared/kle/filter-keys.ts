// SPDX-License-Identifier: GPL-2.0-or-later
// Shared utility to filter visible keys based on layout options

import type { KleKey } from './types'

export function filterVisibleKeys(
  keys: KleKey[],
  layoutOptions: Map<number, number>,
): KleKey[] {
  return keys.filter((key) => {
    if (key.decal) return false
    if (key.layoutIndex < 0) return true
    // Match KeyboardWidget: skip layout filtering when no options are set
    if (layoutOptions.size === 0) return true
    const selectedOption = layoutOptions.get(key.layoutIndex)
    if (selectedOption === undefined) return key.layoutOption === 0
    return key.layoutOption === selectedOption
  })
}
