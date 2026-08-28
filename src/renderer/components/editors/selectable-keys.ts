// SPDX-License-Identifier: GPL-2.0-or-later

// Shared filter for the "keymap-selectable" key domain: real matrix keys a
// user can click/select/paste onto. Both sides of a Layout Picker
// multi-select count indices over this same ordered list.

import type { KleKey } from '../../../shared/kle/types'

/**
 * Keeps non-encoder, non-decal keys and only the selected variant of each
 * layout-option group; when a `layoutIndex` has no entry in `layoutOptions`,
 * its option 0 variant is kept. Unlike `filterVisibleKeys`
 * (`shared/kle/filter-keys.ts`), encoders are excluded and an empty
 * `layoutOptions` map still applies the option-0 default, so the renderer
 * can show alternate keys that sit outside this domain.
 */
export function filterSelectableKeys(keys: KleKey[], layoutOptions: Map<number, number>): KleKey[] {
  return keys.filter((key) => {
    if (key.encoderIdx >= 0 || key.decal) return false
    if (key.layoutIndex >= 0) {
      const sel = layoutOptions.get(key.layoutIndex)
      return sel === undefined ? key.layoutOption === 0 : key.layoutOption === sel
    }
    return true
  })
}
