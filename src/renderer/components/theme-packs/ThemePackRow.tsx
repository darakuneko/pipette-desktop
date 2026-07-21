// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { Circle, CheckCircle2, GripVertical } from 'lucide-react'
import { ICON_SM, ICON_XL } from '../../constants/ui-tokens'
import type { useInlineRename } from '../../hooks/useInlineRename'
import type { ThemePackMeta } from '../../../shared/types/theme-store'
import { formatTimestamp } from '../../utils/format-timestamp'
import { buildHubThemePackUrl } from '../../../shared/hub-urls'
import { hasUpdate, type HubFreshnessEntry } from '../../hooks/useHubFreshness'
import type { ThemeSelection } from '../../../shared/types/app-config'
import { PackListRow } from '../pack-modal/PackListRow'
import { PackNameCell } from '../pack-modal/PackNameCell'
import { PackResultBadge } from '../pack-modal/PackResultBadge'
import { PackDeleteActions } from '../pack-modal/PackDeleteActions'
import { PackHubActions } from '../pack-modal/PackHubActions'
import { isOwnPack } from '../pack-modal/ownership'
import type { PackActionResult } from '../pack-modal/pack-modal-types'

export interface PackRowProps {
  meta: ThemePackMeta
  isActive: boolean
  pendingId: string | null
  /** True while a multi-file import batch is in flight — locks every
   *  row action, rename, drag and the select control so the list can't
   *  be mutated out from under the batch's own placement/reorder call.
   *  Wired the same way `pendingId` already gates a single op. */
  importing: boolean
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  rename: ReturnType<typeof useInlineRename<string>>
  onRenameKey: (event: React.KeyboardEvent<HTMLInputElement>, id: string) => void
  onRenameCommit: (id: string) => void | Promise<void>
  onSelect: (selection: ThemeSelection) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
  hubOrigin: string
  currentDisplayName: string | null
  hubCanWrite: boolean
  hubFreshness: Map<string, HubFreshnessEntry>
  lastResult: PackActionResult | PackActionResult[] | null
  confirmRemoveId: string | null
  setConfirmRemoveId: (id: string | null) => void
  onUpload: (id: string) => void
  onUpdate: (id: string) => void
  onSync: (id: string) => void
  onRemove: (id: string) => void
  onDragStart: () => void
  onDragOver: () => void
  onDragEnd: () => void
}

