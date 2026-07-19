// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { SUPPORTED_LANGUAGES } from '../i18n'
import { BUILTIN_ENGLISH_PACK_ID, type I18nPackMeta } from '../../shared/types/i18n-store'

/**
 * Built-in English is materialised as a real i18n-pack-store entry by
 * `ensureBuiltinEnglishEntry` (main), so iterating `metas` first
 * preserves the user-controlled drag order from the Language Packs
 * modal — mirrors `useLayoutOptions`'s QWERTY precedent. `SUPPORTED_
 * LANGUAGES` only serves as a safety net for the brief window before
 * `metas` has loaded.
 */
export function useLanguageOptions(metas: I18nPackMeta[]): { id: string; name: string }[] {
  return useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const meta of metas) {
      if (meta.deletedAt || !meta.enabled) continue
      const id = meta.id === BUILTIN_ENGLISH_PACK_ID ? 'builtin:en' : `pack:${meta.id}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, name: meta.name })
    }
    for (const l of SUPPORTED_LANGUAGES) {
      if (seen.has(l.id)) continue
      seen.add(l.id)
      out.push({ id: l.id, name: l.name })
    }
    return out
  }, [metas])
}
