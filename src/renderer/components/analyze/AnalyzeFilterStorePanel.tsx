// SPDX-License-Identifier: GPL-2.0-or-later
// Body of the Analyze pane's slide-in store panel. Visual structure
// (tab bar at top, save card with inline export buttons, SectionHeader
// + count badge, scrollable entries list) mirrors the keymap editor's
// LayoutStoreContent panel mode so the two surfaces feel like the same
// pattern. Self-contained because the analyze surface omits Hub uploads
// and the .vil/.c keymap-format buttons; threading those as optional
// props would dwarf the genuinely shared parts.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInlineRename } from '../../hooks/useInlineRename'
import {
  ACTION_BTN,
  CONFIRM_DELETE_BTN,
  DELETE_BTN,
  SectionHeader,
  formatDate,
} from '../editors/store-modal-shared'
import { FORMAT_BTN } from '../editors/layout-store-types'
import type { HubEntryResult } from '../editors/layout-store-types'
import type { AnalyzeFilterSnapshotMeta } from '../../../shared/types/analyze-filter-store'
import { AnalyzeFilterStoreHubRow } from './AnalyzeFilterStoreHubRow'

// Only one tab today — kept as a single-element tab bar for visual
// parity with the keymap editor's overlay and so the structure is
// ready when a Settings tab gets a real surface to render.
const TAB_BASE = 'flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2 border-b-accent text-content'

interface Props {
  /** Render the save body only when the user has picked a keyboard.
   * Without a uid we'd have nothing to scope saves to. */
  uidSelected: boolean
  entries: AnalyzeFilterSnapshotMeta[]
  saving: boolean
  loading: boolean
  /** When the user submits the save form. Returns the new entry id on
   * success, null on failure (so the caller can keep the input visible
   * for retry). */
  onSave: (label: string) => Promise<string | null>
  onLoad: (entryId: string) => Promise<boolean>
  onRename: (entryId: string, newLabel: string) => Promise<boolean>
  onDelete: (entryId: string) => Promise<boolean>
  /** Trigger the existing AnalyzeExportModal (current-state CSV export).
   * `null` when the page has nothing to export yet — the button hides
   * itself off the null check, so a separate "enabled" flag would be
   * redundant. */
  onExportCurrentCsv: (() => void) | null
  /** Apply a saved entry's filters and open the export modal in one
   * step. `null` when there's nothing to export — same null contract
   * as `onExportCurrentCsv`. */
  onExportEntryCsv: ((entryId: string) => void) | null
  /** Render the Hub action row under each entry (mirrors the keymap
   * save panel's pattern). `null` hides the row entirely (Hub feature
   * unavailable, no Google login, etc.). */
  hubActions: {
    hubOrigin?: string
    hubNeedsDisplayName?: boolean
    hubUploading?: string | null
    hubUploadResult?: HubEntryResult | null
    onUploadToHub?: (entryId: string) => void
    onUpdateOnHub?: (entryId: string) => void
    onRemoveFromHub?: (entryId: string) => void
  } | null
}

