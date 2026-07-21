// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installed/Hub tab row + table components for KeyLabelsModal, split
// out per file-splitting.md (KeyLabelsModal.tsx exceeded the 750-line
// "split immediately" threshold once Phase 2/3 added the sort button,
// Author/Updated semantics, and cascade delete). Converged onto the
// shared PackHubActions/PackDeleteActions in the Phase-3 follow-up
// review, once the asymmetries that originally kept Key Labels'
// HubLineActions/InstalledActions separate had all dissolved (see
// `canWrite`/`hideOthersWhileConfirmingRemove` in PackHubActions.tsx
// for the two that remained real and got promoted to opt-in props).

import { useTranslation } from 'react-i18next'
import { GripVertical } from 'lucide-react'
import { ICON_SM, PACK_TYPE_TAG_WRITABLE, PACK_TYPE_TAG_VIEW } from '../../constants/ui-tokens'
import type { useInlineRename } from '../../hooks/useInlineRename'
import { formatDateTime } from '../editors/store-modal-shared'
import { buildHubKeyLabelUrl, HUB_CATEGORY } from '../../../shared/hub-urls'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'
import { hasUpdate, type HubFreshnessEntry } from '../../hooks/useHubFreshness'
import { PackHubEmptyState } from '../pack-modal/PackHubEmptyState'
import { PackListRow } from '../pack-modal/PackListRow'
import { PackNameCell } from '../pack-modal/PackNameCell'
import { PackResultBadge } from '../pack-modal/PackResultBadge'
import { PackDeleteActions } from '../pack-modal/PackDeleteActions'
import { PackHubActions } from '../pack-modal/PackHubActions'
import { isOwnPack } from '../pack-modal/ownership'
import type { PackActionResult } from '../pack-modal/pack-modal-types'

export interface InstalledRow {
  reactKey: string
  localId: string
  hubPostId: string | null
  name: string
  author: string
  isQwerty: boolean
  /** True when this pack can bulk-rewrite the keymap — the same
   *  `keymapApplicable && buildKeymapRewriteTable(map).ok` predicate
   *  `useDevicePrefs.remapKind` uses for the active pack, re-derived
   *  per row here (see `KeyLabelsModal.isKeymapWritable`). Drives the
   *  "Keymap Write" / "View Only" type label at the left end of the
   *  second line. */
  keymapWritable: boolean
  meta?: KeyLabelMeta
}

export interface HubRow {
  reactKey: string
  hubPostId: string
  name: string
  author: string
  /** True when a local entry already covers this hub item (by name, case-insensitive). */
  alreadyInstalled: boolean
}

export interface InstalledTableProps {
  rows: InstalledRow[]
  pendingId: string | null
  /** True while a multi-file import batch is in flight — locks every
   *  row action, rename and drag so the list can't be mutated out from
   *  under the batch's own placement/reorder call. Wired the same way
   *  `pendingId` already gates a single op. */
  importing: boolean
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  confirmRemoveId: string | null
  setConfirmRemoveId: (id: string | null) => void
  lastResult: PackActionResult | PackActionResult[] | null
  rename: ReturnType<typeof useInlineRename<string>>
  currentDisplayName: string | null
  hubCanWrite: boolean
  hubOrigin: string
  hubFreshness: Map<string, HubFreshnessEntry>
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>, id: string) => void
  onRenameCommit: (id: string) => void | Promise<void>
  onUpload: (id: string) => void | Promise<void>
  onUpdate: (id: string) => void | Promise<void>
  onSync: (id: string) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onExport: (id: string) => void | Promise<void>
  onDragStart: (id: string) => void
  onDragOver: (overId: string) => void
  onDragEnd: () => void | Promise<void>
}

