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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { GripVertical } from 'lucide-react'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useKeyLabels } from '../../hooks/useKeyLabels'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { HUB_ERROR_KEY_LABEL_DUPLICATE } from '../../../shared/types/hub-key-label'
import { buildHubKeyLabelUrl } from '../../../shared/hub-urls'
import type {
  HubKeyLabelItem,
  HubKeyLabelListResponse,
} from '../../../shared/types/hub-key-label'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'

const QWERTY_ID = 'qwerty'

type TabId = 'installed' | 'hub'

interface KeyLabelsModalProps {
  open: boolean
  onClose: () => void
  /** Hub display name of the signed-in user, or null when not signed in. */
  currentDisplayName: string | null
  /** True when the user is signed into the Hub and can perform write ops. */
  hubCanWrite: boolean
}

interface InstalledRow {
  reactKey: string
  localId: string
  hubPostId: string | null
  name: string
  author: string
  isQwerty: boolean
  meta?: KeyLabelMeta
}

interface HubRow {
  reactKey: string
  hubPostId: string
  name: string
  author: string
  /** True when a local entry already covers this hub item (by name, case-insensitive). */
  alreadyInstalled: boolean
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

  const [activeTab, setActiveTab] = useState<TabId>('installed')
  const [search, setSearch] = useState('')
  const [hubResults, setHubResults] = useState<HubKeyLabelItem[]>([])
  const [hubSearched, setHubSearched] = useState(false)
  const [hubSearching, setHubSearching] = useState(false)
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
  const [lastResult, setLastResult] = useState<{
    id: string
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  /**
   * Optional override for the installed-row order. While the user is
   * dragging we manipulate this list directly; on drop we persist it
   * via `useKeyLabels.reorder` and clear the override so subsequent
   * `metas` updates from sync take over again.
   */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const [hubOrigin, setHubOrigin] = useState('')

  // The Hub origin powers the "Open in browser" links; fetched once on
  // mount and reused across all rows.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const origin = await window.vialAPI.hubGetOrigin()
        if (!cancelled) setHubOrigin(origin)
      } catch {
        // best-effort; the Open link simply hides when origin stays empty
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEscapeClose(onClose, open)

  const installedRows = useMemo<InstalledRow[]>(
    () => applyDragOrder(buildInstalledRows(labels.metas), dragOrder),
    [labels.metas, dragOrder],
  )

  const hubRows = useMemo<HubRow[]>(
    () => buildHubRows(hubResults, labels.metas),
    [hubResults, labels.metas],
  )

  // Keep the latest values in refs so the auto-search effect can
  // depend only on the inputs that should re-arm the timer
  // (activeTab + search). Otherwise the effect would re-run on every
  // render that recreates `labels` / `t`, causing an infinite update
  // loop via setState inside the effect.
  const labelsRef = useRef(labels)
  const tRef = useRef(t)
  useEffect(() => { labelsRef.current = labels }, [labels])
  useEffect(() => { tRef.current = t }, [t])

  const runSearch = useCallback(async (query: string): Promise<void> => {
    if (query.length < 2) return
    setHubSearching(true)
    setActionError(null)
    const res = await labelsRef.current.hubSearch({ q: query, perPage: 50 })
    setHubSearching(false)
    setHubSearched(true)
    if (!res.success || !res.data) {
      setActionError(res.error ?? tRef.current('keyLabels.errorSearchFailed'))
      setHubResults([])
      return
    }
    setHubResults((res.data as HubKeyLabelListResponse).items)
  }, [])

  const triggerSearch = useCallback((): void => {
    void runSearch(search.trim())
  }, [runSearch, search])

  // Debounced auto-search: once the user has typed 2+ characters,
  // queue a search 300ms after the last keystroke. Below the
  // threshold we reset the result panel back to the initial hint
  // (only when there is something to clear, to avoid setState ↔
  // effect feedback loops).
  useEffect(() => {
    if (activeTab !== 'hub') return
    const query = search.trim()
    if (query.length < 2) {
      setHubResults((prev) => (prev.length === 0 ? prev : []))
      setHubSearched((prev) => (prev ? false : prev))
      return
    }
    const handle = window.setTimeout(() => { void runSearch(query) }, 300)
    return () => { window.clearTimeout(handle) }
  }, [activeTab, search, runSearch])

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void triggerSearch()
    }
  }

  const handleImport = useCallback(async () => {
    setActionError(null)
    setLastResult(null)
    const res = await labels.importFromFile()
    if (res.success && res.data) {
      // The store returns the (possibly overwritten) entry meta —
      // anchor the inline "Saved" badge on whatever id ended up on
      // disk so a re-import of the same name lights up the existing
      // row instead of orphaning the message.
      setLastResult({ id: res.data.id, kind: 'success', message: t('common.saved') })
    } else if (res.error && res.error !== 'cancelled') {
      setActionError(translateError(t, res.errorCode, res.error))
    }
  }, [labels, t])

  const runWithPending = useCallback(async (
    id: string,
    op: () => Promise<{ success: boolean; errorCode?: string; error?: string }>,
    /** i18n key for the inline success badge under the row. */
    successKey?: string,
    /** i18n key used when no `error` string was returned by the op. */
    failKey?: string,
  ): Promise<void> => {
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
    } finally {
      setPendingId(null)
    }
  }, [t])

  const handleRenameCommit = useCallback(async (id: string) => {
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const res = await labels.rename(id, newName)
      if (!res.success) setActionError(translateError(t, res.errorCode, res.error))
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

  const handleDragStart = (id: string): void => {
    dragIdRef.current = id
    if (dragOrder === null) {
      // QWERTY is included so it can be dragged like any other row.
      // The main-side reorder handler skips ids that are not in the
      // store, so 'qwerty' is harmless to send through.
      setDragOrder(installedRows.map((r) => r.localId))
    }
  }

  const handleDragOver = (overId: string): void => {
    const dragId = dragIdRef.current
    if (!dragId || dragId === overId) return
    const baseline = dragOrder ?? installedRows.map((r) => r.localId)
    const fromIdx = baseline.indexOf(dragId)
    const toIdx = baseline.indexOf(overId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    const next = baseline.slice()
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, dragId)
    setDragOrder(next)
  }

  const handleDragEnd = async (): Promise<void> => {
    const order = dragOrder
    dragIdRef.current = null
    if (!order) {
      setDragOrder(null)
      return
    }
    setActionError(null)
    // Keep `dragOrder` applied while the reorder IPC + refresh round
    // trip is in flight; otherwise the rows snap back to the stale
    // `metas` order before the new index lands. Clearing happens after
    // the refresh has already replaced `metas` with the saved order.
    const result = await labels.reorder(order)
    setDragOrder(null)
    if (!result.success) setActionError(translateError(t, result.errorCode, result.error))
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="key-labels-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-[80vh] flex flex-col rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="key-labels-modal"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-base font-semibold text-content">{t('keyLabels.title')}</h2>
          <ModalCloseButton testid="key-labels-modal-close" onClick={onClose} />
        </div>

        <div className="flex border-b border-edge" data-testid="key-labels-tabs">
          <TabButton
            id="installed"
            label={t('keyLabels.tabInstalled')}
            active={activeTab === 'installed'}
            onClick={() => setActiveTab('installed')}
          />
          <TabButton
            id="hub"
            label={t('keyLabels.tabHub')}
            active={activeTab === 'hub'}
            onClick={() => setActiveTab('hub')}
          />
        </div>

        {activeTab === 'hub' && (
          <div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
            <input
              type="text"
              value={search}
              placeholder={t('keyLabels.searchPlaceholder')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              className="flex-1 rounded border border-edge bg-surface px-3 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
              data-testid="key-labels-search-input"
            />
            <button
              type="button"
              disabled={hubSearching || search.trim().length < 2}
              onClick={() => void triggerSearch()}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              data-testid="key-labels-search-button"
            >
              {hubSearching ? t('keyLabels.searching') : t('keyLabels.search')}
            </button>
          </div>
        )}

        {actionError && (
          <div className="mx-4 my-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700">
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
              rename={rename}
              currentDisplayName={currentDisplayName}
              hubCanWrite={hubCanWrite}
              onRenameKey={handleRenameKey}
              onRenameCommit={handleRenameCommit}
              onUpload={(id) => runWithPending(id, () => labels.hubUpload(id), 'hub.uploadSuccess', 'hub.uploadFailed')}
              onUpdate={(id) => runWithPending(id, () => labels.hubUpdate(id), 'hub.updateSuccess', 'hub.updateFailed')}
              onRemove={async (id) => {
                await runWithPending(id, () => labels.hubDelete(id), 'hub.removeSuccess', 'hub.removeFailed')
                setConfirmRemoveId(null)
              }}
              onDelete={async (id) => {
                // No success badge for Delete — the row tombstones away
                // immediately, leaving the badge nowhere to render.
                await runWithPending(id, () => labels.remove(id))
                setConfirmDeleteId(null)
              }}
              onExport={(id) => runWithPending(id, () => labels.exportEntry(id))}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              hubOrigin={hubOrigin}
            />
          ) : (
            <HubTable
              rows={hubRows}
              hubSearched={hubSearched}
              pendingId={pendingId}
              hubOrigin={hubOrigin}
              onDownload={(hubPostId) =>
                // The download IPC saves the entry locally with id =
                // hubPostId, so anchoring the badge on the same id
                // surfaces a "Saved" badge under the new row when the
                // user flips back to the Installed tab.
                runWithPending(hubPostId, () => labels.hubDownload(hubPostId), 'common.saved')
              }
            />
          )}
        </div>

        {activeTab === 'installed' && (
          <div className="flex items-center justify-end border-t border-edge px-4 py-3">
            <button
              type="button"
              onClick={() => void handleImport()}
              className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover"
              data-testid="key-labels-import-button"
            >
              {t('keyLabels.import')}
            </button>
          </div>
        )}
      </div>
    </div>
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
        active
          ? 'border-b-2 border-accent text-accent'
          : 'text-content-secondary hover:text-content'
      }`}
      data-testid={`key-labels-tab-${id}`}
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
  rename: ReturnType<typeof useInlineRename<string>>
  currentDisplayName: string | null
  hubCanWrite: boolean
  hubOrigin: string
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>, id: string) => void
  onRenameCommit: (id: string) => void | Promise<void>
  onUpload: (id: string) => void | Promise<void>
  onUpdate: (id: string) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onExport: (id: string) => void | Promise<void>
  onDragStart: (id: string) => void
  onDragOver: (overId: string) => void
  onDragEnd: () => void | Promise<void>
}

function InstalledTable(props: InstalledTableProps): JSX.Element {
  const { t } = useTranslation()
  const { rows } = props
  return (
    <div className="space-y-2 text-sm">
      {rows.map((row) => (
        <InstalledRowView key={row.reactKey} row={row} {...props} />
      ))}
      {rows.length === 0 && (
        <div className="py-6 text-center text-content-secondary">
          {t('keyLabels.empty')}
        </div>
      )}
    </div>
  )
}

interface InstalledRowViewProps extends InstalledTableProps {
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
  rename,
  currentDisplayName,
  hubCanWrite,
  onRenameKey,
  onRenameCommit,
  onUpload,
  onUpdate,
  onRemove,
  onDelete,
  onExport,
  onDragStart,
  onDragOver,
  onDragEnd,
  hubOrigin,
}: InstalledRowViewProps): JSX.Element {
  const isMine = !row.hubPostId || row.author === currentDisplayName
  // QWERTY shows the same drag handle as the other rows; only its
  // action column stays empty (no rename / delete / hub ops).
  const isDraggable = true
  const editing = rename.editingId === row.localId
  const busy = pendingId !== null && pendingId === row.localId

  const canRename = isMine && !row.isQwerty
  const renderName = (): JSX.Element => {
    if (editing) {
      return (
        <input
          autoFocus
          type="text"
          value={rename.editLabel}
          onChange={(e) => rename.setEditLabel(e.target.value)}
          onBlur={() => void onRenameCommit(row.localId)}
          onKeyDown={(e) => onRenameKey(e, row.localId)}
          maxLength={100}
          className="w-full border-b border-edge bg-transparent px-1 text-sm text-content outline-none focus:border-accent"
          data-testid={`key-labels-rename-input-${row.localId}`}
        />
      )
    }
    if (canRename) {
      // Click-to-edit pattern matches FavoriteStoreContent: clicking
      // the label name itself opens the inline editor; no extra
      // Rename button is needed.
      return (
        <span
          className="text-content cursor-pointer"
          onClick={() => rename.startRename(row.localId, row.name)}
          data-testid={`key-labels-name-${row.localId}`}
        >
          {row.name}
        </span>
      )
    }
    return <span className="text-content">{row.name}</span>
  }

  const hubPostUrl = row.hubPostId && hubOrigin
    ? buildHubKeyLabelUrl(hubOrigin, row.hubPostId)
    : null
  const hasHubPost = !!row.hubPostId
  // Mirror FavoriteHubActions: show the Hub line for any row that has
  // a Hub affordance — uploaded posts (Open / Update / Remove for the
  // owner, Open-only for foreign downloads) and never-uploaded local
  // entries the user can push.
  const showHubLine = !row.isQwerty && (hasHubPost || isMine)

  return (
    <div
      className="flex rounded border border-edge bg-surface"
      draggable={isDraggable}
      onDragOver={isDraggable ? (e) => { e.preventDefault(); onDragOver(row.localId) } : undefined}
      onDrop={isDraggable ? (e) => { e.preventDefault() } : undefined}
      onDragStart={isDraggable ? (e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', '')
        onDragStart(row.localId)
      } : undefined}
      onDragEnd={isDraggable ? () => { void onDragEnd() } : undefined}
      data-testid={`key-labels-row-${row.localId}`}
    >
      {/* Grip column spans the full card height so the user can grab
          the row anywhere along the left edge — not just the icon. */}
      <span
        className={`flex w-7 shrink-0 items-center justify-center ${
          isDraggable ? 'cursor-grab' : ''
        }`}
        aria-hidden="true"
      >
        {isDraggable
          ? <GripVertical className="text-content-muted" size={14} />
          : null}
      </span>
      <div className="flex-1 min-w-0 px-1 py-2">
        <div className="flex items-center gap-3">
          <span className="flex-1 min-w-0 truncate">{renderName()}</span>
          <span className="w-40 truncate text-content-secondary">{row.author}</span>
          {/* Fixed-width slot keeps the Author column aligned across
              every row — without it the QWERTY row's empty actions
              area collapses to 0 px and the "pipette" label drifts
              right relative to the other rows. */}
          <span className="min-w-[6rem] text-right whitespace-nowrap">
            {row.isQwerty ? null : (
              <InstalledActions
                localId={row.localId}
                busy={busy}
                confirming={confirmDeleteId === row.localId}
                onExport={() => void onExport(row.localId)}
                onAskDelete={() => setConfirmDeleteId(row.localId)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onConfirmDelete={() => void onDelete(row.localId)}
              />
            )}
          </span>
        </div>
        {showHubLine ? (
          <div
            className="mt-2 flex items-center gap-3 pr-1"
            data-testid={`key-labels-hub-row-${row.localId}`}
          >
            {/* Left slot is always present (even when the badge is
                null) so HubLineActions stays anchored to the right
                edge. Without `flex-1` here a foreign-download row
                with only the Open link would collapse left. */}
            <span className="flex-1 min-w-0">
              <ResultBadge result={lastResult} rowId={row.localId} />
            </span>
            <HubLineActions
              localId={row.localId}
              hubPostUrl={hubPostUrl}
              hasHubPost={hasHubPost}
              isMine={isMine}
              busy={busy}
              hubCanWrite={hubCanWrite}
              confirmingRemove={confirmRemoveId === row.localId}
              onOpenInBrowser={() => {
                if (hubPostUrl) void window.vialAPI.openExternal(hubPostUrl)
              }}
              onUpload={() => void onUpload(row.localId)}
              onUpdate={() => void onUpdate(row.localId)}
              onAskRemove={() => setConfirmRemoveId(row.localId)}
              onCancelRemove={() => setConfirmRemoveId(null)}
              onConfirmRemove={() => void onRemove(row.localId)}
            />
          </div>
        ) : (
          // QWERTY (and any other no-action rows): keep the spacer so
          // the card height matches Hub-aware rows, and surface the
          // result badge on the left edge when one applies.
          <div className="mt-2 flex h-[18px] items-center pr-1">
            <ResultBadge result={lastResult} rowId={row.localId} />
          </div>
        )}
      </div>
    </div>
  )
}

interface ResultBadgeProps {
  result: { id: string; kind: 'success' | 'error'; message: string } | null
  rowId: string
}

/**
 * Inline confirmation badge: "Saved" / "Uploaded" / "Updated" /
 * "Removed" or the localized error message after a Hub or local
 * mutation completes. Mirrors the favorite/layout-store hub-result
 * pill so feedback is consistent across stores.
 */
function ResultBadge({ result, rowId }: ResultBadgeProps): JSX.Element | null {
  if (!result || result.id !== rowId) return null
  return (
    <span
      className={`text-[11px] font-medium ${result.kind === 'success' ? 'text-accent' : 'text-rose-600'}`}
      data-testid={`key-labels-result-${rowId}`}
    >
      {result.message}
    </span>
  )
}

interface HubLineActionsProps {
  localId: string
  hubPostUrl: string | null
  hasHubPost: boolean
  isMine: boolean
  busy: boolean
  hubCanWrite: boolean
  /** True when this row is in the inline "Confirm Remove? Cancel" state. */
  confirmingRemove: boolean
  onOpenInBrowser: () => void
  onUpload: () => void
  onUpdate: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}

function HubLineActions({
  localId,
  hubPostUrl,
  hasHubPost,
  isMine,
  busy,
  hubCanWrite,
  confirmingRemove,
  onOpenInBrowser,
  onUpload,
  onUpdate,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: HubLineActionsProps): JSX.Element {
  const { t } = useTranslation()
  // Inline confirm pattern matches FavoriteHubActions / LayoutStoreHubActions:
  // first click on Remove swaps the row's actions for "Confirm | Cancel".
  // Wording is shared via the existing `hub.confirmRemove` / `common.cancel`
  // keys so all three Hub-aware editors stay in lockstep.
  if (confirmingRemove && hasHubPost && isMine) {
    return (
      <span className="inline-flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !hubCanWrite}
          onClick={onConfirmRemove}
          className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
          data-testid={`key-labels-confirm-remove-${localId}`}
        >
          {t('hub.confirmRemove')}
        </button>
        <button
          type="button"
          onClick={onCancelRemove}
          className="text-xs text-content-secondary hover:underline"
          data-testid={`key-labels-cancel-remove-${localId}`}
        >
          {t('common.cancel')}
        </button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-3">
      {hasHubPost && hubPostUrl && (
        <a
          href={hubPostUrl}
          onClick={(e) => { e.preventDefault(); onOpenInBrowser() }}
          className="text-xs font-medium text-accent hover:underline"
          data-testid={`key-labels-open-${localId}`}
        >
          {t('hub.openInBrowser')}
        </a>
      )}
      {hasHubPost && isMine && (
        <button
          type="button"
          disabled={busy || !hubCanWrite}
          onClick={onUpdate}
          className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
          data-testid={`key-labels-update-${localId}`}
        >
          {t('keyLabels.actionUpdate')}
        </button>
      )}
      {hasHubPost && isMine && (
        <button
          type="button"
          disabled={busy || !hubCanWrite}
          onClick={onAskRemove}
          className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
          data-testid={`key-labels-remove-${localId}`}
        >
          {t('keyLabels.actionRemove')}
        </button>
      )}
      {!hasHubPost && isMine && (
        <button
          type="button"
          disabled={busy || !hubCanWrite}
          onClick={onUpload}
          className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
          data-testid={`key-labels-upload-${localId}`}
        >
          {t('keyLabels.actionUpload')}
        </button>
      )}
    </span>
  )
}

interface InstalledActionsProps {
  localId: string
  busy: boolean
  confirming: boolean
  onExport: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

function InstalledActions({
  localId,
  busy,
  confirming,
  onExport,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: InstalledActionsProps): JSX.Element {
  const { t } = useTranslation()
  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirmDelete}
          className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
          data-testid={`key-labels-confirm-delete-${localId}`}
        >
          {t('common.confirmDelete')}
        </button>
        <button
          type="button"
          onClick={onCancelDelete}
          className="text-xs text-content-secondary hover:underline"
        >
          {t('common.cancel')}
        </button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={onExport}
        className="text-xs text-content-secondary hover:underline disabled:opacity-50"
        data-testid={`key-labels-export-${localId}`}
      >
        {t('keyLabels.actionExport')}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onAskDelete}
        className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
        data-testid={`key-labels-delete-${localId}`}
      >
        {t('keyLabels.actionDelete')}
      </button>
    </span>
  )
}

interface HubTableProps {
  rows: HubRow[]
  hubSearched: boolean
  pendingId: string | null
  hubOrigin: string
  onDownload: (hubPostId: string) => void | Promise<void>
}

function HubTable({ rows, hubSearched, pendingId, hubOrigin, onDownload }: HubTableProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 text-sm">
      {rows.map((row) => {
        const busy = pendingId === row.hubPostId
        const openUrl = hubOrigin ? buildHubKeyLabelUrl(hubOrigin, row.hubPostId) : null
        return (
          <div
            key={row.reactKey}
            className="flex items-center gap-3 rounded border border-edge bg-surface px-3 py-2"
          >
            <span className="flex-1 min-w-0 truncate text-content">{row.name}</span>
            <span className="w-40 truncate text-content-secondary">{row.author}</span>
            <span className="inline-flex items-center gap-3 whitespace-nowrap">
              {openUrl && (
                <a
                  href={openUrl}
                  onClick={(e) => {
                    e.preventDefault()
                    void window.vialAPI.openExternal(openUrl)
                  }}
                  className="text-xs font-medium text-accent hover:underline"
                  data-testid={`key-labels-hub-open-${row.hubPostId}`}
                >
                  {t('hub.openInBrowser')}
                </a>
              )}
              {row.alreadyInstalled ? (
                <span className="text-xs text-content-muted">
                  {t('keyLabels.alreadyInstalled')}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDownload(row.hubPostId)}
                  className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                  data-testid={`key-labels-download-${row.hubPostId}`}
                >
                  {t('keyLabels.actionDownload')}
                </button>
              )}
            </span>
          </div>
        )
      })}
      {rows.length === 0 && (
        <div className="py-6 text-center text-content-secondary">
          {hubSearched ? (
            t('keyLabels.hubEmpty')
          ) : (
            <Trans
              i18nKey="keyLabels.hubInitial"
              components={{
                hub: hubOrigin ? (
                  <a
                    href={hubOrigin}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.vialAPI.openExternal(hubOrigin)
                    }}
                    className="text-accent hover:underline"
                    data-testid="key-labels-hub-initial-link"
                  />
                ) : (
                  <span />
                ),
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Build rows directly from the store metas. The main-side
 * `ensureQwertyEntry` guarantees a QWERTY entry exists, so QWERTY
 * participates in the same drag / sync ordering as every other label.
 * Newly downloaded labels arrive at the end of `metas` (saveRecord
 * appends), drag reorders persist via `KEY_LABEL_STORE_REORDER`.
 */
function buildInstalledRows(metas: KeyLabelMeta[]): InstalledRow[] {
  return metas.map((meta) => ({
    reactKey: `local:${meta.id}`,
    localId: meta.id,
    hubPostId: meta.hubPostId ?? null,
    name: meta.name,
    // The Author column shows the cached Hub `uploader_name`. Empty
    // for never-uploaded local imports.
    author: meta.uploaderName ?? '',
    isQwerty: meta.id === QWERTY_ID,
    meta,
  }))
}

/**
 * Re-order rows according to the live drag order. QWERTY is treated
 * the same as any other row (the user can drag it anywhere). Any row
 * that is not in the override list — typically a label that arrived
 * mid-drag from a remote sync — keeps its underlying meta position
 * behind the explicitly-ordered prefix so we never silently drop one.
 */
function applyDragOrder(rows: InstalledRow[], order: string[] | null): InstalledRow[] {
  if (!order) return rows
  const byId = new Map<string, InstalledRow>()
  for (const row of rows) byId.set(row.localId, row)
  const out: InstalledRow[] = []
  for (const id of order) {
    const row = byId.get(id)
    if (!row) continue
    out.push(row)
    byId.delete(id)
  }
  for (const row of rows) {
    if (byId.has(row.localId)) out.push(row)
  }
  return out
}

function buildHubRows(items: HubKeyLabelItem[], metas: KeyLabelMeta[]): HubRow[] {
  const localNames = new Set<string>(['qwerty'])
  for (const m of metas) localNames.add(m.name.toLowerCase())
  return items
    .map((item) => ({
      reactKey: `hub:${item.id}`,
      hubPostId: item.id,
      name: item.name,
      author: item.uploader_name ?? '',
      alreadyInstalled: localNames.has(item.name.toLowerCase()),
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
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
