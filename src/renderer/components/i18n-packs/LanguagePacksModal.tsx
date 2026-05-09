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
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import { ImportPreviewModal } from './ImportPreviewModal'
import english from '../../i18n/locales/english.json'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'
import type { HubI18nPostListItem } from '../../../shared/types/hub'

const BUILTIN_INTERNAL_ID = 'builtin:en'

type TabId = 'installed' | 'hub'

function buildHubPostUrl(hubOrigin: string, postId: string): string {
  return `${hubOrigin.replace(/\/$/, '')}/post/${postId}`
}

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
  uploaderName: string
  isBuiltin: boolean
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

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number): string => n.toString().padStart(2, '0')
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
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

  const [activeTab, setActiveTab] = useState<TabId>('installed')
  const [search, setSearch] = useState('')
  const [hubResults, setHubResults] = useState<HubI18nPostListItem[]>([])
  const [hubSearched, setHubSearched] = useState(false)
  const [hubSearching, setHubSearching] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ id: string; kind: 'success' | 'error'; message: string } | null>(null)
  const [importPayload, setImportPayload] = useState<{ raw: unknown; downloadedFromPostId?: string } | null>(null)
  const [hubOrigin, setHubOrigin] = useState('')

  const builtinName = (english as Record<string, unknown>).name as string ?? 'English'
  const builtinVersion = (english as Record<string, unknown>).version as string ?? '0.1.0'

  useEffect(() => {
    if (!open) return
    void window.vialAPI.hubGetOrigin().then((origin) => { if (origin) setHubOrigin(origin) }).catch(() => null)
  }, [open])

  const installedRows: InstalledRow[] = useMemo(() => {
    const rows: InstalledRow[] = [{
      reactKey: BUILTIN_INTERNAL_ID,
      internalId: BUILTIN_INTERNAL_ID,
      packId: null,
      hubPostId: null,
      name: builtinName,
      version: builtinVersion,
      uploaderName: 'pipette',
      isBuiltin: true,
    }]
    for (const meta of store.metas) {
      if (meta.deletedAt) continue
      const internalId = `pack:${meta.id}`
      rows.push({
        reactKey: meta.id,
        internalId,
        packId: meta.id,
        hubPostId: meta.hubPostId ?? null,
        name: meta.name,
        version: meta.version,
        uploaderName: meta.hubPostId ? '' : 'local',
        isBuiltin: false,
        meta,
      })
    }
    return rows
  }, [store.metas, builtinName, builtinVersion])

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

  const runSearch = useCallback(async (query: string): Promise<void> => {
    setHubSearching(true)
    setActionError(null)
    try {
      const result = await window.vialAPI.hubListI18nPosts({ q: query })
      if (result.success && result.data) {
        setHubResults(result.data.items)
        setHubSearched(true)
      } else {
        setActionError(result.error ?? t('i18n.errorGeneric'))
      }
    } finally {
      setHubSearching(false)
    }
  }, [t])

  // Debounced auto-search: only fire once the user has typed 2+
  // characters. Below the threshold we clear the previous results
  // (and reset the "have searched" flag) so the empty hint comes back
  // instead of leaving stale rows visible. Mirrors the KeyLabelsModal
  // contract so the two manage modals stay predictable.
  useEffect(() => {
    if (!open || activeTab !== 'hub') return
    const query = search.trim()
    if (query.length < 2) {
      setHubResults((prev) => (prev.length === 0 ? prev : []))
      setHubSearched((prev) => (prev ? false : prev))
      return
    }
    const handle = window.setTimeout(() => { void runSearch(query) }, 300)
    return () => { window.clearTimeout(handle) }
  }, [open, activeTab, search, runSearch])

  useEffect(() => {
    if (!open) {
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
    }
  }, [open])

  const runWithPending = useCallback(async (
    id: string,
    op: () => Promise<{ success: boolean; error?: string }>,
    successKey?: string,
    errorKey?: string,
  ): Promise<void> => {
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await op()
      if (result.success) {
        if (successKey) setLastResult({ id, kind: 'success', message: t(successKey) })
      } else {
        const msg = result.error ?? t(errorKey ?? 'i18n.errorGeneric')
        setLastResult({ id, kind: 'error', message: msg })
      }
    } finally {
      setPendingId(null)
    }
  }, [t])

  const handleOpen = useCallback((row: InstalledRow): void => {
    if (!row.hubPostId || !hubOrigin) return
    void window.vialAPI.openExternal(buildHubPostUrl(hubOrigin, row.hubPostId))
  }, [hubOrigin])

  const handleDelete = useCallback(async (row: InstalledRow): Promise<void> => {
    console.log('[i18n-pack] handleDelete invoked', { packId: row.packId, hubPostId: row.hubPostId, reactKey: row.reactKey })
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

  const handleRenameCommit = useCallback(async (id: string): Promise<void> => {
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.rename(id, newName)
      if (!result.success) setActionError(result.error ?? t('i18n.errorGeneric'))
    } finally {
      setPendingId(null)
    }
  }, [rename, store, t])

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
      // to the Hub post and any prior `hubPostId` is retained.
      const apply = await store.applyImport(result.data.pack, {
        id: row.packId ?? undefined,
        hubPostId: row.hubPostId,
        enabled: true,
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
      const get = await window.vialAPI.i18nPackGet(row.packId)
      if (!get.success || !get.data) {
        setLastResult({ id: row.packId, kind: 'error', message: t('i18n.errorGeneric') })
        return
      }
      const result = await window.vialAPI.hubUpdateI18nPost({
        postId: row.hubPostId,
        entryId: row.packId,
        pack: get.data.pack as { version: string; name: string; [k: string]: unknown },
      })
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.updateSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.updateFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

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

  const handleExport = useCallback(async (row: InstalledRow): Promise<void> => {
    if (row.isBuiltin) {
      // Builtin English ships with the renderer bundle; trigger an
      // in-browser download instead of going through the main-side
      // dialog so users can grab the canonical pack as a starting
      // point for translations.
      try {
        const blob = new Blob([JSON.stringify(english, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'English.json'
        a.click()
        URL.revokeObjectURL(url)
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

  const handleImportFile = useCallback(async (): Promise<void> => {
    setActionError(null)
    const dialogResult = await store.importFromDialog()
    if (dialogResult.canceled) return
    if (dialogResult.parseError || dialogResult.raw === undefined) {
      setActionError(t('i18n.errorInvalidJson'))
      return
    }
    setImportPayload({ raw: dialogResult.raw })
  }, [store, t])

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
      const raw = result.data.pack
      setImportPayload({ raw, downloadedFromPostId: postId })
    } finally {
      setPendingId(null)
    }
  }, [t])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="language-packs-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-[80vh] flex flex-col rounded-lg bg-surface shadow-xl"
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
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
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
              rename={rename}
              onRenameKey={handleRenameKey}
              onRenameCommit={handleRenameCommit}
              onOpen={handleOpen}
              onUpload={handleUpload}
              onUpdate={handleUpdate}
              onSync={handleSync}
              onRemove={handleRemove}
              onDelete={handleDelete}
              onExport={handleExport}
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
      {importPayload && (
        <ImportPreviewModal
          raw={importPayload.raw}
          onCancel={() => setImportPayload(null)}
          onApplied={(meta) => {
            const postId = importPayload.downloadedFromPostId
            setImportPayload(null)
            if (meta && postId) {
              void window.vialAPI.i18nPackSetHubPostId(meta.id, postId)
            }
          }}
        />
      )}
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
  rename: ReturnType<typeof useInlineRename<string>>
  onRenameKey: (event: React.KeyboardEvent<HTMLInputElement>, id: string) => void
  onRenameCommit: (id: string) => void | Promise<void>
  onOpen: (row: InstalledRow) => void
  onUpload: (row: InstalledRow) => void
  onUpdate: (row: InstalledRow) => void
  onSync: (row: InstalledRow) => void
  onRemove: (row: InstalledRow) => void
  onDelete: (row: InstalledRow) => void
  onExport: (row: InstalledRow) => void
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
  rename,
  onRenameKey,
  onRenameCommit,
  onOpen,
  onUpload,
  onUpdate,
  onSync,
  onRemove,
  onDelete,
  onExport,
}: InstalledRowViewProps): JSX.Element {
  const { t } = useTranslation()
  // `pendingId === row.hubPostId` was matching when both sides were
  // null (a row without a Hub post + no pending operation), which
  // disabled every button. Gate the comparison on a non-null
  // pendingId so idle rows stay clickable.
  const busy = pendingId !== null && (pendingId === row.packId || pendingId === row.hubPostId)
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
          className="text-content cursor-pointer"
          onClick={() => rename.startRename(row.packId as string, row.name)}
          data-testid={`language-packs-name-${row.reactKey}`}
        >
          {row.name}
        </span>
      )
    }
    return <span className="text-content">{row.name}</span>
  }
  const updatedAt = row.meta?.updatedAt ? formatTimestamp(row.meta.updatedAt) : ''
  const linkClass = 'text-xs font-medium hover:underline disabled:opacity-50'

  const showUpload = !row.isBuiltin && !row.hubPostId && hubCanWrite
  const showHubPair = !row.isBuiltin && Boolean(row.hubPostId)
  // The simplified "isMine" check: when uploaderName is unavailable
  // we conservatively show Update / Remove only if the user is signed
  // in for writes. Hub returns uploader_name on download / list paths
  // but the local meta does not cache it for i18n packs.
  const showUpdateRemove = showHubPair && hubCanWrite

  return (
    <div className="flex flex-col rounded border border-edge bg-surface" data-testid={`language-packs-row-${row.reactKey}`}>
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-content">{renderName()}</div>
          <div className="text-xs text-content-muted">v{row.version}</div>
        </div>
        <div className="hidden md:block w-32 shrink-0 truncate text-xs text-content-muted">{updatedAt}</div>
        <div className="flex shrink-0 items-center gap-2">
          {row.isBuiltin && (
            <button
              type="button"
              className={`${linkClass} text-content-muted`}
              onClick={() => onExport(row)}
              data-testid={`language-packs-export-${row.reactKey}`}
            >
              {t('keyLabels.actionExport')}
            </button>
          )}
          {!row.isBuiltin && (
            confirmDeleteId === row.reactKey ? (
              <span className="inline-flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    console.log('[i18n-pack] confirm delete clicked', row.reactKey)
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
                    console.log('[i18n-pack] cancel delete clicked', row.reactKey)
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
                    console.log('[i18n-pack] export clicked', row.reactKey)
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
                    console.log('[i18n-pack] delete clicked', { reactKey: row.reactKey, busy })
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
              className={`text-[11px] font-medium ${lastResult.kind === 'success' ? 'text-accent' : 'text-rose-600'}`}
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
            className={`${linkClass} text-accent`}
            onClick={() => onSync(row)}
            disabled={busy}
            data-testid={`language-packs-sync-${row.reactKey}`}
          >
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
                  href={hubOrigin}
                  onClick={(e) => {
                    e.preventDefault()
                    void window.vialAPI.openExternal(hubOrigin)
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
