// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Key Labels modal. Two tabs:
//   - Installed: local entries (always includes the built-in qwerty row).
//                Actions: Upload / Update / Remove / Rename / Delete + Import.
//   - Find on Hub: search input + Pipette Hub results. Hits already
//                  installed locally are tagged "Installed" instead of
//                  exposing Download to avoid duplicate-name conflicts.
// Wording (Upload/Update/Remove/Synced/Delete) mirrors the
// favorite-store editors so the hub-aware modals stay consistent.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useKeyLabels } from '../../hooks/useKeyLabels'
import { useKeyLabelLookup } from '../../hooks/useKeyLabelLookup'
import { resolveLayoutDisplayName } from '../../hooks/useLayoutOptions'
import { HUB_ERROR_KEY_LABEL_DUPLICATE, type HubKeyLabelItem } from '../../../shared/types/hub-key-label'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../../data/keyboard-layouts'
import { useHubFreshness } from '../../hooks/useHubFreshness'
import { PackManagerModal } from '../pack-modal/PackManagerModal'
import { PackSortButton } from '../pack-modal/PackSortButton'
import { useHubOrigin } from '../pack-modal/useHubOrigin'
import { useHubSearchList } from '../pack-modal/useHubSearchList'
import { useNameSort } from '../pack-modal/useNameSort'
import { useDragReorder } from '../pack-modal/useDragReorder'
import { applyDragOrder } from '../pack-modal/drag-order'
import { useImportPlacement } from '../pack-modal/useImportPlacement'
import { buildImportBatchFailureSummary, type ImportBatchFailure } from '../pack-modal/import-batch-summary'
import { isHubItemInstalled, type InstalledDetectionEntry } from '../pack-modal/installed-detection'
import { isOwnPack } from '../pack-modal/ownership'
import type { PackActionResult, PackManagerTabId } from '../pack-modal/pack-modal-types'
import {
  InstalledTable,
  HubTable,
  type InstalledRow,
  type HubRow,
} from './KeyLabelsInstalledTable'

interface KeyLabelsModalProps {
  open: boolean
  onClose: () => void
  /** Hub display name of the signed-in user, or null when not signed in. */
  currentDisplayName: string | null
  /** True when the user is signed into the Hub and can perform write ops. */
  hubCanWrite: boolean
}