export function PackRow({
  meta,
  isActive,
  pendingId,
  importing,
  confirmDeleteId,
  setConfirmDeleteId,
  rename,
  onRenameKey,
  onRenameCommit,
  onSelect,
  onExport,
  onDelete,
  hubOrigin,
  currentDisplayName,
  hubCanWrite,
  hubFreshness,
  lastResult,
  confirmRemoveId,
  setConfirmRemoveId,
  onUpload,
  onUpdate,
  onSync,
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnd,
}: PackRowProps): JSX.Element {
  const { t } = useTranslation()
  const busy = pendingId === meta.id || importing
  const editing = rename.editingId === meta.id
  const isConfirmingDelete = confirmDeleteId === meta.id

  const freshness = hubFreshness.get(meta.id)
  const hasUpdateAvailable = hasUpdate(freshness, meta.hubUpdatedAt)
  const hubRemoved = !!freshness && freshness.removed
  const showOpen = Boolean(meta.hubPostId && hubOrigin)
  const isMine = isOwnPack(meta.hubPostId, meta.uploaderName ?? '', currentDisplayName)
  const showUpload = !meta.hubPostId && hubCanWrite
  const showHubPair = Boolean(meta.hubPostId)
  const showUpdateRemove = showHubPair && isMine && hubCanWrite
  const showSync = showHubPair && !showUpdateRemove

  return (
    <PackListRow
      testid={`theme-packs-row-${meta.id}`}
      active={isActive}
      draggable={!importing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      sideColumn={
        <span
          className="flex w-7 shrink-0 items-center justify-center cursor-grab"
          aria-hidden="true"
          data-testid={`theme-packs-grip-${meta.id}`}
        >
          <GripVertical className="text-content-muted" size={ICON_SM} />
        </span>
      }
      leadingControl={
        <button
          type="button"
          aria-label={t('themePacks.selectTheme', { name: meta.name })}
          className="shrink-0 text-content-muted hover:text-accent transition-colors disabled:opacity-50"
          onClick={() => onSelect(`pack:${meta.id}`)}
          disabled={busy}
          data-testid={`theme-packs-select-${meta.id}`}
        >
          {isActive ? (
            <CheckCircle2 size={ICON_XL} className="text-accent" aria-hidden="true" />
          ) : (
            <Circle size={ICON_XL} aria-hidden="true" />
          )}
        </button>
      }
      name={
        <PackNameCell
          name={meta.name}
          editing={editing}
          canRename={!importing}
          editLabel={rename.editLabel}
          onEditLabelChange={rename.setEditLabel}
          onBlur={() => void onRenameCommit(meta.id)}
          onKeyDown={(e) => onRenameKey(e, meta.id)}
          onStartRename={() => rename.startRename(meta.id, meta.name)}
          maxLength={64}
          inputTestid={`theme-packs-rename-input-${meta.id}`}
          nameTestid={`theme-packs-name-${meta.id}`}
        />
      }
      columns={
        <>
          <span
            className="w-32 truncate text-xs text-content-secondary"
            data-testid={`theme-packs-author-${meta.id}`}
          >
            {meta.uploaderName ?? ''}
          </span>
          <div
            className={`shrink-0 whitespace-nowrap text-xs ${hubRemoved ? 'text-rose-600' : 'text-content-muted'}`}
            data-testid={`theme-packs-timestamp-${meta.id}`}
          >
            {/* Hub-side timestamp, not the local modification time —
                blank for never-uploaded local entries and legacy rows
                that predate this field, matching Key Labels. */}
            {hubRemoved ? t('keyLabels.hubRemoved') : (meta.hubUpdatedAt ? formatTimestamp(meta.hubUpdatedAt) : '')}
          </div>
          <div className="shrink-0 whitespace-nowrap text-xs text-content-muted">
            {meta.version ? `v${meta.version}` : ''}
          </div>
        </>
      }
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <PackDeleteActions
            id={meta.id}
            testidPrefix="theme-packs"
            busy={busy}
            confirming={isConfirmingDelete}
            deleteLabel={t('common.delete')}
            onExport={() => onExport(meta.id)}
            onAskDelete={() => setConfirmDeleteId(meta.id)}
            onCancelDelete={() => setConfirmDeleteId(null)}
            onConfirmDelete={() => onDelete(meta.id)}
          />
        </div>
      }
      badge={<PackResultBadge result={lastResult} rowId={meta.id} testid={`theme-packs-result-${meta.id}`} />}
      hubActions={
        <PackHubActions
          id={meta.id}
          testidPrefix="theme-packs"
          busy={busy}
          showOpen={showOpen}
          onOpen={() => void window.vialAPI.openExternal(buildHubThemePackUrl(hubOrigin.replace(/\/$/, ''), meta.hubPostId as string))}
          showUpload={showUpload}
          onUpload={() => onUpload(meta.id)}
          showSync={showSync}
          hasUpdateAvailable={hasUpdateAvailable}
          onSync={() => onSync(meta.id)}
          showUpdateRemove={showUpdateRemove}
          confirmingRemove={confirmRemoveId === meta.id}
          onUpdate={() => onUpdate(meta.id)}
          onAskRemove={() => setConfirmRemoveId(meta.id)}
          onCancelRemove={() => setConfirmRemoveId(null)}
          onConfirmRemove={() => onRemove(meta.id)}
        />
      }
    />
  )
}
