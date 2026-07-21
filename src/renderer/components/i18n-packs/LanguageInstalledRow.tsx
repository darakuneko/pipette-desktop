// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installed-tab row components for LanguagePacksModal, split out per
// file-splitting.md (LanguagePacksModal.tsx alone exceeded the 750-line
// "split immediately" threshold once Phase 3 added the Author column
// and isMine gating). No behavior change — this is a pure move.

import { useTranslation } from 'react-i18next'
import { Circle, CheckCircle2, GripVertical } from 'lucide-react'
import { ICON_SM, ICON_XL } from '../../constants/ui-tokens'
import type { useInlineRename } from '../../hooks/useInlineRename'
import { formatTimestamp } from '../../utils/format-timestamp'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'
import { hasUpdate, type HubFreshnessEntry } from '../../hooks/useHubFreshness'
import { PackListRow } from '../pack-modal/PackListRow'
import { PackNameCell } from '../pack-modal/PackNameCell'
import { PackResultBadge } from '../pack-modal/PackResultBadge'
import { PackDeleteActions } from '../pack-modal/PackDeleteActions'
import { PackHubActions } from '../pack-modal/PackHubActions'
import { PackHubResultRow } from '../pack-modal/PackHubResultRow'
import { isOwnPack } from '../pack-modal/ownership'
import type { PackActionResult } from '../pack-modal/pack-modal-types'