export function AnalyzeFilterStorePanel({
  uidSelected,
  entries,
  saving,
  loading,
  onSave,
  onLoad,
  onRename,
  onDelete,
  onExportCurrentCsv,
  onExportEntryCsv,
  hubActions,
}: Props) {
  const { t } = useTranslation()
  const [saveLabel, setSaveLabel] = useState('')
  const rename = useInlineRename<string>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmHubRemoveId, setConfirmHubRemoveId] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(savedTimerRef.current), [])

  const handleSaveSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = saveLabel.trim()
    if (saving || !trimmed) return
    const id = await onSave(trimmed)
    if (id) {
      setSaveLabel('')
      setShowSaved(true)
      clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000)
    }
  }

  const commitRename = async (entryId: string): Promise<void> => {
    const newLabel = rename.commitRename(entryId)
    if (newLabel) await onRename(entryId, newLabel)
  }

  const handleRenameKeyDown = async (e: React.KeyboardEvent, entryId: string): Promise<void> => {
    if (e.key === 'Enter') {
      await commitRename(entryId)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      rename.cancelRename()
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="analyze-filter-store-panel">
      <div role="tablist" className="flex shrink-0 border-b border-edge" data-testid="analyze-filter-store-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className={TAB_BASE}
          data-testid="analyze-filter-store-tab-save"
        >
          {t('analyzeFilterStore.tabSave')}
        </button>
      </div>

      {!uidSelected ? (
        <div className="p-4 text-xs text-content-muted">{t('analyzeFilterStore.selectKeyboard')}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <div className="shrink-0 rounded-lg border border-edge bg-surface/20 p-3">
              <form onSubmit={handleSaveSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={saveLabel}
                  onChange={(e) => setSaveLabel(e.target.value)}
                  placeholder={t('common.labelPlaceholder')}
                  maxLength={200}
                  className="flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
                  data-testid="analyze-filter-store-save-input"
                />
                <button
                  type="submit"
                  disabled={saving || !saveLabel.trim()}
                  className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                  data-testid="analyze-filter-store-save-submit"
                >
                  {t('common.save')}
                </button>
              </form>
              <div className="mt-2 flex items-center gap-1">
                {showSaved && (
                  <span className="text-[11px] font-medium text-emerald-500" data-testid="analyze-filter-store-saved-flash">
                    {t('common.saved')}
                  </span>
                )}
                {onExportCurrentCsv && (
                  <button
                    type="button"
                    onClick={onExportCurrentCsv}
                    className={`ml-auto ${FORMAT_BTN}`}
                    data-testid="analyze-filter-store-export-current-csv"
                  >
                    {t('analyzeFilterStore.csv')}
                  </button>
                )}
              </div>
            </div>

            <SectionHeader label={t('common.synced')} count={entries.length} />

            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="analyze-filter-store-list">
              {entries.length === 0 ? (
                <div className="py-6 text-center text-xs text-content-muted">
                  {t('analyzeFilterStore.empty')}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {entries.map((entry) => {
                    const isRenaming = rename.editingId === entry.id
                    const isConfirmingDelete = confirmDeleteId === entry.id
                    return (
                      <div
                        key={entry.id}
                        className={`rounded-lg border border-edge bg-surface/20 p-3 hover:border-content-muted/30 ${rename.confirmedId === entry.id ? 'confirm-flash' : ''}`}
                        data-testid={`analyze-filter-store-entry-${entry.id}`}
                      >
                        {/* Top row: label + action buttons */}
                        <div className="mb-1 flex items-center justify-between">
                          <div className="min-w-0 flex-1">
                            {isRenaming ? (
                              <input
                                type="text"
                                autoFocus
                                value={rename.editLabel}
                                onChange={(e) => rename.setEditLabel(e.target.value)}
                                onKeyDown={(e) => { void handleRenameKeyDown(e, entry.id) }}
                                onBlur={() => { void commitRename(entry.id) }}
                                maxLength={200}
                                className="w-full border-b border-edge bg-transparent px-1 text-sm font-semibold text-content outline-none focus:border-accent"
                                data-testid={`analyze-filter-store-rename-input-${entry.id}`}
                              />
                            ) : (
                              <div
                                className="cursor-pointer truncate text-sm font-semibold text-content"
                                onClick={() => rename.startRename(entry.id, entry.label)}
                                data-testid={`analyze-filter-store-entry-label-${entry.id}`}
                                title={entry.label}
                              >
                                {entry.label || t('common.noLabel')}
                              </div>
                            )}
                          </div>

                          <div className="ml-2 flex shrink-0 items-center gap-0.5">
                            {isConfirmingDelete ? (
                              <>
                                <button
                                  type="button"
                                  className={CONFIRM_DELETE_BTN}
                                  onClick={async () => {
                                    const ok = await onDelete(entry.id)
                                    if (ok) setConfirmDeleteId(null)
                                  }}
                                  data-testid={`analyze-filter-store-delete-confirm-${entry.id}`}
                                >
                                  {t('common.confirmDelete')}
                                </button>
                                <button
                                  type="button"
                                  className={ACTION_BTN}
                                  onClick={() => setConfirmDeleteId(null)}
                                  data-testid={`analyze-filter-store-delete-cancel-${entry.id}`}
                                >
                                  {t('common.cancel')}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className={ACTION_BTN}
                                  onClick={() => { void onLoad(entry.id) }}
                                  disabled={loading}
                                  data-testid={`analyze-filter-store-load-${entry.id}`}
                                >
                                  {t('common.load')}
                                </button>
                                <button
                                  type="button"
                                  className={DELETE_BTN}
                                  onClick={() => setConfirmDeleteId(entry.id)}
                                  data-testid={`analyze-filter-store-delete-${entry.id}`}
                                >
                                  {t('common.delete')}
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {entry.summary && (
                          <div
                            className="mb-1 truncate text-[11px] text-content-muted"
                            title={entry.summary}
                            data-testid={`analyze-filter-store-entry-summary-${entry.id}`}
                          >
                            {entry.summary}
                          </div>
                        )}

                        {/* Row 2: date + .csv export */}
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[11px] text-content-muted">
                            {formatDate(entry.savedAt)}
                          </span>
                          {onExportEntryCsv && (
                            <button
                              type="button"
                              className={FORMAT_BTN}
                              onClick={() => onExportEntryCsv(entry.id)}
                              disabled={loading}
                              data-testid={`analyze-filter-store-csv-${entry.id}`}
                            >
                              {t('analyzeFilterStore.csv')}
                            </button>
                          )}
                        </div>

                        {/* Row 3: Hub actions — mirrors LayoutStoreHubRow
                         * so the keymap save panel and the analyze save
                         * panel feel like the same surface. */}
                        {hubActions && (
                          <AnalyzeFilterStoreHubRow
                            entry={entry}
                            hubOrigin={hubActions.hubOrigin}
                            hubNeedsDisplayName={hubActions.hubNeedsDisplayName}
                            hubUploading={hubActions.hubUploading}
                            hubUploadResult={hubActions.hubUploadResult}
                            fileDisabled={loading}
                            confirmHubRemoveId={confirmHubRemoveId}
                            setConfirmHubRemoveId={setConfirmHubRemoveId}
                            onUploadToHub={hubActions.onUploadToHub}
                            onUpdateOnHub={hubActions.onUpdateOnHub}
                            onRemoveFromHub={hubActions.onRemoveFromHub}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
      )}
    </div>
  )
}
