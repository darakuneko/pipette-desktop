// SPDX-License-Identifier: GPL-2.0-or-later
//
// Import surface for Theme Packs: multi-file import batch, inline
// rename commit (auto-sync on a Hub-linked pack), the explicit cloud
// pull, and Hub-download-to-import. Split out of ThemePacksModal
// (Task-split-pack-modals) — mirrors use-language-pack-import.ts; rename
// lives here rather than in the actions hook because it needs
// `useImportBatch`'s own `isImportingRef` re-entrancy guard, which only
// exists once this hook creates it.

import { useCallback, useEffect } from 'react'
import type { TFunction } from 'i18next'
import type { ThemePackMeta } from '../../../shared/types/theme-store'
import { usePackCloudPull } from '../pack-modal/usePackCloudPull'
import { useImportBatch, type CollectedImportBatch, type ImportBatchItem } from '../pack-modal/useImportBatch'
import { basenameOf, type ImportBatchFailure } from '../pack-modal/import-batch-summary'
import { fetchHubPackMeta } from '../pack-modal/fetch-hub-pack-meta'
import type { UseImportPlacementResult } from '../pack-modal/useImportPlacement'
import type { InlineRename } from '../../hooks/useInlineRename'
import type { UseThemePackStoreReturn } from '../../hooks/useThemePackStore'
import type { ThemeSelection } from '../../../shared/types/app-config'
import type { PackActionResult } from '../pack-modal/pack-modal-types'

export interface UseThemePackImportOptions {
  open: boolean
  store: UseThemePackStoreReturn
  t: TFunction
  rename: InlineRename<string>
  placement: UseImportPlacementResult
  pushPackToHub: (packId: string, hubPostId: string) => Promise<{ success: boolean; error?: string }>
  handleSelectTheme: (selection: ThemeSelection) => void
  setPendingId: (id: string | null) => void
  setActionError: (error: string | null) => void
  setLastResult: (result: PackActionResult | PackActionResult[] | null) => void
}

export function useThemePackImport({
  open,
  store,
  t,
  rename,
  placement,
  pushPackToHub,
  handleSelectTheme,
  setPendingId,
  setActionError,
  setLastResult,
}: UseThemePackImportOptions) {
  // Multi-file import batch: every selected file is saved independently
  // here (theme pack validation lives entirely main-side in `savePack`,
  // so there is no renderer-side pre-check to run first, unlike
  // Language Packs); dedupe, hub-sync, placement and the toolbar
  // summary/failure banner are handled by the shared `useImportBatch`
  // hook below (see its module doc for the extraction rationale). The
  // snapshot is taken right after the "canceled" check — before any
  // per-file save runs — matching `placement.snapshotEntries()`'s
  // "before the batch's own mutations begin" contract.
  const collectImportResults = useCallback(async (): Promise<CollectedImportBatch<ThemePackMeta> | null> => {
    const dialogResult = await store.importFromDialog()
    if (dialogResult.canceled) return null
    const snapshot = placement.snapshotEntries()
    const notSavedFailures: ImportBatchFailure[] = []
    const successes: ImportBatchItem<ThemePackMeta>[] = []
    for (const file of dialogResult.files) {
      const fileName = basenameOf(file.filePath)
      if (file.parseError || file.raw === undefined) {
        notSavedFailures.push({ fileName, reason: file.parseError ?? t('themePacks.parseError') })
        continue
      }
      try {
        const result = await store.applyImport(file.raw)
        if (!result.success || !result.meta) {
          notSavedFailures.push({ fileName, reason: result.error ?? t('themePacks.parseError') })
          continue
        }
        successes.push({ fileName, meta: result.meta })
      } catch {
        notSavedFailures.push({ fileName, reason: t('themePacks.parseError') })
      }
    }
    return { successes, notSavedFailures, snapshot }
  }, [store, t, placement])

  const { importing, importSummary, runImport, isImportingRef } = useImportBatch<ThemePackMeta>({
    open,
    placement,
    setLastResult,
    setActionError,
    t,
    collectResults: collectImportResults,
    hubSync: (meta) => pushPackToHub(meta.id, meta.hubPostId!),
    onCollapsedToOne: (meta) => handleSelectTheme(`pack:${meta.id}`),
  })

  // Closes any inline rename that was already open the moment a batch
  // starts, so its input unmounts instead of sitting there interactive
  // (and committable) for the whole duration of the import — see
  // `handleRenameCommit`'s own `isImportingRef` guard below for the one
  // race this cannot cover (a rename input's blur, and the click that
  // starts the batch, are the same user click; the blur's commit is
  // already in flight before `importing` ever flips true).
  useEffect(() => {
    if (importing) rename.cancelRename()
    // `rename.cancelRename` is a stable (`useCallback([])`) identity —
    // intentionally not in the deps array so this only re-fires when
    // `importing` itself flips, not on every unrelated render.
  }, [importing])

  const handleRenameCommit = useCallback(async (id: string) => {
    // Guards on `useImportBatch`'s own re-entrancy ref rather than a
    // locally-mirrored one — written only inside an event handler
    // (`runImport`), never during render, so it can't go stale under a
    // discarded/interrupted concurrent render. Referencing
    // `isImportingRef` here, defined further up via `useImportBatch`,
    // is safe regardless: this callback's body only runs later, on a
    // real blur/Enter event, well after the full render has finished.
    //
    // A rename already committed its `store.rename` call the instant
    // the underlying input blurred — including the blur a click on the
    // Import button itself triggers, which fires before that click's
    // own handler runs — so this check cannot intercept that exact
    // call. It DOES catch every other path: a rename input left open
    // when a batch was already running, and any stray commit that
    // slips through after the cancel-on-import-start effect above has
    // already reset the editor for this render.
    if (isImportingRef.current) return
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.rename(id, newName)
      if (!result.success && result.error) {
        setActionError(result.error)
        return
      }
      const meta = store.metas.find((m) => m.id === id)
      if (meta?.hubPostId) {
        const upd = await pushPackToHub(id, meta.hubPostId)
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

  // Explicit cloud pull: a 'packs'-scoped download (i18n + theme packs
  // only) — see usePackCloudPull's doc for the discovery-gap rationale.
  const pull = usePackCloudPull(setActionError, t, 'themePacks.parseError')

  const handleHubDownload = useCallback(async (postId: string): Promise<void> => {
    setPendingId(postId)
    setActionError(null)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(postId)
      if (!result.success || !result.data) {
        setActionError(result.error ?? t('themePacks.hubEmpty'))
        return
      }
      const beforeIds = placement.snapshotBeforeIds()
      const enriched = await fetchHubPackMeta(window.vialAPI.hubListThemePosts, result.data.name, postId)
      const apply = await store.applyImport(result.data, { hubPostId: postId, hubUpdatedAt: enriched.hubUpdatedAt, uploaderName: enriched.uploaderName })
      if (!apply.success || !apply.meta) return
      await placement.place({ id: apply.meta.id, name: apply.meta.name }, { beforeIds })
    } finally {
      setPendingId(null)
    }
  }, [store, t, placement])

  const handleRenameKey = (event: React.KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleRenameCommit(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      rename.cancelRename()
    }
  }

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
