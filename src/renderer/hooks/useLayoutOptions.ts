// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { KEYBOARD_LAYOUTS } from '../data/keyboard-layouts'
import type { KeyLabelMeta } from '../../shared/types/key-label-store'

export function useLayoutOptions(metas: KeyLabelMeta[]): { id: string; name: string }[] {
  return useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const meta of metas) {
      if (seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push({ id: meta.id, name: meta.name })
    }
    for (const def of KEYBOARD_LAYOUTS) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      out.push({ id: def.id, name: def.name })
    }
    return out
  }, [metas])
}
