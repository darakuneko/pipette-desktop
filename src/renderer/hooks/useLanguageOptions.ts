// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { SUPPORTED_LANGUAGES } from '../i18n'
import type { I18nPackMeta } from '../../shared/types/i18n-store'

export function useLanguageOptions(metas: I18nPackMeta[]): { id: string; name: string }[] {
  return useMemo(() => {
    const opts: { id: string; name: string }[] = SUPPORTED_LANGUAGES.map((l) => ({ id: l.id, name: l.name }))
    for (const meta of metas) {
      if (meta.deletedAt || !meta.enabled) continue
      opts.push({ id: `pack:${meta.id}`, name: meta.name })
    }
    return opts
  }, [metas])
}