export function KeyLabelsModal({
  open,
  onClose,
  currentDisplayName,
  hubCanWrite,
}: KeyLabelsModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const labels = useKeyLabels()
  const rename = useInlineRename<string>()

  const [activeTab, setActiveTab] = useState<PackManagerTabId>('installed')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * Per-row inline status message ("Saved" / "Uploaded" / "Updated" /
   * "Removed" or the localized error). Mirrors the FavoriteHubActions /
   * LayoutStoreHubActions feedback so the user sees confirmation right
   * under the affected row instead of hunting for a toast. Cleared at
   * the start of the next operation.
   */
  const [lastResult, setLastResult] = useState<PackActionResult | PackActionResult[] | null>(null)

  // Key Labels fetches the Hub origin once on first mount, unlike the
  // i18n/theme pack modals which re-fetch each time the modal opens.
  const hubOrigin = useHubOrigin(open, { onlyOnce: true })

  const freshnessCandidates = useMemo(
    () => labels.metas
      .filter((m) => !!m.hubPostId && m.id !== BUILTIN_QWERTY_LAYOUT_ID)
      .map((m) => ({ localId: m.id, hubPostId: m.hubPostId as string })),
    [labels.metas],
  )

  const fetchTimestamps = useCallback(
    (ids: string[]) => labels.hubTimestamps(ids),
    [labels.hubTimestamps],
  )

  const hubFreshness = useHubFreshness({
    enabled: open && activeTab === 'installed',
    candidates: freshnessCandidates,
    fetchTimestamps,
  })

  useEscapeClose(onClose, open)

  const keyLabelLookup = useKeyLabelLookup()

  // Resolve each installed pack's own entry file so the list can show a
  // "Keymap Write" vs "View Only" type label per row (see
  // `useKeyLabelLookup.isKeymapWritable`'s doc comment), re-derived here
  // for every installed row instead of just the one currently selected as
  // the keyboard layout. Gated on the Installed tab being visible,
  // mirroring `hubFreshness`'s own `enabled` gate above, so switching to
  // Find on Hub (or closing the modal) does not keep firing IPC fetches
  // for packs nobody is looking at. `ensure` itself is a no-op once a
  // pack is cached or already known-missing, so re-running this on every
  // metas/tab change is cheap.
  useEffect(() => {
    if (!open || activeTab !== 'installed') return
    keyLabelLookup.ensureAll(labels.metas.map((m) => m.id))
  }, [open, activeTab, labels.metas, keyLabelLookup])

  const rawInstalledRows = useMemo<InstalledRow[]>(
    () => buildInstalledRows(labels.metas, keyLabelLookup.isKeymapWritable, t),
    [labels.metas, keyLabelLookup, t],
  )

  // Drag reorder scope includes QWERTY — unlike Language/Theme Packs'
  // synthesized built-in rows, QWERTY is a real store entry that can be
  // dragged like any other row (the main-side reorder handler skips
  // ids that are not in the store, so 'qwerty' is harmless to send
  // through even if it were ever absent).
  const dragReorderIds = useMemo(() => rawInstalledRows.map((r) => r.localId), [rawInstalledRows])
  const drag = useDragReorder({
    ids: dragReorderIds,
    reorder: labels.reorder,
    onError: (error) => setActionError(translateError(t, undefined, error)),
  })
  const installedRows = useMemo<InstalledRow[]>(
    () => applyDragOrder(rawInstalledRows, drag.dragOrder, (r) => r.localId),
    [rawInstalledRows, drag.dragOrder],
  )

  // Name sort scope includes QWERTY — unlike Language/Theme Packs'
  // synthesized built-in rows, QWERTY is a real store entry that
  // already participates in drag reorder.
  const nameSortEntries = useMemo(
    () => labels.metas.map((meta) => ({ id: meta.id, name: meta.name })),
    [labels.metas],
  )
  const nameSort = useNameSort({
    open,
    ready: !labels.loading,
    entries: nameSortEntries,
    reorder: labels.reorder,
    onError: (error) => setActionError(translateError(t, undefined, error)),
  })
  const handleSortByName = useCallback((): void => {
    void nameSort.toggle(labels.metas.map((meta) => ({ id: meta.id, name: meta.name })))
  }, [nameSort, labels.metas])
  const placement = useImportPlacement({
    open,
    entries: nameSortEntries,
    direction: nameSort.direction,
    reorder: labels.reorder,
    rowTestidPrefix: 'key-labels',
    onReorderError: (error) => setActionError(translateError(t, undefined, error)),
  })

  const { search, setSearch, hubResults, hubSearched, hubSearching, runSearch } = useHubSearchList<HubKeyLabelItem>({
    open,
    activeTab,
    hubTabId: 'hub',
    fetchPage: (query) => labels.hubSearch({ q: query, perPage: 50 }),
    errorMessage: (error) => error ?? t('keyLabels.errorSearchFailed'),
    onSearchStart: () => setActionError(null),
    onError: setActionError,
    clearResultsOnError: true,
    // Key Labels marks a row searched even on failure (no auto-retry
    // when the user leaves and re-enters the Hub tab), unlike i18n/theme.
    markSearchedOnFailure: true,
  })

  const hubRows = useMemo<HubRow[]>(
    () => buildHubRows(hubResults, labels.metas),
    [hubResults, labels.metas],
  )

  // Multi-file import batch. All of the batch's writes already land on
  // disk in one `importFromFile()` IPC round trip, so `beforeEntries`
  // captured once up front is the correct "before the user's action"
  // baseline for every result regardless of processing order. The
  // actual list placement happens in ONE `placement.placeMany` call at
  // the end — see the RAPID-INSERT RACE note in useImportPlacement.ts
  // for why calling `place()` once per file (the original approach)
  // could compute a later file's position from a stale snapshot and
  // silently drop an earlier file's id from the persisted order. Two
  // files resolving to the same label (main's overwrite-by-name reuses
  // the same id) are deduped, keeping only the last file's outcome —
  // that's what actually ended up on disk — so hub-sync and the row
  // badge only run/appear once per id, not once per file.
  const handleImport = useCallback(async () => {
    setActionError(null)
    setLastResult(null)
    const beforeEntries = placement.snapshotEntries()
    const res = await labels.importFromFile()
    if (res.success && res.data) {
      const failures: ImportBatchFailure[] = res.data.rejections.map((r) => ({
        fileName: r.fileName,
        reason: translateError(t, r.errorCode, r.error),
      }))

      const dedupedById = new Map<string, { fileName: string; meta: KeyLabelMeta }>()
      for (const success of res.data.imported) {
        dedupedById.delete(success.meta.id)
        dedupedById.set(success.meta.id, success)
      }
      const deduped = [...dedupedById.values()]

      const successBadges: PackActionResult[] = []
      for (const { fileName, meta } of deduped) {
        let message = t('common.saved')
        // Auto-sync overwrites of an already-uploaded entry so the Hub
        // post stays consistent with the user's local edit. Promote the
        // badge from "Saved" to "Synced" on success; a sync failure is
        // folded into the same failure summary as import rejections
        // (the file itself imported fine, only the Hub push failed) —
        // reported against the originating filename, not the label's
        // internal name.
        if (meta.hubPostId) {
          const upd = await labels.hubUpdate(meta.id)
          if (upd.success) {
            message = t('common.synced')
          } else {
            failures.push({ fileName, reason: translateError(t, upd.errorCode, upd.error) })
          }
        }
        successBadges.push({ id: meta.id, kind: 'success', message })
      }

      if (deduped.length > 0) {
        await placement.placeMany(
          deduped.map(({ meta }) => ({ id: meta.id, name: meta.name })),
          beforeEntries,
        )
        setLastResult(successBadges)
      }
      const summary = buildImportBatchFailureSummary(t, failures)
      if (summary) setActionError(summary)
    } else if (res.error && res.error !== 'cancelled') {
      setActionError(translateError(t, res.errorCode, res.error))
    }
  }, [labels, t, placement])

  const runWithPending = useCallback(async <T,>(
    id: string,
    op: () => Promise<{ success: boolean; errorCode?: string; error?: string; data?: T }>,
    /** i18n key for the inline success badge under the row. */
    successKey?: string,
    /** i18n key used when no `error` string was returned by the op. */
    failKey?: string,
  ): Promise<{ success: boolean; errorCode?: string; error?: string; data?: T }> => {
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const res = await op()
      if (res.success) {
        if (successKey) {
          setLastResult({ id, kind: 'success', message: t(successKey) })
        }
      } else {
        const message = translateError(t, res.errorCode, res.error)
          || (failKey ? t(failKey) : t('keyLabels.errorGeneric'))
        setLastResult({ id, kind: 'error', message })
      }
      return res
    } finally {
      setPendingId(null)
    }
  }, [t])

  const handleHubDownload = useCallback(async (hubPostId: string): Promise<void> => {
    // The DUPLICATE_NAME guard (main-side) already rejects any name
    // collision before this can succeed, so every successful Hub
    // download here is a brand-new entry — no overwrite branch to
    // consider, unlike file import (`alwaysInsert` below).
    const res = await runWithPending(hubPostId, () => labels.hubDownload(hubPostId), 'common.saved')
    if (res.success && res.data) {
      // The download IPC saves the entry locally with id = hubPostId,
      // so anchoring the badge on the same id surfaces a "Saved" badge
      // under the new row when the user flips back to the Installed tab.
      await placement.place({ id: res.data.id, name: res.data.name }, { alwaysInsert: true })
    }
  }, [labels, runWithPending, placement])

  const handleRenameCommit = useCallback(async (id: string) => {
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const res = await labels.rename(id, newName)
      if (!res.success) {
        setActionError(translateError(t, res.errorCode, res.error))
        return
      }
      // Auto-sync to Hub when this entry is already uploaded — a rename
      // is an overwrite, so the user's expectation is "what's on Hub
      // matches what I see locally." Surface "Synced" so the second
      // step is visible; failure stays inline (local already saved).
      if (res.data?.hubPostId) {
        const upd = await labels.hubUpdate(id)
        if (upd.success) {
          setLastResult({ id, kind: 'success', message: t('common.synced') })
        } else {
          setActionError(translateError(t, upd.errorCode, upd.error))
        }
      }
    } finally {
      setPendingId(null)
    }
  }, [labels, rename, t])

  const handleRenameKey = (event: React.KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleRenameCommit(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      rename.cancelRename()
    }
  }

  return (
    <PackManagerModal
      open={open}
      onClose={onClose}
      title={t('keyLabels.title')}
      testids={{
        backdrop: 'key-labels-modal-backdrop',
        modal: 'key-labels-modal',
        closeButton: 'key-labels-modal-close',
        tabsContainer: 'key-labels-tabs',
        tabInstalled: 'key-labels-tab-installed',
        tabHub: 'key-labels-tab-hub',
        searchInput: 'key-labels-search-input',
        searchButton: 'key-labels-search-button',
        importButton: 'key-labels-import-button',
        importFeedback: 'key-labels-import-feedback',
        errorBanner: 'key-labels-error',
      }}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      installedLabel={t('common.installed')}
      hubLabel={t('common.findOnHub')}
      search={search}
      onSearchChange={setSearch}
      onSearchEnter={() => void runSearch(search.trim())}
      onSearchClick={() => void runSearch(search.trim())}
      searchPlaceholder={t('common.searchPlaceholder')}
      searchButtonLabel={hubSearching ? t('keyLabels.searching') : t('keyLabels.search')}
      searchDisabled={hubSearching || search.trim().length < 2}
      importLabel={t('keyLabels.import')}
      onImport={() => void handleImport()}
      sortButton={(
        <PackSortButton
          direction={nameSort.direction}
          onClick={handleSortByName}
          disabled={nameSort.pending}
          testid="key-labels-sort-button"
        />
      )}
      importFeedback={placement.feedback}
      actionError={actionError}
    >
      {activeTab === 'installed' ? (
        <InstalledTable
          rows={installedRows}
          pendingId={pendingId}
          confirmDeleteId={confirmDeleteId}
          setConfirmDeleteId={setConfirmDeleteId}
          confirmRemoveId={confirmRemoveId}
          setConfirmRemoveId={setConfirmRemoveId}
          lastResult={lastResult}
          rename={rename}
          currentDisplayName={currentDisplayName}
          hubCanWrite={hubCanWrite}
          onRenameKey={handleRenameKey}
          onRenameCommit={handleRenameCommit}
          onUpload={(id) => { void runWithPending(id, () => labels.hubUpload(id), 'hub.uploadSuccess', 'hub.uploadFailed') }}
          onUpdate={(id) => { void runWithPending(id, () => labels.hubUpdate(id), 'hub.updateSuccess', 'hub.updateFailed') }}
          onSync={(id) => { void runWithPending(id, () => labels.hubSync(id), 'hub.syncSuccess', 'hub.syncFailed') }}
          onRemove={async (id) => {
            await runWithPending(id, () => labels.hubDelete(id), 'hub.removeSuccess', 'hub.removeFailed')
            setConfirmRemoveId(null)
          }}
          onDelete={async (id) => {
            // Delete cascades to Hub only for posts *we* own, aligning
            // with Language/Theme Packs: Hub rejects same-name
            // re-uploads, so a local-only delete would strand an
            // orphan post nobody can remove — but that argument only
            // holds for a post the user could actually re-upload
            // themselves. A downloaded (foreign) entry also carries
            // `hubPostId` (for Sync/freshness linkage), so cascading
            // regardless of ownership attempts — and fails — a Hub
            // delete the user has no rights to (foreign post /
            // deactivated uploader account), and the failure then
            // blocked the local delete too, leaving the user unable to
            // remove a downloaded entry at all. Not-owned entries
            // delete locally only, no Hub call, same as Update/Remove's
            // `isMine` gating (`isOwnPack`). If the Hub deletion of an
            // *owned* post does not succeed, the cascade is aborted:
            // the local entry is left intact, the confirm state
            // closes, and the error is surfaced inline so the user can
            // retry (a swallowed failure here would proceed to strand
            // exactly the unclaimable-name orphan the cascade exists
            // to prevent).
            const meta = labels.metas.find((m) => m.id === id)
            const owned = meta?.hubPostId && isOwnPack(meta.hubPostId, meta.uploaderName ?? '', currentDisplayName)
            if (owned) {
              setPendingId(id)
              setActionError(null)
              setLastResult(null)
              let hubResult: { success: boolean; errorCode?: string; error?: string }
              try {
                hubResult = await labels.hubDelete(id)
              } catch (err) {
                hubResult = { success: false, error: err instanceof Error ? err.message : String(err) }
              } finally {
                setPendingId(null)
              }
              if (!hubResult.success) {
                setLastResult({ id, kind: 'error', message: translateError(t, hubResult.errorCode, hubResult.error) })
                setConfirmDeleteId(null)
                return
              }
            }
            await runWithPending(id, () => labels.remove(id))
            setConfirmDeleteId(null)
          }}
          onExport={(id) => { void runWithPending(id, () => labels.exportEntry(id)) }}
          onDragStart={drag.onDragStart}
          onDragOver={drag.onDragOver}
          onDragEnd={() => {
            void (async () => {
              const moved = await drag.onDragEnd()
              if (moved) nameSort.markFree()
            })()
          }}
          hubOrigin={hubOrigin}
          hubFreshness={hubFreshness}
        />
      ) : (
        <HubTable
          rows={hubRows}
          hubSearched={hubSearched}
          pendingId={pendingId}
          hubOrigin={hubOrigin}
          onDownload={(hubPostId) => handleHubDownload(hubPostId)}
        />
      )}
    </PackManagerModal>
  )
}


