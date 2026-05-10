// SPDX-License-Identifier: GPL-2.0-or-later
//
// Helpers for registering / unregistering i18n language packs as
// i18next resource bundles. The reserved meta fields (`name`,
// `version`) are stripped before the bundle is handed
// to i18next so they can never be reached via `t('name')`. The
// matching set of registered ids is cached so disabled / deleted
// packs can be removed without scanning every i18next language.

import i18n from './index'
import { stripMetaKeys } from '../../shared/i18n/coverage'
import type { I18nPackMeta } from '../../shared/types/i18n-store'

const registered = new Set<string>()

export function packResourceBundleId(packId: string): string {
  return `pack:${packId}`
}

/** Reconcile the i18next resource bundles with the canonical set of
 * enabled packs from the store. Returns the set of currently-loaded
 * pack ids so callers can react (e.g. trigger coverage recomputes for
 * newly-added packs). */
export async function syncBundlesWithStore(): Promise<Set<string>> {
  const result = await window.vialAPI.i18nPackList()
  const metas: I18nPackMeta[] = result.success && result.data ? result.data : []

  const desired = new Set<string>()
  for (const meta of metas) {
    if (meta.deletedAt || !meta.enabled) continue
    desired.add(packResourceBundleId(meta.id))
  }

  // Add new bundles. We always overwrite (`overwrite=true,
  // deep=true`) so a re-import without a packId reuse picks up the
  // refreshed translations on the next changeLanguage. The fetches
  // are independent IPCs so we run them in parallel.
  const enabledMetas = metas.filter((meta) => !meta.deletedAt && meta.enabled)
  await Promise.all(enabledMetas.map(async (meta) => {
    const internalId = packResourceBundleId(meta.id)
    try {
      const get = await window.vialAPI.i18nPackGet(meta.id)
      if (!get.success || !get.data) return
      const translations = stripMetaKeys(get.data.pack)
      i18n.addResourceBundle(internalId, 'translation', translations, true, true)
      registered.add(internalId)
    } catch {
      // Skip — the next sync attempt will retry.
    }
  }))

  // Remove bundles that are no longer enabled. Note: we cannot rely
  // on `i18n.languages` because i18next only tracks the currently
  // active language plus its fallback chain. The local `registered`
  // set is the source of truth for what we've installed.
  for (const id of [...registered]) {
    if (!desired.has(id)) {
      i18n.removeResourceBundle(id, 'translation')
      registered.delete(id)
    }
  }

  return new Set(registered)
}

/** Convenience: fetch a single pack and (re)register it without
 * reconciling the rest of the set. Used by Hub Download / Import
 * Apply paths so the new pack is immediately available before the
 * full reconcile. */
export async function registerOnePack(packId: string): Promise<void> {
  try {
    const get = await window.vialAPI.i18nPackGet(packId)
    if (!get.success || !get.data) return
    const internalId = packResourceBundleId(packId)
    const translations = stripMetaKeys(get.data.pack)
    i18n.addResourceBundle(internalId, 'translation', translations, true, true)
    registered.add(internalId)
  } catch {
    // Caller will see the missing pack on next sync.
  }
}

export function unregisterOnePack(packId: string): void {
  const internalId = packResourceBundleId(packId)
  i18n.removeResourceBundle(internalId, 'translation')
  registered.delete(internalId)
}
