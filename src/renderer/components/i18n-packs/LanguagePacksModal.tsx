// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Language Packs modal. Two tabs:
//   - Installed: built-in English + every imported language pack.
//                Actions: Open / Sync / Update / Remove / Delete + Import.
//   - Find on Hub: search input + Pipette Hub results. Hits already
//                  installed locally are tagged "Installed" rather than
//                  exposing Download (avoids duplicate-name conflicts).
// Mirrors KeyLabelsModal so users can predict behaviour across the
// two manage modals.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import i18n from '../../i18n'
import { validatePack } from '../../../shared/i18n/validate'
import { computeCoverage } from '../../../shared/i18n/coverage'
import { BASE_REVISION, ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import english from '../../i18n/locales/english.json'
import type { HubI18nPostListItem } from '../../../shared/types/hub'
import { MissingKeysModal } from './MissingKeysModal'
import { downloadJson } from '../../utils/download-json'
import { buildHubI18nPackUrl, HUB_CATEGORY } from '../../../shared/hub-urls'
import { useHubFreshness } from '../../hooks/useHubFreshness'
import { PackManagerModal } from '../pack-modal/PackManagerModal'
import { PackHubTab } from '../pack-modal/PackHubTab'
import { PackSortButton } from '../pack-modal/PackSortButton'
import { useHubOrigin } from '../pack-modal/useHubOrigin'
import { useHubSearchList } from '../pack-modal/useHubSearchList'
import { useDragReorder } from '../pack-modal/useDragReorder'
import { applyDragOrder } from '../pack-modal/drag-order'
import { useNameSort } from '../pack-modal/useNameSort'
import { useImportPlacement } from '../pack-modal/useImportPlacement'
import { isHubItemInstalled, type InstalledDetectionEntry } from '../pack-modal/installed-detection'
import { fetchHubPackMeta } from '../pack-modal/fetch-hub-pack-meta'
import type { PackActionResult, PackManagerTabId } from '../pack-modal/pack-modal-types'
import {
  LanguageInstalledRow,
  LanguageHubRow,
  type InstalledRow,
  type HubRow,
} from './LanguageInstalledRow'

const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0'

const BUILTIN_INTERNAL_ID = 'builtin:en'

export interface LanguagePacksModalProps {
  open: boolean
  onClose: () => void
  /** Hub display name of the signed-in user, or null when not signed in. */
  currentDisplayName?: string | null
  /** True when the user is signed into the Hub and can perform writes. */
  hubCanWrite?: boolean
}

export function LanguagePacksModal({
  open,
  onClose,
  currentDisplayName,
  hubCanWrite,
}: LanguagePacksModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useI18nPackStore()
  const rename = useInlineRename<string>()
  const appConfig = useAppConfig()

  const [activeTab, setActiveTab] = useState<PackManagerTabId>('installed')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<PackActionResult | null>(null)
  const [missingKeysFor, setMissingKeysFor] = useState<{ name: string; keys: string[] } | null>(null)

  const builtinName = (english as Record<string, unknown>).name as string ?? 'English'
  const builtinVersion = (english as Record<string, unknown>).version as string ?? '0.1.0'

  const hubOrigin = useHubOrigin(open)

  useEffect(() => {
    if (!open) return
    const stale = store.metas.filter((m) => !m.deletedAt && m.matchedBaseVersion !== BASE_REVISION)
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

  const activeLanguageId = appConfig.config.language ?? 'builtin:en'

  const installedRows: InstalledRow[] = useMemo(() => {
    const rows: InstalledRow[] = [{
      reactKey: BUILTIN_INTERNAL_ID,
      internalId: BUILTIN_INTERNAL_ID,
      packId: null,
      hubPostId: null,
      name: builtinName,
      version: builtinVersion,
      updatedAt: __BUILD_TIME__,
      uploaderName: 'pipette',
      isBuiltin: true,
      active: activeLanguageId === BUILTIN_INTERNAL_ID,
      isComplete: true,
    }]
    for (const meta of store.metas) {
      if (meta.deletedAt) continue
      const internalId = `pack:${meta.id}`
      // A pack is "complete" only when its matchedBaseVersion equals
      // the *current* English baseline. A stale match for an older
      // baseline must surface as incomplete so the user sees the
      // "not set keys" entry point against the new keys.
      const isComplete = meta.matchedBaseVersion === BASE_REVISION
      rows.push({
        reactKey: meta.id,
        internalId,
        packId: meta.id,
        hubPostId: meta.hubPostId ?? null,
        name: meta.name,
        // Display the English baseline version the pack proved it
        // covers, not the pack's own semver. An empty string keeps
        // the row visually consistent while signalling partial
        // coverage to the user.
        version: meta.matchedBaseVersion ?? '',
        // Hub-side timestamp, not the local modification time — blank
        // for never-uploaded local entries and legacy rows that
        // predate this field, matching Key Labels' Updated column.
        updatedAt: meta.hubUpdatedAt ?? '',
        uploaderName: meta.uploaderName ?? '',
        isBuiltin: false,
        active: activeLanguageId === internalId,
        coverage: meta.coverage,
        isComplete,
        meta,
      })
    }
    return rows
  }, [store.metas, builtinName, builtinVersion, activeLanguageId])

  const handleSelectLanguage = useCallback((internalId: string) => {
    if (internalId === activeLanguageId) return
    appConfig.set('language', internalId)
    void i18n.changeLanguage(internalId)
  }, [appConfig, activeLanguageId])

  // Drag reorder + Name sort apply only to real store entries — the
  // synthesized built-in English row is not a store entry and is
  // never draggable, sortable, or part of the persisted order.
  const draggableRows = useMemo(() => installedRows.filter((row) => !row.isBuiltin), [installedRows])
  const dragReorderIds = useMemo(() => draggableRows.map((row) => row.packId as string), [draggableRows])
  const drag = useDragReorder({
    ids: dragReorderIds,
    reorder: store.reorder,
    onError: (error) => setActionError(error ?? t('i18n.errorGeneric')),
  })
  const displayedRows = useMemo<InstalledRow[]>(() => {
    const builtin = installedRows.find((row) => row.isBuiltin)
    const ordered = applyDragOrder(draggableRows, drag.dragOrder, (row) => row.packId as string)
    return builtin ? [builtin, ...ordered] : ordered
  }, [installedRows, draggableRows, drag.dragOrder])

  const nameSortEntries = useMemo(
    () => draggableRows.map((row) => ({ id: row.packId as string, name: row.name })),
    [draggableRows],
  )
  const nameSort = useNameSort({
    open,
    ready: !store.loading,
    entries: nameSortEntries,
    reorder: store.reorder,
    onError: (error) => setActionError(error ?? t('i18n.errorGeneric')),
  })
  const handleSortByName = useCallback((): void => {
    void nameSort.toggle(draggableRows.map((row) => ({ id: row.packId as string, name: row.name })))
  }, [nameSort, draggableRows])
  const placement = useImportPlacement({
    open,
    entries: nameSortEntries,
    direction: nameSort.direction,
    reorder: store.reorder,
    rowTestidPrefix: 'language-packs',
    onReorderError: (error) => setActionError(error ?? t('i18n.errorGeneric')),
  })

  // hubPostId-first + name-fallback (unified with Theme Packs / Key
  // Labels — see installed-detection.ts). Built-in English counts as
  // an "installed" name too, so a Hub pack literally named "English"
  // shows Installed instead of a misleading Download.
  const installedEntries = useMemo<InstalledDetectionEntry[]>(() => [
    { name: builtinName },
    ...store.metas.filter((m) => !m.deletedAt).map((m) => ({ hubPostId: m.hubPostId, name: m.name })),
  ], [store.metas, builtinName])

  const { search, setSearch, hubResults, hubSearched, hubSearching, runSearch } = useHubSearchList<HubI18nPostListItem>({
    open,
    activeTab,
    hubTabId: 'hub',
    fetchPage: (query) => window.vialAPI.hubListI18nPosts({ q: query }),
    errorMessage: (error) => error ?? t('i18n.errorGeneric'),
    onSearchStart: () => setActionError(null),
    onError: setActionError,
  })

  const hubRows: HubRow[] = useMemo(() => hubResults.map((item) => ({
    reactKey: item.id,
    hubPostId: item.id,
    name: item.name,
    version: item.version,
    uploaderName: item.uploaderName ?? '',
    alreadyInstalled: isHubItemInstalled(item, installedEntries),
  })), [hubResults, installedEntries])

  const freshnessCandidates = useMemo(
    () => store.metas
      .filter((m) => !m.deletedAt && !!m.hubPostId)
      .map((m) => ({ localId: m.id, hubPostId: m.hubPostId as string })),
    [store.metas],
  )

  const fetchTimestamps = useCallback(
    (ids: string[]) => window.vialAPI.i18nPackHubTimestamps(ids),
    [],
  )

  const hubFreshness = useHubFreshness({
    enabled: open && activeTab === 'installed',
    candidates: freshnessCandidates,
    fetchTimestamps,
  })

  useEffect(() => {
    if (!open) {
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
    }
  }, [open])

  const handleOpen = useCallback((row: InstalledRow): void => {
    if (!row.hubPostId || !hubOrigin) return
    void window.vialAPI.openExternal(buildHubI18nPackUrl(hubOrigin.replace(/\/$/, ''), row.hubPostId))
  }, [hubOrigin])

  const handleDelete = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId) return
    // Delete is the strongest action: tombstone locally and, if the
    // pack mirrors a Hub post, drop the post too so the user does not
    // need to click Remove + Delete in sequence to fully clean up.
    // If the Hub deletion fails, abort the cascade — proceeding to a
    // local-only delete would strand an orphan post whose name can
    // never be re-uploaded, exactly what the cascade is meant to avoid.
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      if (row.hubPostId) {
        const hubResult = await window.vialAPI.hubDeleteI18nPost(row.hubPostId, row.packId)
          .catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }))
        if (!hubResult.success) {
          setLastResult({ id: row.packId, kind: 'error', message: hubResult.error ?? t('i18n.errorGeneric') })
          return
        }
      }
      const result = await store.remove(row.packId)
      if (!result.success) {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('i18n.errorGeneric') })
        return
      }
      await store.refresh()
    } finally {
      setPendingId(null)
      setConfirmDeleteId(null)
    }
  }, [store, t])

  // Push the local pack body to its existing Hub post. Used by the
  // explicit "Update" action and by the auto-sync paths below
  // (rename / overwrite re-import). Returns the IPC-style result so
  // callers can decide whether to surface the error inline.
  const pushPackToHub = useCallback(async (
    packId: string,
    hubPostId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const get = await window.vialAPI.i18nPackGet(packId)
    if (!get.success || !get.data) {
      return { success: false, error: get.error ?? t('i18n.errorGeneric') }
    }
    const res = await window.vialAPI.hubUpdateI18nPost({
      postId: hubPostId,
      entryId: packId,
      pack: get.data.pack as { version: string; name: string; [k: string]: unknown },
    })
    if (res.success) {
      await store.refresh()
      return { success: true }
    }
    return { success: false, error: res.error ?? t('hub.updateFailed') }
  }, [store, t])

  const handleRenameCommit = useCallback(async (id: string): Promise<void> => {
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

  const handleSync = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.hubPostId) return
    setPendingId(row.packId ?? row.hubPostId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDownloadI18nPost(row.hubPostId)
      if (!result.success || !result.data) {
        setLastResult({ id: row.packId ?? row.hubPostId, kind: 'error', message: result.error ?? t('i18n.errorGeneric') })
        return
      }
      // Re-import with the existing pack id so the entry stays linked
      // to the Hub post and any prior `hubPostId` is retained. Recompute
      // coverage / matchedBaseVersion against the *current* English so
      // a Hub sync after a baseline bump correctly drops the row to
      // "incomplete" instead of inheriting stale completeness.
      const coverage = computeCoverage(result.data.pack, ENGLISH_PACK_BODY)
      // Refresh the Author/Updated cache the same way upload/update do —
      // the download body carries no metadata, so look the post back up
      // by its (possibly just-changed) name via the Hub list endpoint.
      const enriched = await fetchHubPackMeta(window.vialAPI.hubListI18nPosts, result.data.pack.name, row.hubPostId)
      const apply = await store.applyImport(result.data.pack, {
        id: row.packId ?? undefined,
        hubPostId: row.hubPostId,
        hubUpdatedAt: enriched.hubUpdatedAt,
        uploaderName: enriched.uploaderName,
        enabled: true,
        appVersionAtImport: APP_VERSION,
        matchedBaseVersion: coverage.coverageRatio === 1 ? BASE_REVISION : null,
        coverage: { totalKeys: coverage.totalKeys, coveredKeys: coverage.coveredKeys },
      })
      if (apply.success) {
        setLastResult({ id: row.packId ?? row.hubPostId, kind: 'success', message: t('common.synced') })
        await store.refresh()
      } else {
        setLastResult({ id: row.packId ?? row.hubPostId, kind: 'error', message: apply.error ?? t('i18n.errorGeneric') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleUpdate = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId || !row.hubPostId) return
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await pushPackToHub(row.packId, row.hubPostId)
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.updateSuccess') })
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.updateFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [pushPackToHub, t])

  const handleRemove = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId || !row.hubPostId) return
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDeleteI18nPost(row.hubPostId, row.packId)
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.removeSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.removeFailed') })
      }
    } finally {
      setPendingId(null)
      setConfirmRemoveId(null)
    }
  }, [store, t])

  const handleUpload = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId) return
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      const get = await window.vialAPI.i18nPackGet(row.packId)
      if (!get.success || !get.data) {
        setLastResult({ id: row.packId, kind: 'error', message: t('i18n.errorGeneric') })
        return
      }
      const result = await window.vialAPI.hubUploadI18nPost({
        entryId: row.packId,
        pack: get.data.pack as { version: string; name: string; [k: string]: unknown },
      })
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.uploadSuccess') })
        // setHubPostId on the main side does not push a CustomEvent
        // back to the renderer; refresh manually so the row picks up
        // the new hubPostId and surfaces Update / Remove next render.
        await store.refresh()
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.uploadFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleNotSetKeys = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId) return
    setPendingId(row.packId)
    setActionError(null)
    try {
      // Pull the body directly and compute coverage with no sample
      // limit so the modal gets the full set of missing keys (the
      // shared coverage-cache caps at 200 for status-line use).
      const get = await window.vialAPI.i18nPackGet(row.packId)
      if (!get.success || !get.data) {
        setActionError(get.error ?? t('i18n.errorGeneric'))
        return
      }
      const coverage = computeCoverage(get.data.pack, ENGLISH_PACK_BODY, { sampleLimit: Number.POSITIVE_INFINITY })
      setMissingKeysFor({ name: row.name, keys: coverage.missingKeys })
    } finally {
      setPendingId(null)
    }
  }, [t])

  const handleExport = useCallback(async (row: InstalledRow): Promise<void> => {
    if (row.isBuiltin) {
      // Builtin English ships with the renderer bundle; trigger an
      // in-browser download instead of going through the main-side
      // dialog so users can grab the canonical pack as a starting
      // point for translations.
      try {
        downloadJson(row.name, english, { prefix: 'i18n-packs', fallback: 'English' })
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (!row.packId) return
    setPendingId(row.packId)
    setActionError(null)
    try {
      const result = await window.vialAPI.i18nPackExport(row.packId)
      if (!result.success) {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('i18n.errorGeneric') })
      }
    } finally {
      setPendingId(null)
    }
  }, [t])

  // Inline import path: validate locally, compute coverage, then ask
  // the store to persist. Failures surface through `setActionError`
  // (the same banner KeyLabels uses) instead of opening a separate
  // confirmation modal.
  const persistImportedPack = useCallback(async (
    raw: unknown,
    extra: { hubPostId?: string } = {},
  ): Promise<void> => {
    setActionError(null)
    setLastResult(null)
    const validation = validatePack(raw)
    if (!validation.ok) {
      setActionError(validation.errors[0] ?? t('i18n.errorGeneric'))
      return
    }
    if (validation.dangerousKeys.length > 0) {
      setActionError(t('i18n.preview.dangerousWarning'))
      return
    }
    const beforeIds = placement.snapshotBeforeIds()
    const coverage = computeCoverage(raw, ENGLISH_PACK_BODY)
    const result = await store.applyImport(raw, {
      enabled: true,
      appVersionAtImport: APP_VERSION,
      matchedBaseVersion: coverage.coverageRatio === 1 ? BASE_REVISION : null,
      coverage: { totalKeys: coverage.totalKeys, coveredKeys: coverage.coveredKeys },
      dangerousKeyCount: validation.dangerousKeys.length,
    })
    if (!result.success || !result.meta) {
      setActionError(result.error ?? t('i18n.errorGeneric'))
      return
    }
    setLastResult({ id: result.meta.id, kind: 'success', message: t('common.saved') })
    handleSelectLanguage(`pack:${result.meta.id}`)
    await placement.place({ id: result.meta.id, name: result.meta.name }, { beforeIds })

    if (extra.hubPostId) {
      // Same Author/Updated enrichment as handleSync — the download
      // body itself has no metadata, so look the post back up by name.
      const enriched = validation.header
        ? await fetchHubPackMeta(window.vialAPI.hubListI18nPosts, validation.header.name, extra.hubPostId)
        : {}
      void window.vialAPI.i18nPackSetHubPostId(result.meta.id, extra.hubPostId, enriched.uploaderName, enriched.hubUpdatedAt)
      return
    }
    // Auto-sync to Hub when this overwrite landed on an entry that
    // already mirrors a Hub post. Promote the inline badge from
    // "Saved" to "Synced" so the user can see the second step
    // completed; failure surfaces inline without rolling back local.
    if (result.meta.hubPostId) {
      const upd = await pushPackToHub(result.meta.id, result.meta.hubPostId)
      if (upd.success) {
        setLastResult({ id: result.meta.id, kind: 'success', message: t('common.synced') })
      } else {
        setActionError(upd.error ?? t('hub.updateFailed'))
      }
    }
  }, [store, t, pushPackToHub, handleSelectLanguage, placement])

  const handleImportFile = useCallback(async (): Promise<void> => {
    setActionError(null)
    const dialogResult = await store.importFromDialog()
    if (dialogResult.canceled) return
    if (dialogResult.parseError || dialogResult.raw === undefined) {
      setActionError(t('i18n.errorInvalidJson'))
      return
    }
    await persistImportedPack(dialogResult.raw)
  }, [persistImportedPack, store, t])

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

  return (
    <PackManagerModal
      open={open}
      onClose={onClose}
      title={t('i18n.modalTitle')}
      testids={{
        backdrop: 'language-packs-modal-backdrop',
        modal: 'language-packs-modal',
        closeButton: 'language-packs-modal-close',
        tabsContainer: 'language-packs-tabs',
        tabInstalled: 'language-packs-tab-installed',
        tabHub: 'language-packs-tab-hub',
        searchInput: 'language-packs-search-input',
        searchButton: 'language-packs-search-button',
        importButton: 'language-packs-import-button',
        errorBanner: 'language-packs-error',
        importFeedback: 'language-packs-import-feedback',
      }}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      installedLabel={t('common.installed')}
      hubLabel={t('common.findOnHub')}
      search={search}
      onSearchChange={setSearch}
      onSearchEnter={() => void runSearch(search)}
      onSearchClick={() => void runSearch(search.trim())}
      searchPlaceholder={t('common.searchPlaceholder')}
      searchButtonLabel={hubSearching ? t('keyLabels.searching') : t('i18n.search')}
      searchDisabled={hubSearching || search.trim().length < 2}
      importLabel={t('i18n.import')}
      onImport={() => void handleImportFile()}
      sortButton={(
        <PackSortButton
          direction={nameSort.direction}
          onClick={handleSortByName}
          disabled={nameSort.pending}
          testid="language-packs-sort-button"
        />
      )}
      importFeedback={placement.feedback}
      actionError={actionError}
      afterContent={(
        <MissingKeysModal
          open={!!missingKeysFor}
          onClose={() => setMissingKeysFor(null)}
          packName={missingKeysFor?.name ?? ''}
          missingKeys={missingKeysFor?.keys ?? []}
          base={ENGLISH_PACK_BODY}
        />
      )}
    >
      {activeTab === 'installed' ? (
        <div className="space-y-2">
          {displayedRows.map((row) => (
            <LanguageInstalledRow
              key={row.reactKey}
              row={row}
              pendingId={pendingId}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              confirmRemoveId={confirmRemoveId}
              setConfirmRemoveId={setConfirmRemoveId}
              lastResult={lastResult}
              currentDisplayName={currentDisplayName ?? null}
              hubCanWrite={hubCanWrite ?? false}
              hubFreshness={hubFreshness}
              rename={rename}
              onRenameKey={handleRenameKey}
              onRenameCommit={handleRenameCommit}
              onSelectLanguage={handleSelectLanguage}
              onOpen={handleOpen}
              onUpload={handleUpload}
              onUpdate={handleUpdate}
              onSync={handleSync}
              onRemove={handleRemove}
              onDelete={handleDelete}
              onExport={handleExport}
              onNotSetKeys={handleNotSetKeys}
              onDragStart={() => drag.onDragStart(row.packId as string)}
              onDragOver={() => drag.onDragOver(row.packId as string)}
              onDragEnd={() => {
                void (async () => {
                  const moved = await drag.onDragEnd()
                  if (moved) nameSort.markFree()
                })()
              }}
            />
          ))}
        </div>
      ) : (
        <PackHubTab
          rows={hubRows}
          renderRow={(row) => (
            <LanguageHubRow
              key={row.reactKey}
              row={row}
              pendingId={pendingId}
              onDownload={(postId) => void handleHubDownload(postId)}
            />
          )}
          hubSearched={hubSearched}
          emptyText={t('i18n.hubEmpty')}
          emptyTestid="language-packs-hub-empty"
          hubOrigin={hubOrigin}
          category={HUB_CATEGORY.I18N_PACKS}
          initialLinkTestid="language-packs-hub-initial-link"
        />
      )}
    </PackManagerModal>
  )
}

