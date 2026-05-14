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
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Circle, CheckCircle2 } from 'lucide-react'
import { ICON_XL } from '../../constants/ui-tokens'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import i18n from '../../i18n'
import { validatePack } from '../../../shared/i18n/validate'
import { computeCoverage } from '../../../shared/i18n/coverage'
import { BASE_REVISION, ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import english from '../../i18n/locales/english.json'
import { formatTimestamp } from '../../utils/format-timestamp'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'
import type { HubI18nPostListItem } from '../../../shared/types/hub'
import { MissingKeysModal } from './MissingKeysModal'
import { downloadJson } from '../../utils/download-json'
import { buildHubI18nPackUrl, buildHubCategoryUrl, HUB_CATEGORY } from '../../../shared/hub-urls'
import { useHubFreshness, hasUpdate, type HubFreshnessEntry } from '../../hooks/useHubFreshness'

const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0'

const BUILTIN_INTERNAL_ID = 'builtin:en'

type TabId = 'installed' | 'hub'

export interface LanguagePacksModalProps {
  open: boolean
  onClose: () => void
  /** Hub display name of the signed-in user, or null when not signed in. */
  currentDisplayName?: string | null
  /** True when the user is signed into the Hub and can perform writes. */
  hubCanWrite?: boolean
}

interface InstalledRow {
  reactKey: string
  internalId: string
  packId: string | null
  hubPostId: string | null
  name: string
  version: string
  /** ISO 8601 timestamp shown next to the name. Builtin English uses
   * the renderer's build time; imported packs use `meta.updatedAt`. */
  updatedAt: string
  uploaderName: string
  isBuiltin: boolean
  active: boolean
  coverage?: { totalKeys: number; coveredKeys: number }
  /** True when the pack covers every key of the bundled English. The
   * row shows the `version` chip when complete, otherwise a
   * "not set keys" button that opens MissingKeysModal. */
  isComplete: boolean
  meta?: I18nPackMeta
}

interface HubRow {
  reactKey: string
  hubPostId: string
  name: string
  version: string
  uploaderName: string
  alreadyInstalled: boolean
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

  const [activeTab, setActiveTab] = useState<TabId>('installed')
  const [search, setSearch] = useState('')
  const [hubResults, setHubResults] = useState<HubI18nPostListItem[]>([])
  const [hubDefaultResults, setHubDefaultResults] = useState<HubI18nPostListItem[]>([])
  const [hubSearched, setHubSearched] = useState(false)
  const [hubSearching, setHubSearching] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ id: string; kind: 'success' | 'error'; message: string } | null>(null)
  const [hubOrigin, setHubOrigin] = useState('')
  const [missingKeysFor, setMissingKeysFor] = useState<{ name: string; keys: string[] } | null>(null)

  const builtinName = (english as Record<string, unknown>).name as string ?? 'English'
  const builtinVersion = (english as Record<string, unknown>).version as string ?? '0.1.0'

  useEffect(() => {
    if (!open) return
    void window.vialAPI.hubGetOrigin().then((origin) => { if (origin) setHubOrigin(origin) }).catch(() => null)
  }, [open])

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
        updatedAt: meta.updatedAt,
        uploaderName: meta.hubPostId ? '' : 'local',
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

  const installedHubPostIds = useMemo(
    () => new Set(store.metas.filter((m) => !m.deletedAt && m.hubPostId).map((m) => m.hubPostId as string)),
    [store.metas],
  )

  const hubRows: HubRow[] = useMemo(() => hubResults.map((item) => ({
    reactKey: item.id,
    hubPostId: item.id,
    name: item.name,
    version: item.version,
    uploaderName: item.uploaderName ?? '',
    alreadyInstalled: installedHubPostIds.has(item.id),
  })), [hubResults, installedHubPostIds])

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

  const runSearch = useCallback(async (query: string): Promise<void> => {
    setHubSearching(true)
    setActionError(null)
    try {
      const result = await window.vialAPI.hubListI18nPosts({ q: query })
      if (result.success && result.data) {
        setHubResults(result.data.items)
        setHubSearched(true)
        if (!query.trim()) setHubDefaultResults(result.data.items)
      } else {
        setActionError(result.error ?? t('i18n.errorGeneric'))
      }
    } finally {
      setHubSearching(false)
    }
  }, [t])

  // Auto-fetch Hub list when the hub tab becomes active (no query = latest items).
  // Re-fetches each time the modal is opened so results stay fresh.
  useEffect(() => {
    if (!open || activeTab !== 'hub' || hubSearched) return
    void runSearch('')
  }, [open, activeTab, hubSearched, runSearch])

  // Debounced search: fire once the user has typed 2+ characters.
  // Below the threshold restore the initial results instead of clearing.
  useEffect(() => {
    if (!open || activeTab !== 'hub') return
    const query = search.trim()
    if (query.length < 2) {
      if (hubDefaultResults.length > 0) setHubResults(hubDefaultResults)
      return
    }
    const handle = window.setTimeout(() => { void runSearch(query) }, 300)
    return () => { window.clearTimeout(handle) }
  }, [open, activeTab, search, runSearch, hubDefaultResults])

  useEffect(() => {
    if (!open) {
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
      setHubSearched(false)
      setHubResults([])
      setHubDefaultResults([])
      setSearch('')
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
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      if (row.hubPostId) {
        await window.vialAPI.hubDeleteI18nPost(row.hubPostId, row.packId).catch(() => null)
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
      const apply = await store.applyImport(result.data.pack, {
        id: row.packId ?? undefined,
        hubPostId: row.hubPostId,
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
    if (extra.hubPostId) {
      void window.vialAPI.i18nPackSetHubPostId(result.meta.id, extra.hubPostId)
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
  }, [store, t, pushPackToHub, handleSelectLanguage])

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

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="language-packs-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-modal-lg max-w-[90vw] h-modal-80vh flex flex-col rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="language-packs-modal"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-base font-semibold text-content">{t('i18n.modalTitle')}</h2>
          <ModalCloseButton testid="language-packs-modal-close" onClick={onClose} />
        </div>

        <div className="flex border-b border-edge" data-testid="language-packs-tabs">
          <TabButton id="installed" label={t('common.installed')} active={activeTab === 'installed'} onClick={() => setActiveTab('installed')} />
          <TabButton id="hub" label={t('common.findOnHub')} active={activeTab === 'hub'} onClick={() => setActiveTab('hub')} />
        </div>

        {activeTab === 'hub' && (
          <div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
            <input
              type="text"
              value={search}
              placeholder={t('common.searchPlaceholder')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(search) }}
              className="flex-1 rounded border border-edge bg-surface px-3 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
              data-testid="language-packs-search-input"
            />
            <button
              type="button"
              disabled={hubSearching || search.trim().length < 2}
              onClick={() => void runSearch(search.trim())}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-content-inverse hover:opacity-90 disabled:opacity-50"
              data-testid="language-packs-search-button"
            >
              {hubSearching ? t('keyLabels.searching') : t('i18n.search')}
            </button>
          </div>
        )}

        {activeTab === 'installed' && (
          <div className="flex items-center justify-end px-4 py-3 border-b border-edge">
            <button
              type="button"
              onClick={() => void handleImportFile()}
              className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover"
              data-testid="language-packs-import-button"
            >
              {t('i18n.import')}
            </button>
          </div>
        )}

        {actionError && (
          <div className="mx-4 my-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700" data-testid="language-packs-error">
            {actionError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {activeTab === 'installed' ? (
            <InstalledTable
              rows={installedRows}
              pendingId={pendingId}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              confirmRemoveId={confirmRemoveId}
              setConfirmRemoveId={setConfirmRemoveId}
              lastResult={lastResult}
              currentDisplayName={currentDisplayName ?? null}
              hubCanWrite={hubCanWrite ?? false}
              hubOrigin={hubOrigin}
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
            />
          ) : (
            <HubTable
              rows={hubRows}
              hubSearched={hubSearched}
              pendingId={pendingId}
              hubOrigin={hubOrigin}
              onDownload={(postId) => void handleHubDownload(postId)}
            />
          )}
        </div>
      </div>
      <MissingKeysModal
        open={!!missingKeysFor}
        onClose={() => setMissingKeysFor(null)}
        packName={missingKeysFor?.name ?? ''}
        missingKeys={missingKeysFor?.keys ?? []}
        base={ENGLISH_PACK_BODY}
      />
    </div>,
    document.body,
  )
}

interface TabButtonProps {
  id: TabId
  label: string
  active: boolean
  onClick: () => void
}

function TabButton({ id, label, active, onClick }: TabButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'
      }`}
      data-testid={`language-packs-tab-${id}`}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}

interface InstalledTableProps {
  rows: InstalledRow[]
  pendingId: string | null
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  confirmRemoveId: string | null
  setConfirmRemoveId: (id: string | null) => void
  lastResult: { id: string; kind: 'success' | 'error'; message: string } | null
  currentDisplayName: string | null
  hubCanWrite: boolean
  hubOrigin: string
  hubFreshness: Map<string, HubFreshnessEntry>
  rename: ReturnType<typeof useInlineRename<string>>
  onRenameKey: (event: React.KeyboardEvent<HTMLInputElement>, id: string) => void
  onRenameCommit: (id: string) => void | Promise<void>
  onSelectLanguage: (internalId: string) => void
  onOpen: (row: InstalledRow) => void
  onUpload: (row: InstalledRow) => void
  onUpdate: (row: InstalledRow) => void
  onSync: (row: InstalledRow) => void
  onRemove: (row: InstalledRow) => void
  onDelete: (row: InstalledRow) => void
  onExport: (row: InstalledRow) => void
  onNotSetKeys: (row: InstalledRow) => void
}

function InstalledTable(props: InstalledTableProps): JSX.Element {
  const { rows } = props
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <InstalledRowView key={row.reactKey} row={row} {...props} />
      ))}
    </div>
  )
}

interface InstalledRowViewProps extends Omit<InstalledTableProps, 'rows'> {
  row: InstalledRow
}

function InstalledRowView({
  row,
  pendingId,
  confirmDeleteId,
  setConfirmDeleteId,
  confirmRemoveId,
  setConfirmRemoveId,
  lastResult,
  hubCanWrite,
  hubFreshness,
  rename,
  onRenameKey,
  onRenameCommit,
  onSelectLanguage,
  onOpen,
  onUpload,
  onUpdate,
  onSync,
  onRemove,
  onDelete,
  onExport,
  onNotSetKeys,
}: InstalledRowViewProps): JSX.Element {
  const { t } = useTranslation()
  const busy = pendingId !== null && (pendingId === row.packId || pendingId === row.hubPostId)
  const freshness = row.packId ? hubFreshness.get(row.packId) : undefined
  const hasUpdateAvailable = hasUpdate(freshness, row.meta?.hubUpdatedAt)
  const hubRemoved = !!freshness && freshness.removed
  const editing = !!row.packId && rename.editingId === row.packId
  const renderName = (): JSX.Element => {
    if (editing && row.packId) {
      return (
        <input
          autoFocus
          type="text"
          value={rename.editLabel}
          onChange={(e) => rename.setEditLabel(e.target.value)}
          onBlur={() => void onRenameCommit(row.packId as string)}
          onKeyDown={(e) => onRenameKey(e, row.packId as string)}
          maxLength={64}
          className="w-full border-b border-edge bg-transparent px-1 text-sm text-content outline-none focus:border-accent"
          data-testid={`language-packs-rename-input-${row.reactKey}`}
        />
      )
    }
    if (!row.isBuiltin && row.packId) {
      return (
        <span
          className="block w-full truncate text-content cursor-pointer"
          onClick={() => rename.startRename(row.packId as string, row.name)}
          data-testid={`language-packs-name-${row.reactKey}`}
        >
          {row.name}
        </span>
      )
    }
    return <span className="text-content">{row.name}</span>
  }
  const updatedAt = row.updatedAt ? formatTimestamp(row.updatedAt) : ''
  const linkClass = 'text-xs font-medium hover:underline disabled:opacity-50'

  const showUpload = !row.isBuiltin && !row.hubPostId && hubCanWrite
  const showHubPair = !row.isBuiltin && Boolean(row.hubPostId)
  // The simplified "isMine" check: when uploaderName is unavailable
  // we conservatively show Update / Remove only if the user is signed
  // in for writes. Hub returns uploader_name on download / list paths
  // but the local meta does not cache it for i18n packs.
  const showUpdateRemove = showHubPair && hubCanWrite

  return (
    <div
      className={`flex flex-col rounded border bg-surface ${row.active ? 'border-accent' : 'border-edge'}`}
      data-testid={`language-packs-row-${row.reactKey}`}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          aria-label={t('i18n.selectLanguage', { name: row.name })}
          className="shrink-0 text-content-muted hover:text-accent transition-colors"
          onClick={() => onSelectLanguage(row.internalId)}
          data-testid={`language-packs-select-${row.reactKey}`}
        >
          {row.active ? (
            <CheckCircle2 size={ICON_XL} className="text-accent" aria-hidden="true" />
          ) : (
            <Circle size={ICON_XL} aria-hidden="true" />
          )}
        </button>
        <div className="flex-1 min-w-0 text-sm font-medium">{renderName()}</div>
        <div
          className={`shrink-0 whitespace-nowrap text-xs ${hubRemoved ? 'text-rose-600' : 'text-content-muted'}`}
          data-testid={`language-packs-timestamp-${row.reactKey}`}
        >
          {hubRemoved ? t('keyLabels.hubRemoved') : updatedAt}
        </div>
        <div className="shrink-0 whitespace-nowrap text-xs">
          {row.isComplete ? (
            <span className="text-content-muted" data-testid={`language-packs-version-${row.reactKey}`}>
              {row.version ? `v${row.version}` : ''}
            </span>
          ) : (
            <button
              type="button"
              className="text-accent hover:underline disabled:opacity-50"
              onClick={(e) => {
                e.stopPropagation()
                onNotSetKeys(row)
              }}
              disabled={busy}
              data-testid={`language-packs-not-set-keys-${row.reactKey}`}
            >
              {t('i18n.notSetKeys')}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.isBuiltin && (
            <>
              <button
                type="button"
                className={`${linkClass} text-content-muted`}
                onClick={() => onExport(row)}
                data-testid={`language-packs-export-${row.reactKey}`}
              >
                {t('keyLabels.actionExport')}
              </button>
              {/* Reserve the same width as the Delete action so the
                  built-in row's right edge lines up with imported rows. */}
              <span aria-hidden="true" className={`${linkClass} invisible`}>
                {t('keyLabels.actionDelete')}
              </span>
            </>
          )}
          {!row.isBuiltin && (
            confirmDeleteId === row.reactKey ? (
              <span className="inline-flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(row)
                  }}
                  className={`${linkClass} text-danger`}
                  data-testid={`language-packs-confirm-delete-${row.reactKey}`}
                >
                  {t('common.confirmDelete')}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDeleteId(null)
                  }}
                  className={`${linkClass} text-content-muted`}
                  data-testid={`language-packs-cancel-delete-${row.reactKey}`}
                >
                  {t('common.cancel')}
                </button>
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className={`${linkClass} text-content-muted`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onExport(row)
                  }}
                  disabled={busy}
                  data-testid={`language-packs-export-${row.reactKey}`}
                >
                  {t('keyLabels.actionExport')}
                </button>
                <button
                  type="button"
                  className={`${linkClass} text-danger`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDeleteId(row.reactKey)
                  }}
                  disabled={busy}
                  data-testid={`language-packs-delete-${row.reactKey}`}
                >
                  {t('keyLabels.actionDelete')}
                </button>
              </>
            )
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 pb-2">
        <span className="flex-1 min-w-0">
          {lastResult && (lastResult.id === row.packId || lastResult.id === row.hubPostId) && (
            <span
              className={`text-xs font-medium ${lastResult.kind === 'success' ? 'text-accent' : 'text-rose-600'}`}
              data-testid={`language-packs-result-${row.reactKey}`}
            >
              {lastResult.message}
            </span>
          )}
        </span>
        {row.hubPostId && (
          <button
            type="button"
            className={`${linkClass} text-accent`}
            onClick={() => onOpen(row)}
            disabled={busy}
            data-testid={`language-packs-open-${row.reactKey}`}
          >
            {t('hub.openInBrowser')}
          </button>
        )}
        {showUpload && (
          <button
            type="button"
            className={`${linkClass} text-accent`}
            onClick={() => onUpload(row)}
            disabled={busy}
            data-testid={`language-packs-upload-${row.reactKey}`}
          >
            {t('keyLabels.actionUpload')}
          </button>
        )}
        {showHubPair && !showUpdateRemove && (
          <button
            type="button"
            className={`${linkClass} text-accent inline-flex items-center gap-1`}
            onClick={() => onSync(row)}
            disabled={busy}
            data-testid={`language-packs-sync-${row.reactKey}`}
          >
            {hasUpdateAvailable && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"
                data-testid={`language-packs-update-available-${row.reactKey}`}
              />
            )}
            {t('keyLabels.actionSync')}
          </button>
        )}
        {showUpdateRemove && (
          confirmRemoveId === row.reactKey ? (
            <>
              <button
                type="button"
                className={`${linkClass} text-danger`}
                onClick={() => onRemove(row)}
                disabled={busy}
                data-testid={`language-packs-confirm-remove-${row.reactKey}`}
              >
                {t('hub.confirmRemove')}
              </button>
              <button
                type="button"
                className={`${linkClass} text-content-muted`}
                onClick={() => setConfirmRemoveId(null)}
                data-testid={`language-packs-cancel-remove-${row.reactKey}`}
              >
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`${linkClass} text-accent`}
                onClick={() => onUpdate(row)}
                disabled={busy}
                data-testid={`language-packs-update-${row.reactKey}`}
              >
                {t('keyLabels.actionUpdate')}
              </button>
              <button
                type="button"
                className={`${linkClass} text-danger`}
                onClick={() => setConfirmRemoveId(row.reactKey)}
                disabled={busy}
                data-testid={`language-packs-remove-${row.reactKey}`}
              >
                {t('keyLabels.actionRemove')}
              </button>
            </>
          )
        )}
      </div>
    </div>
  )
}

interface HubTableProps {
  rows: HubRow[]
  hubSearched: boolean
  pendingId: string | null
  hubOrigin: string
  onDownload: (postId: string) => void
}

function HubTable({ rows, hubSearched, pendingId, hubOrigin, onDownload }: HubTableProps): JSX.Element {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-content-muted" data-testid="language-packs-hub-empty">
        {hubSearched ? (
          t('i18n.hubEmpty')
        ) : (
          <Trans
            i18nKey="common.findOnHubHint"
            components={{
              hub: hubOrigin ? (
                <a
                  href={buildHubCategoryUrl(hubOrigin, HUB_CATEGORY.I18N_PACKS)}
                  onClick={(e) => {
                    e.preventDefault()
                    void window.vialAPI.openExternal(buildHubCategoryUrl(hubOrigin, HUB_CATEGORY.I18N_PACKS))
                  }}
                  className="text-accent hover:underline"
                  data-testid="language-packs-hub-initial-link"
                />
              ) : (
                <span />
              ),
            }}
          />
        )}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.reactKey}
          className="flex items-center gap-3 rounded border border-edge bg-surface px-3 py-2"
          data-testid={`language-packs-hub-row-${row.hubPostId}`}
        >
          <div className="flex-1 min-w-0">
            <div className="truncate text-sm font-medium text-content">{row.name}</div>
            <div className="text-xs text-content-muted">v{row.version}{row.uploaderName ? ` · ${row.uploaderName}` : ''}</div>
          </div>
          <div className="shrink-0">
            {row.alreadyInstalled ? (
              <span className="text-xs text-content-muted">{t('common.installed')}</span>
            ) : (
              <button
                type="button"
                className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                onClick={() => onDownload(row.hubPostId)}
                disabled={pendingId === row.hubPostId}
                data-testid={`language-packs-hub-download-${row.hubPostId}`}
              >
                {t('keyLabels.actionDownload')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

