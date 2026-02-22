// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { deserialize } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { KeycodeField } from './KeycodeField'
import { ModalCloseButton } from './ModalCloseButton'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'

interface Props {
  index: number
  entry: TapDanceEntry
  onSave: (index: number, entry: TapDanceEntry) => Promise<void>
  onClose: () => void
  isDummy?: boolean
}

const TAPPING_TERM_MIN = 0
const TAPPING_TERM_MAX = 10000

type KeycodeFieldName = 'onTap' | 'onHold' | 'onDoubleTap' | 'onTapHold'

function isConfigured(entry: TapDanceEntry): boolean {
  return entry.onTap !== 0 || entry.onHold !== 0 || entry.onDoubleTap !== 0 || entry.onTapHold !== 0
}

const keycodeFields: { key: KeycodeFieldName; labelKey: string }[] = [
  { key: 'onTap', labelKey: 'editor.tapDance.onTap' },
  { key: 'onHold', labelKey: 'editor.tapDance.onHold' },
  { key: 'onDoubleTap', labelKey: 'editor.tapDance.onDoubleTap' },
  { key: 'onTapHold', labelKey: 'editor.tapDance.onTapHold' },
]

export function TapDanceModal({ index, entry, onSave, onClose, isDummy }: Props) {
  const { t } = useTranslation()
  const [editedEntry, setEditedEntry] = useState<TapDanceEntry>(entry)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)
  const favStore = useFavoriteStore({
    favoriteType: 'tapDance',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as TapDanceEntry),
    enabled: !isDummy,
  })

  useEffect(() => {
    setEditedEntry(entry)
    setSelectedField(null)
    setPopoverState(null)
  }, [entry])

  useEffect(() => {
    if (!isDummy) {
      favStore.refreshEntries()
    }
  }, [isDummy, favStore.refreshEntries])

  const hasChanges = JSON.stringify(entry) !== JSON.stringify(editedEntry)

  const handleTappingTermChange = (value: string) => {
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const numValue = Math.max(TAPPING_TERM_MIN, Math.min(TAPPING_TERM_MAX, parsed))
    setEditedEntry((prev) => ({ ...prev, tappingTerm: numValue }))
  }

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!selectedField) return
      const code = deserialize(kc.qmkId)
      setEditedEntry((prev) => ({ ...prev, [selectedField]: code }))
      setSelectedField(null)
    },
    [selectedField],
  )

  const handleFieldDoubleClick = useCallback(
    (field: KeycodeFieldName, rect: DOMRect) => {
      if (!selectedField) return
      setPopoverState({ field, anchorRect: rect })
    },
    [selectedField],
  )

  const closePopover = useCallback(() => {
    setPopoverState(null)
  }, [])

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!popoverState) return
      const code = deserialize(kc.qmkId)
      setEditedEntry((prev) => ({ ...prev, [popoverState.field]: code }))
      closePopover()
      setSelectedField(null)
    },
    [popoverState, closePopover],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverState) return
      setEditedEntry((prev) => ({ ...prev, [popoverState.field]: code }))
      closePopover()
      setSelectedField(null)
    },
    [popoverState, closePopover],
  )

  const modalWidth = isDummy ? 'w-[800px]' : 'w-[950px]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="td-modal-backdrop"
      onClick={onClose}
    >
      <div
        className={`rounded-lg bg-surface-alt shadow-xl ${modalWidth} max-w-[90vw] h-[70vh] flex flex-col overflow-hidden`}
        data-testid="td-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {!selectedField && (
          <div className="px-6 pt-6 pb-4 flex items-center justify-between shrink-0">
            <h3 className="text-lg font-semibold">
              {t('editor.tapDance.editTitle', { index })}
            </h3>
            <ModalCloseButton testid="td-modal-close" onClick={onClose} />
          </div>
        )}

        {/* Split container */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left panel: editor */}
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {selectedField && (
              <div className="pt-6" />
            )}

            <div className="space-y-2">
              {keycodeFields.map(({ key, labelKey }) => {
                if (selectedField && selectedField !== key) return null
                return (
                  <div key={key} className="flex items-center gap-3">
                    <label className="min-w-[140px] text-sm text-content">{t(labelKey)}</label>
                    <KeycodeField
                      value={editedEntry[key]}
                      selected={selectedField === key}
                      onSelect={() => { if (!selectedField) setSelectedField(key) }}
                      onDoubleClick={selectedField ? (rect) => handleFieldDoubleClick(key, rect) : undefined}
                      label={t(labelKey)}
                    />
                  </div>
                )
              })}
              {!selectedField && (
                <div className="flex items-center gap-3">
                  <label className="min-w-[140px] text-sm text-content">
                    {t('editor.tapDance.tappingTerm')}
                  </label>
                  <input
                    type="number"
                    min={TAPPING_TERM_MIN}
                    max={TAPPING_TERM_MAX}
                    value={editedEntry.tappingTerm}
                    onChange={(e) => handleTappingTermChange(e.target.value)}
                    className="flex-1 rounded border border-edge px-2 py-1 text-sm"
                  />
                </div>
              )}
            </div>

            {selectedField && (
              <div className="mt-3">
                <TabbedKeycodes onKeycodeSelect={handleKeycodeSelect} onClose={() => setSelectedField(null)} />
              </div>
            )}

            {popoverState && (
              <KeyPopover
                anchorRect={popoverState.anchorRect}
                currentKeycode={editedEntry[popoverState.field]}
                onKeycodeSelect={handlePopoverKeycodeSelect}
                onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
                onClose={closePopover}
              />
            )}

            {!selectedField && (
              <div className="flex justify-end gap-2 pt-4">
                <button
                  type="button"
                  data-testid="td-modal-save"
                  className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                  disabled={!hasChanges}
                  onClick={() => onSave(index, editedEntry)}
                >
                  {t('common.save')}
                </button>
              </div>
            )}
          </div>

          {/* Right panel: favorites */}
          {!isDummy && (
            <div
              className={`w-[456px] shrink-0 border-l border-edge flex flex-col ${selectedField ? 'hidden' : ''}`}
              data-testid="td-favorites-panel"
            >
              <FavoriteStoreContent
                entries={favStore.entries}
                loading={favStore.loading}
                saving={favStore.saving}
                canSave={isConfigured(editedEntry)}
                onSave={favStore.saveFavorite}
                onLoad={favStore.loadFavorite}
                onRename={favStore.renameEntry}
                onDelete={favStore.deleteEntry}
                onExport={favStore.exportFavorites}
                onExportEntry={favStore.exportEntry}
                onImport={favStore.importFavorites}
                exporting={favStore.exporting}
                importing={favStore.importing}
                importResult={favStore.importResult}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
