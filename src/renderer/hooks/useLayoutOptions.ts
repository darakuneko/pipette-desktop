// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { KEYBOARD_LAYOUTS, BUILTIN_QWERTY_LAYOUT_ID } from '../data/keyboard-layouts'
import type { KeyLabelMeta } from '../../shared/types/key-label-store'

/**
 * Resolves the display name for a Key Label entry, overriding the
 * built-in QWERTY id's stored name with the shared, localized
 * `keyLabels.qwertyDefaultName` string ("QWERTY (Default)").
 *
 * The stored name ("QWERTY") is written once by the main process's
 * `ensureQwertyEntry` (`src/main/key-label-store.ts`) — no i18n
 * available there, so it can never carry a localized suffix on disk.
 * This is a plain function (not part of the `useLayoutOptions` hook) so
 * every surface that lists Key Label entries by id/name — the "pick a
 * layout" dropdowns this hook feeds (footer Keyboard Layout select,
 * Settings → Defaults) AND the Key Labels Manage modal's Installed list
 * (`KeyLabelsModal.tsx`, which reads `metas` directly rather than
 * through this hook) — can call the exact same override instead of each
 * re-deriving its own conditional and risking drift.
 */
export function resolveLayoutDisplayName(id: string, storedName: string, t: TFunction): string {
  return id === BUILTIN_QWERTY_LAYOUT_ID ? t('keyLabels.qwertyDefaultName') : storedName
}

export function useLayoutOptions(metas: KeyLabelMeta[]): { id: string; name: string }[] {
  const { t } = useTranslation()
  return useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const meta of metas) {
      if (seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push({ id: meta.id, name: resolveLayoutDisplayName(meta.id, meta.name, t) })
    }
    for (const def of KEYBOARD_LAYOUTS) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      out.push({ id: def.id, name: resolveLayoutDisplayName(def.id, def.name, t) })
    }
    return out
  }, [metas, t])
}