/**
 * Build rows directly from the store metas. The main-side
 * `ensureQwertyEntry` guarantees a QWERTY entry exists, so QWERTY
 * participates in the same drag / sync ordering as every other label.
 * Newly downloaded labels arrive at the end of `metas` (saveRecord
 * appends), drag reorders persist via `KEY_LABEL_STORE_REORDER`.
 *
 * `name` goes through `resolveLayoutDisplayName` — the same override
 * `useLayoutOptions` applies for the footer/Settings dropdowns — so the
 * built-in QWERTY row reads "QWERTY (Default)" here too, instead of the
 * raw `meta.name` string persisted on disk.
 */
function buildInstalledRows(
  metas: KeyLabelMeta[],
  isKeymapWritable: (id: string) => boolean,
  t: TFunction,
): InstalledRow[] {
  return metas.map((meta) => ({
    reactKey: `local:${meta.id}`,
    localId: meta.id,
    hubPostId: meta.hubPostId ?? null,
    name: resolveLayoutDisplayName(meta.id, meta.name, t),
    // The Author column shows the cached Hub `uploader_name`. Empty
    // for never-uploaded local imports.
    author: meta.uploaderName ?? '',
    isQwerty: meta.id === BUILTIN_QWERTY_LAYOUT_ID,
    keymapWritable: isKeymapWritable(meta.id),
    meta,
  }))
}

function buildHubRows(items: HubKeyLabelItem[], metas: KeyLabelMeta[]): HubRow[] {
  // hubPostId-first + name-fallback (unified with Language/Theme Packs
  // — see installed-detection.ts). Sorting now happens upstream in
  // useHubSearchList, shared by all three modals.
  const installedEntries: InstalledDetectionEntry[] = metas.map((m) => ({ hubPostId: m.hubPostId, name: m.name }))
  return items.map((item) => ({
    reactKey: `hub:${item.id}`,
    hubPostId: item.id,
    name: item.name,
    author: item.uploader_name ?? '',
    alreadyInstalled: isHubItemInstalled(item, installedEntries),
  }))
}

function translateError(
  t: (key: string) => string,
  code: string | undefined,
  error: string | undefined,
): string {
  if (code === 'DUPLICATE_NAME' || error === HUB_ERROR_KEY_LABEL_DUPLICATE) {
    return t('keyLabels.errorDuplicate')
  }
  if (code === 'INVALID_FILE') return t('keyLabels.errorImportFailed')
  if (code === 'INVALID_NAME') return t('keyLabels.errorInvalidName')
  return error ?? t('keyLabels.errorGeneric')
}