export function InstalledTable(props: InstalledTableProps): JSX.Element {
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
  importing,
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
  onSync,
  onRemove,
  onDelete,
  onExport,
  onDragStart,
  onDragOver,
  onDragEnd,
  hubOrigin,
  hubFreshness,
}: InstalledRowViewProps): JSX.Element {
  const { t } = useTranslation()
  const isMine = isOwnPack(row.hubPostId, row.author, currentDisplayName)
  const editing = rename.editingId === row.localId
  const busy = (pendingId !== null && pendingId === row.localId) || importing
  const freshness = hubFreshness.get(row.localId)
  const hasUpdateAvailable = hasUpdate(freshness, row.meta?.hubUpdatedAt)
  const hubRemoved = !!freshness && freshness.removed

  const canRename = isMine && !row.isQwerty && !importing

  const hubPostUrl = row.hubPostId && hubOrigin
    ? buildHubKeyLabelUrl(hubOrigin, row.hubPostId)
    : null
  const hasHubPost = !!row.hubPostId
  // Mirror FavoriteHubActions: show the Hub line for any row that has
  // a Hub affordance — uploaded posts (Open / Update / Remove for the
  // owner, Open-only for foreign downloads) and never-uploaded local
  // entries the user can push.
  const showHubLine = !row.isQwerty && (hasHubPost || isMine)
  const showOpen = !!hubPostUrl
  const showUpload = !hasHubPost && isMine
  const showUpdateRemove = hasHubPost && isMine
  const showSync = hasHubPost && !isMine

  // Type label: "Keymap Write" for a pack that can bulk-rewrite the
  // keymap, "View Only" for a display-only pack (including QWERTY,
  // whose map is never `keymapApplicable`). Lives at the left end of
  // the second line rather than under the name, so it reads alongside
  // the row's other per-pack metadata (badge/Hub actions) instead of
  // stretching the name block to two lines. Colors come from
  // `PACK_TYPE_TAG_WRITABLE`/`PACK_TYPE_TAG_VIEW` (ui-tokens.ts), shared
  // with the footer select's own tag (UpwardSelect.tsx).
  const typeLabelNode = (
    <span
      className={`shrink-0 whitespace-nowrap text-xs ${row.keymapWritable ? PACK_TYPE_TAG_WRITABLE : PACK_TYPE_TAG_VIEW}`}
      data-testid={`key-labels-type-${row.localId}`}
    >
      {row.keymapWritable ? t('keyLabels.typeKeymapWrite') : t('keyLabels.typeViewOnly')}
    </span>
  )

  return (
    <PackListRow
      testid={`key-labels-row-${row.localId}`}
      shape="sideColumn"
      draggable={!importing}
      onDragStart={() => onDragStart(row.localId)}
      onDragOver={() => onDragOver(row.localId)}
      onDragEnd={() => { void onDragEnd() }}
      sideColumn={
        // Grip column spans the full card height so the user can grab
        // the row anywhere along the left edge — not just the icon.
        <span className="flex w-7 shrink-0 items-center justify-center cursor-grab" aria-hidden="true">
          <GripVertical className="text-content-muted" size={ICON_SM} />
        </span>
      }
      name={
        <span className="flex-1 min-w-0 truncate">
          <PackNameCell
            name={row.name}
            editing={editing}
            canRename={canRename}
            editLabel={rename.editLabel}
            onEditLabelChange={rename.setEditLabel}
            onBlur={() => void onRenameCommit(row.localId)}
            onKeyDown={(e) => onRenameKey(e, row.localId)}
            onStartRename={() => rename.startRename(row.localId, row.name)}
            maxLength={100}
            inputTestid={`key-labels-rename-input-${row.localId}`}
            nameTestid={`key-labels-name-${row.localId}`}
          />
        </span>
      }
      columns={
        <>
          <span className="w-32 truncate text-xs text-content-secondary">{row.author}</span>
          {/* Show Hub-side `updated_at` so the column matches Hub's
              own display. Blank for QWERTY, never-uploaded local
              entries, and legacy rows that predate this field. The
              "(removed)" overrides the timestamp when the bulk
              freshness check confirms the post is gone from Hub.
              `text-content-muted` (not `-secondary`) matches Language
              Packs / Theme Packs' Updated column color. */}
          <span
            className={`w-32 text-xs whitespace-nowrap ${hubRemoved ? 'text-rose-600' : 'text-content-muted'}`}
            data-testid={`key-labels-updated-at-${row.localId}`}
          >
            {renderUpdatedCell({ hubRemoved, hubUpdatedAt: row.meta?.hubUpdatedAt, t })}
          </span>
        </>
      }
      actions={
        // Fixed-width slot keeps the Author column aligned across
        // every row — without it the QWERTY row's empty actions
        // area collapses to 0 px and the "pipette" label drifts
        // right relative to the other rows.
        <span className="min-w-24 text-right whitespace-nowrap">
          {row.isQwerty ? null : (
            <PackDeleteActions
              id={row.localId}
              testidPrefix="key-labels"
              busy={busy}
              confirming={confirmDeleteId === row.localId}
              deleteLabel={t('keyLabels.actionDelete')}
              onExport={() => onExport(row.localId)}
              onAskDelete={() => setConfirmDeleteId(row.localId)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onConfirmDelete={() => onDelete(row.localId)}
            />
          )}
        </span>
      }
      secondLine={
        showHubLine ? (
          <div
            className="mt-2 flex items-center gap-3"
            data-testid={`key-labels-hub-row-${row.localId}`}
          >
            {typeLabelNode}
            {/* Left slot is always present (even when the badge is
                null) so PackHubActions stays anchored to the right
                edge. Without `flex-1` here a foreign-download row
                with only the Open link would collapse left. */}
            <span className="flex-1 min-w-0">
              <PackResultBadge result={lastResult} rowId={row.localId} testid={`key-labels-result-${row.localId}`} />
            </span>
            <PackHubActions
              id={row.localId}
              testidPrefix="key-labels"
              busy={busy}
              showOpen={showOpen}
              onOpen={() => { if (hubPostUrl) void window.vialAPI.openExternal(hubPostUrl) }}
              showUpload={showUpload}
              onUpload={() => onUpload(row.localId)}
              showSync={showSync}
              hasUpdateAvailable={hasUpdateAvailable}
              onSync={() => onSync(row.localId)}
              showUpdateRemove={showUpdateRemove}
              confirmingRemove={confirmRemoveId === row.localId}
              onUpdate={() => onUpdate(row.localId)}
              onAskRemove={() => setConfirmRemoveId(row.localId)}
              onCancelRemove={() => setConfirmRemoveId(null)}
              onConfirmRemove={() => onRemove(row.localId)}
              canWrite={hubCanWrite}
              hideOthersWhileConfirmingRemove
            />
          </div>
        ) : (
          // QWERTY (and any other no-action rows): keep the spacer so
          // the card height matches Hub-aware rows, and surface the
          // type label and result badge on the left edge.
          <div className="mt-2 flex h-4.5 items-center gap-3">
            {typeLabelNode}
            <PackResultBadge result={lastResult} rowId={row.localId} testid={`key-labels-result-${row.localId}`} />
          </div>
        )
      }
    />
  )
}

export interface HubTableProps {
  rows: HubRow[]
  hubSearched: boolean
  pendingId: string | null
  /** Defensive: the Hub tab isn't meant to be operable mid-import
   *  either, even though its own actions don't touch the Installed
   *  list directly. */
  importing: boolean
  hubOrigin: string
  onDownload: (hubPostId: string) => void | Promise<void>
}

export function HubTable({ rows, hubSearched, pendingId, importing, hubOrigin, onDownload }: HubTableProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 text-sm">
      {rows.map((row) => {
        const busy = pendingId === row.hubPostId || importing
        const openUrl = hubOrigin ? buildHubKeyLabelUrl(hubOrigin, row.hubPostId) : null
        return (
          <div
            key={row.reactKey}
            className="flex items-center gap-3 rounded border border-edge bg-surface px-3 py-2"
          >
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-content">{row.name}</span>
            <span className="w-40 truncate text-xs text-content-secondary">{row.author}</span>
            {/* Fixed-width slot keeps the Author column anchored across rows
                — without it the "Open Download" vs "Open Installed" width
                difference (different glyph widths + font-medium vs regular)
                shifts the uploader name horizontally between rows. */}
            <span className="inline-flex w-32 items-center justify-end gap-3 whitespace-nowrap">
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
                  {t('common.installed')}
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
        <PackHubEmptyState
          as="div"
          className="py-4 text-center text-sm text-content-muted"
          hubSearched={hubSearched}
          emptyText={t('keyLabels.hubEmpty')}
          hubOrigin={hubOrigin}
          category={HUB_CATEGORY.KEY_LABELS}
          initialLinkTestid="key-labels-hub-initial-link"
        />
      )}
    </div>
  )
}

/**
 * Picks the text shown in the Updated column. The three states are
 * mutually exclusive: removed > has-timestamp > unknown. Extracted
 * from the row JSX so the column is one expression and the precedence
 * is explicit.
 */
function renderUpdatedCell(args: {
  hubRemoved: boolean
  hubUpdatedAt: string | undefined
  t: (key: string) => string
}): string {
  if (args.hubRemoved) return args.t('keyLabels.hubRemoved')
  if (args.hubUpdatedAt) return formatDateTime(args.hubUpdatedAt)
  return ''
}
