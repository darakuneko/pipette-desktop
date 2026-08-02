// SPDX-License-Identifier: GPL-2.0-or-later
//
// Background recheck for installed language packs whose stored
// `matchedBaseVersion` predates the current English baseline
// (`BASE_REVISION` bump). Split out of LanguagePacksModal
// (Task-split-pack-modals) — this effect only reads `store.metas` and
// re-applies coverage-complete packs, so it does not touch any other
// modal state.

import { useEffect } from 'react'
import { computeCoverage } from '../../../shared/i18n/coverage'
import { BASE_REVISION, ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import { BUILTIN_ENGLISH_PACK_ID } from '../../../shared/types/i18n-store'
import type { UseI18nPackStoreReturn } from '../../hooks/useI18nPackStore'

export interface UseLanguagePackCoverageOptions {
  open: boolean
  store: UseI18nPackStoreReturn
}

export function useLanguagePackCoverage({ open, store }: UseLanguagePackCoverageOptions): void {
  useEffect(() => {
    if (!open) return
    // Built-in English is excluded: it never carries a `matchedBaseVersion`
    // (that field only ever gets stamped on an *imported* pack whose
    // coverage was measured against the baseline), so it would
    // otherwise always show up "stale" here and cost a wasted
    // i18nPackGet + coverage compute every time the modal opens, for a
    // recheck that can never actually apply to it.
    const stale = store.metas.filter((m) => !m.deletedAt && m.id !== BUILTIN_ENGLISH_PACK_ID && m.matchedBaseVersion !== BASE_REVISION)
    if (stale.length === 0) return
    let cancelled = false
    void (async () => {
      for (const meta of stale) {
        if (cancelled) return
        try {
          const get = await window.vialAPI.i18nPackGet(meta.id)
          if (cancelled || !get.success || !get.data) continue
          const cov = computeCoverage(get.data.pack, ENGLISH_PACK_BODY)
          if (cancelled || cov.coverageRatio !== 1) continue
          await store.applyImport(get.data.pack, {
            id: meta.id,
            matchedBaseVersion: BASE_REVISION,
            coverage: { totalKeys: cov.totalKeys, coveredKeys: cov.coveredKeys },
          })
        } catch {
          continue
        }
      }
      if (!cancelled) await store.refresh()
    })()
    return () => { cancelled = true }
  }, [open, store.metas.length])
}