export interface InstalledRow {
  reactKey: string
  internalId: string
  packId: string | null
  hubPostId: string | null
  name: string
  version: string
  /** ISO 8601 timestamp shown in the Updated column. Builtin English
   * uses the renderer's build time; imported packs use the Hub-side
   * `hubUpdatedAt` (blank when never uploaded), matching Key Labels'
   * Updated-column semantics — not the local `meta.updatedAt`. */
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

export interface HubRow {
  reactKey: string
  hubPostId: string
  name: string
  version: string
  uploaderName: string
  alreadyInstalled: boolean
}

export interface LanguageInstalledRowProps {
  row: InstalledRow
  pendingId: string | null
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  confirmRemoveId: string | null
  setConfirmRemoveId: (id: string | null) => void
  lastResult: PackActionResult | PackActionResult[] | null
  currentDisplayName: string | null
  hubCanWrite: boolean
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
  onDragStart: () => void
  onDragOver: () => void
  onDragEnd: () => void
}

export function LanguageInstalledRow({
  row,
  pendingId,
  confirmDeleteId,
  setConfirmDeleteId,
  confirmRemoveId,
  setConfirmRemoveId,
  lastResult,
  currentDisplayName,
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
  onDragStart,
  onDragOver,
  onDragEnd,
}: LanguageInstalledRowProps): JSX.Element {
  const { t } = useTranslation()
  const busy = pendingId !== null && (pendingId === row.packId || pendingId === row.hubPostId)
  const freshness = row.packId ? hubFreshness.get(row.packId) : undefined
  const hasUpdateAvailable = hasUpdate(freshness, row.meta?.hubUpdatedAt)
  const hubRemoved = !!freshness && freshness.removed
  const editing = !!row.packId && rename.editingId === row.packId
  const canRename = !row.isBuiltin && !!row.packId
  const updatedAt = row.updatedAt ? formatTimestamp(row.updatedAt) : ''
  const linkClass = 'text-xs font-medium hover:underline disabled:opacity-50'

  // Unlike Theme Packs, the Open button shows whenever `hubPostId` is
  // set, without waiting on `hubOrigin` — `onOpen` itself no-ops until
  // the origin has loaded (see `handleOpen` in LanguagePacksModal).
  const showOpen = Boolean(row.hubPostId)
  const isMine = isOwnPack(row.hubPostId, row.uploaderName, currentDisplayName)
  const showUpload = !row.isBuiltin && !row.hubPostId && hubCanWrite
  const showHubPair = !row.isBuiltin && Boolean(row.hubPostId)
  const showUpdateRemove = showHubPair && isMine && hubCanWrite
  const showSync = showHubPair && !showUpdateRemove

  // Built-in English is a real store entry (see `ensureBuiltinEnglishEntry`
  // in main/i18n-pack-store.ts) and drags like any other row — except
  // during the brief pre-load window before the store has materialised
  // it, when `row.packId` is still null and there is no real id yet to
  // persist an order against.
  const canDrag = row.packId !== null

  return (
    <PackListRow
      testid={`language-packs-row-${row.reactKey}`}
      active={row.active}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      sideColumn={canDrag ? (
        <span
          className="flex w-7 shrink-0 items-center justify-center cursor-grab"
          aria-hidden="true"
          data-testid={`language-packs-grip-${row.reactKey}`}
        >
          <GripVertical className="text-content-muted" size={ICON_SM} />
        </span>
      ) : (
        // Pre-load fallback only: no real id yet, so an inert spacer
        // keeps the name column aligned with the draggable rows below it.
        <span className="w-7 shrink-0" aria-hidden="true" />
      )}
      leadingControl={
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
      }
      name={
        <PackNameCell
          name={row.name}
          editing={editing}
          canRename={canRename}
          editLabel={rename.editLabel}
          onEditLabelChange={rename.setEditLabel}
          onBlur={() => void onRenameCommit(row.packId as string)}
          onKeyDown={(e) => onRenameKey(e, row.packId as string)}
          onStartRename={() => rename.startRename(row.packId as string, row.name)}
          maxLength={64}
          inputTestid={`language-packs-rename-input-${row.reactKey}`}
          nameTestid={`language-packs-name-${row.reactKey}`}
        />
      }
      columns={
        <>
          <span
            className="w-32 truncate text-xs text-content-secondary"
            data-testid={`language-packs-author-${row.reactKey}`}
          >
            {row.uploaderName}
          </span>
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
        </>
      }
      actions={
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
            <PackDeleteActions
              id={row.reactKey}
              testidPrefix="language-packs"
              busy={busy}
              confirming={confirmDeleteId === row.reactKey}
              deleteLabel={t('keyLabels.actionDelete')}
              onExport={() => onExport(row)}
              onAskDelete={() => setConfirmDeleteId(row.reactKey)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onConfirmDelete={() => onDelete(row)}
            />
          )}
        </div>
      }
      badge={<PackResultBadge result={lastResult} rowId={row.packId ?? row.hubPostId ?? ''} testid={`language-packs-result-${row.reactKey}`} />}
      hubActions={
        <PackHubActions
          id={row.reactKey}
          testidPrefix="language-packs"
          busy={busy}
          showOpen={showOpen}
          onOpen={() => onOpen(row)}
          showUpload={showUpload}
          onUpload={() => onUpload(row)}
          showSync={showSync}
          hasUpdateAvailable={hasUpdateAvailable}
          onSync={() => onSync(row)}
          showUpdateRemove={showUpdateRemove}
          confirmingRemove={confirmRemoveId === row.reactKey}
          onUpdate={() => onUpdate(row)}
          onAskRemove={() => setConfirmRemoveId(row.reactKey)}
          onCancelRemove={() => setConfirmRemoveId(null)}
          onConfirmRemove={() => onRemove(row)}
        />
      }
    />
  )
}

export interface LanguageHubRowProps {
  row: HubRow
  pendingId: string | null
  onDownload: (postId: string) => void
}

export function LanguageHubRow({ row, pendingId, onDownload }: LanguageHubRowProps): JSX.Element {
  return (
    <PackHubResultRow
      hubPostId={row.hubPostId}
      testidPrefix="language-packs"
      name={row.name}
      version={row.version}
      uploaderName={row.uploaderName}
      alreadyInstalled={row.alreadyInstalled}
      busy={pendingId === row.hubPostId}
      onDownload={() => onDownload(row.hubPostId)}
    />
  )
}
