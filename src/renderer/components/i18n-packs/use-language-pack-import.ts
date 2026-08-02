// SPDX-License-Identifier: GPL-2.0-or-later
//
// Import surface for Language Packs: inline rename commit (auto-sync on
// a Hub-linked pack), single-item + multi-file import (validate →
// coverage → persist → placement → Hub auto-sync), the explicit cloud
// pull, and Hub-download-to-import. Split out of LanguagePacksModal
// (Task-split-pack-modals) — rename lives here rather than in the
// actions hook because it needs `useImportBatch`'s own `isImportingRef`
// re-entrancy guard, which only exists once this hook creates it.

import { useCallback, useEffect } from 'react'
import type { TFunction } from 'i18next'
import { validatePack, type ValidatePackResult } from '../../../shared/i18n/validate'
import { computeCoverage } from '../../../shared/i18n/coverage'
import { BASE_REVISION, ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'
import { usePackCloudPull } from '../pack-modal/usePackCloudPull'
import { useImportBatch, type CollectedImportBatch, type ImportBatchItem } from '../pack-modal/useImportBatch'
import { basenameOf, type ImportBatchFailure } from '../pack-modal/import-batch-summary'
import { fetchHubPackMeta } from '../pack-modal/fetch-hub-pack-meta'
import type { UseImportPlacementResult } from '../pack-modal/useImportPlacement'
import type { InlineRename } from '../../hooks/useInlineRename'
import type { UseI18nPackStoreReturn } from '../../hooks/useI18nPackStore'
import type { PackActionResult } from '../pack-modal/pack-modal-types'

const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0'

export interface UseLanguagePackImportOptions {
  open: boolean
  store: UseI18nPackStoreReturn
  t: TFunction
  rename: InlineRename<string>
  placement: UseImportPlacementResult
  pushPackToHub: (packId: string, hubPostId: string) => Promise<{ success: boolean; error?: string }>
  handleSelectLanguage: (internalId: string) => void
  setPendingId: (id: string | null) => void
  setActionError: (error: string | null) => void
  setLastResult: (result: PackActionResult | PackActionResult[] | null) => void
}

export function useLanguagePackImport({
  open,
  store,
  t,
  rename,
  placement,
  pushPackToHub,
  handleSelectLanguage,
  setPendingId,
  setActionError,
  setLastResult,
}: UseLanguagePackImportOptions) {
  const handleRenameCommit = useCallback(async (id: string): Promise<void> => {
    // Guards on `useImportBatch`'s own re-entrancy ref (destructured as
    // `isImportingRef` below) rather than a locally-mirrored ref — a
    // ref written only inside an event handler (`runImport`), never
    // during render, so it can't go stale under a discarded/interrupted
    // concurrent render the way `someRef.current = someState` could.
    // Referencing `isImportingRef` here, even though it is destructured
    // further down in this file, is safe: this callback's body only
    // runs later, in response to a real blur/Enter event, by which time
    // the whole render (including that destructure) has long finished.
    //
    // A rename already committed its `store.rename` call the instant
    // the underlying input blurred — including the blur a click on the
    // Import button itself triggers, which fires before that click's
    // own handler runs — so this check cannot intercept that exact
    // call. It DOES catch every other path: a rename input left open
    // when a batch was already running, and any stray commit that
    // slips through after the cancel-on-import-start effect below has
    // already reset the editor for this render.
    if (isImportingRef.current) return
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.rename(id, newName)
      if (!result.success) {
        setActionError(result.error ?? t('i18n.errorGeneric'))
        return
      }
      // Auto-sync uploaded packs so the Hub post reflects the new
      // name immediately. Show "Synced" so the user sees the second
      // step completed; failure surfaces inline without rolling back.
      if (result.meta?.hubPostId) {
        const upd = await pushPackToHub(id, result.meta.hubPostId)
        if (upd.success) {
          setLastResult({ id, kind: 'success', message: t('common.synced') })
        } else {
          setActionError(upd.error ?? t('hub.updateFailed'))
        }
      }
    } finally {
      setPendingId(null)
    }
  }, [rename, store, t, pushPackToHub])

  const handleRenameKey = (event: React.KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleRenameCommit(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      rename.cancelRename()
    }
  }

  // Core validate + coverage + persist step, shared by the single-item
  // Hub-download path (`persistImportedPack` below) and the multi-file
  // import batch (`collectImportResults` below). Returns the outcome
  // instead of touching state so each caller decides how to surface it
  // (single banner vs. an accumulated batch summary).
  const importOnePack = useCallback(async (
    raw: unknown,
  ): Promise<{ ok: true; meta: I18nPackMeta; validation: ValidatePackResult } | { ok: false; error: string }> => {
    const validation = validatePack(raw)
    if (!validation.ok) {
      return { ok: false, error: validation.errors[0] ?? t('i18n.errorGeneric') }
    }
    if (validation.dangerousKeys.length > 0) {
      return { ok: false, error: t('i18n.preview.dangerousWarning') }
    }
    const coverage = computeCoverage(raw, ENGLISH_PACK_BODY)
    const result = await store.applyImport(raw, {
      enabled: true,
      appVersionAtImport: APP_VERSION,
      matchedBaseVersion: coverage.coverageRatio === 1 ? BASE_REVISION : null,
      coverage: { totalKeys: coverage.totalKeys, coveredKeys: coverage.coveredKeys },
      dangerousKeyCount: validation.dangerousKeys.length,
    })
    if (!result.success || !result.meta) {
      return { ok: false, error: result.error ?? t('i18n.errorGeneric') }
    }
    return { ok: true, meta: result.meta, validation }
  }, [store, t])

  // Single-item import path: Hub download funnels through here (the
  // toolbar's own multi-file import now goes through `importOnePack`
  // directly — see `collectImportResults` below). Failures surface
  // through `setActionError` (the same banner KeyLabels uses) instead
  // of opening a separate confirmation modal.
  const persistImportedPack = useCallback(async (
    raw: unknown,
    extra: { hubPostId?: string } = {},
  ): Promise<void> => {
    setActionError(null)
    setLastResult(null)
    const beforeIds = placement.snapshotBeforeIds()
    const imported = await importOnePack(raw)
    if (!imported.ok) {
      setActionError(imported.error)
      return
    }
    const { meta, validation } = imported
    setLastResult({ id: meta.id, kind: 'success', message: t('common.saved') })
    handleSelectLanguage(`pack:${meta.id}`)
    await placement.place({ id: meta.id, name: meta.name }, { beforeIds })

    if (extra.hubPostId) {
      // Same Author/Updated enrichment as handleSync — the download
      // body itself has no metadata, so look the post back up by name.
      const enriched = validation.header
        ? await fetchHubPackMeta(window.vialAPI.hubListI18nPosts, validation.header.name, extra.hubPostId)
        : {}
      void window.vialAPI.i18nPackSetHubPostId(meta.id, extra.hubPostId, enriched.uploaderName, enriched.hubUpdatedAt)
      return
    }
    // Auto-sync to Hub when this overwrite landed on an entry that
    // already mirrors a Hub post. Promote the inline badge from
    // "Saved" to "Synced" so the user can see the second step
    // completed; failure surfaces inline without rolling back local.
    if (meta.hubPostId) {
      const upd = await pushPackToHub(meta.id, meta.hubPostId)
      if (upd.success) {
        setLastResult({ id: meta.id, kind: 'success', message: t('common.synced') })
      } else {
        setActionError(upd.error ?? t('hub.updateFailed'))
      }
    }
  }, [importOnePack, t, pushPackToHub, handleSelectLanguage, placement])

  // Multi-file import batch: every selected file is parsed and saved
  // independently here; dedupe, hub-sync, placement and the toolbar
  // summary/failure banner are handled by the shared `useImportBatch`
  // hook below (see its module doc for the extraction rationale). The
  // snapshot is taken right after the "canceled" check — before any
  // per-file save runs — matching `placement.snapshotEntries()`'s
  // "before the batch's own mutations begin" contract.
  const collectImportResults = useCallback(async (): Promise<CollectedImportBatch<I18nPackMeta> | null> => {
    const dialogResult = await store.importFromDialog()
    if (dialogResult.canceled) return null
    const snapshot = placement.snapshotEntries()
    const notSavedFailures: ImportBatchFailure[] = []
    const successes: ImportBatchItem<I18nPackMeta>[] = []
    for (const file of dialogResult.files) {
      const fileName = basenameOf(file.filePath)
      if (file.parseError || file.raw === undefined) {
        notSavedFailures.push({ fileName, reason: file.parseError ?? t('i18n.errorInvalidJson') })
        continue
      }
      const imported = await importOnePack(file.raw)
      if (!imported.ok) {
        notSavedFailures.push({ fileName, reason: imported.error })
        continue
      }
      successes.push({ fileName, meta: imported.meta })
    }
    return { successes, notSavedFailures, snapshot }
  }, [store, t, placement, importOnePack])

  const { importing, importSummary, runImport, isImportingRef } = useImportBatch<I18nPackMeta>({
    open,
    placement,
    setLastResult,
    setActionError,
    t,
    collectResults: collectImportResults,
    hubSync: (meta) => pushPackToHub(meta.id, meta.hubPostId!),
    onCollapsedToOne: (meta) => handleSelectLanguage(`pack:${meta.id}`),
  })

  // Closes any inline rename that was already open the moment a batch
  // starts, so its input unmounts instead of sitting there interactive
  // (and committable) for the whole duration of the import — see
  // `handleRenameCommit`'s own `isImportingRef` guard above for the one
  // race this cannot cover (a rename input's blur, and the click that
  // starts the batch, are the same user click; the blur's commit is
  // already in flight before `importing` ever flips true).
  useEffect(() => {
    if (importing) rename.cancelRename()
    // `rename.cancelRename` is a stable (`useCallback([])`) identity —
    // intentionally not in the deps array so this only re-fires when
    // `importing` itself flips, not on every unrelated render.
  }, [importing])

  // Explicit cloud pull: a 'packs'-scoped download (i18n + theme packs
  // only) — see usePackCloudPull's doc for the discovery-gap rationale.
  const pull = usePackCloudPull(setActionError, t, 'i18n.errorGeneric')

  const handleHubDownload = useCallback(async (postId: string): Promise<void> => {
    setPendingId(postId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDownloadI18nPost(postId)
      if (!result.success || !result.data) {
        setActionError(result.error ?? t('i18n.errorGeneric'))
        return
      }
      await persistImportedPack(result.data.pack, { hubPostId: postId })
    } finally {
      setPendingId(null)
    }
  }, [persistImportedPack, t])

  return {
    importing,
    importSummary,
    runImport,
    handleRenameCommit,
    handleRenameKey,
    pull,
    handleHubDownload,
  }
}
