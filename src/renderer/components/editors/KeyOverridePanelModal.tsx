// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { KeyOverrideEntry } from '../../../shared/types/protocol'
import { KeyOverrideOptions } from '../../../shared/types/protocol'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { serialize, deserialize, keycodeLabel } from '../../../shared/keycodes/keycodes'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { KeycodeField } from './KeycodeField'
import { LayerPicker } from './LayerPicker'
import { ModalCloseButton } from './ModalCloseButton'
import { ModifierPicker } from './ModifierPicker'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreModal } from './FavoriteStoreModal'

interface Props {
  entries: KeyOverrideEntry[]
  onSetEntry: (index: number, entry: KeyOverrideEntry) => Promise<void>
  unlocked?: boolean
  onUnlock?: () => void
  onClose: () => void
}

type KeycodeFieldName = 'triggerKey' | 'replacementKey'

const keycodeFields: { key: KeycodeFieldName; labelKey: string }[] = [
  { key: 'triggerKey', labelKey: 'editor.keyOverride.triggerKey' },
  { key: 'replacementKey', labelKey: 'editor.keyOverride.replacementKey' },
]

// Pre-compute option entries from the numeric enum (filter out reverse mappings)
const optionEntries = Object.entries(KeyOverrideOptions).filter(
  (pair): pair is [string, number] => typeof pair[1] === 'number',
)

function codeToLabel(code: number): string {
  return keycodeLabel(serialize(code)).replaceAll('\n', ' ')
}

function isConfigured(entry: KeyOverrideEntry): boolean {
  return entry.triggerKey !== 0 || entry.triggerMods !== 0
}

const TILE_STYLE_ACTIVE =
  'border-accent bg-accent/20 text-accent font-semibold hover:bg-accent/30'
const TILE_STYLE_DISABLED =
  'border-picker-item-border bg-picker-item-bg text-picker-item-text hover:bg-picker-item-hover'
const TILE_STYLE_EMPTY =
  'border-accent/30 bg-accent/5 text-content-secondary hover:bg-accent/10'

function tileStyle(configured: boolean, enabled: boolean): string {
  if (configured && enabled) return TILE_STYLE_ACTIVE
  if (configured) return TILE_STYLE_DISABLED
  return TILE_STYLE_EMPTY
}

export function KeyOverridePanelModal({
  entries,
  onSetEntry,
  unlocked,
  onUnlock,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const favStore = useFavoriteStore({
    favoriteType: 'keyOverride',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as KeyOverrideEntry),
  })

  // Detail editor state
  const [editedEntry, setEditedEntry] = useState<KeyOverrideEntry | null>(null)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)

  // Sync edited entry when selection changes
  useEffect(() => {
    setSelectedField(null)
    setPopoverState(null)
    if (selectedIndex !== null && entries[selectedIndex]) {
      setEditedEntry(entries[selectedIndex])
    } else {
      setEditedEntry(null)
    }
  }, [selectedIndex, entries])

  const handleClose = useCallback(() => {
    clearPending()
    onClose()
  }, [clearPending, onClose])

  const handleEntrySave = useCallback(async () => {
    if (selectedIndex === null || !editedEntry) return
    const codes = [editedEntry.triggerKey, editedEntry.replacementKey]
    await guard(codes, async () => {
      await onSetEntry(selectedIndex, editedEntry)
    })
  }, [selectedIndex, editedEntry, onSetEntry, guard])

  // Update a field and auto-disable when trigger conditions are cleared
  const updateEntry = useCallback((field: keyof KeyOverrideEntry, value: number) => {
    setEditedEntry((prev) => {
      if (!prev) return prev
      const next = { ...prev, [field]: value }
      if (next.triggerKey === 0 && next.triggerMods === 0) next.enabled = false
      return next
    })
  }, [])

  // Update a keycode field and close the picker
  const updateKeycodeField = useCallback((field: KeycodeFieldName, code: number) => {
    updateEntry(field, code)
    setPopoverState(null)
    setSelectedField(null)
  }, [updateEntry])

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!selectedField) return
      updateKeycodeField(selectedField, deserialize(kc.qmkId))
    },
    [selectedField, updateKeycodeField],
  )

  const handleFieldDoubleClick = useCallback(
    (field: KeycodeFieldName, rect: DOMRect) => {
      if (!selectedField) return
      setPopoverState({ field, anchorRect: rect })
    },
    [selectedField],
  )

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!popoverState) return
      updateKeycodeField(popoverState.field, deserialize(kc.qmkId))
    },
    [popoverState, updateKeycodeField],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverState) return
      updateKeycodeField(popoverState.field, code)
    },
    [popoverState, updateKeycodeField],
  )

  const handleToggleEnabled = useCallback(() => {
    setEditedEntry((prev) => prev ? { ...prev, enabled: !prev.enabled } : prev)
  }, [])

  const handleToggleOption = useCallback((flag: number) => {
    setEditedEntry((prev) => prev ? { ...prev, options: prev.options ^ flag } : prev)
  }, [])

  const canEnable = editedEntry !== null && (editedEntry.triggerKey !== 0 || editedEntry.triggerMods !== 0)

  const hasChanges = selectedIndex !== null && editedEntry !== null
    && JSON.stringify(entries[selectedIndex]) !== JSON.stringify(editedEntry)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="ko-modal-backdrop"
      onClick={handleClose}
    >
      <div
        className={`overflow-hidden rounded-lg bg-surface-alt shadow-xl ${entries.length > 0 ? 'w-[950px] max-w-[95vw] max-h-[90vh] flex flex-col' : 'p-6'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header (hidden when picker is open) */}
        {!selectedField && (
          <div className={`flex items-center justify-between ${entries.length > 0 ? 'px-6 pt-6 pb-4' : 'mb-4'}`}>
            <h3 className="text-lg font-semibold">{t('editor.keyOverride.title')}</h3>
            <ModalCloseButton testid="ko-modal-close" onClick={handleClose} />
          </div>
        )}

        {entries.length === 0 ? (
          <div className="text-sm text-content-muted" data-testid="editor-key-override">
            {t('common.noEntries')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="editor-key-override">
            {/* Left panel: grid (hidden when picker is open) */}
            <div className={`w-[456px] shrink-0 overflow-y-auto border-r border-edge px-6 pb-6 ${selectedField ? 'hidden' : ''}`}>
              <div className="mt-1 grid grid-cols-6 gap-2">
                {entries.map((entry, i) => {
                  const configured = isConfigured(entry)
                  const isSelected = selectedIndex === i
                  let leftLabel: string | null = null
                  let rightLabel: string | null = null
                  if (configured) {
                    leftLabel =
                      entry.triggerKey !== 0
                        ? codeToLabel(entry.triggerKey)
                        : t('editor.keyOverride.modsOnly')
                    rightLabel =
                      entry.replacementKey !== 0
                        ? codeToLabel(entry.replacementKey)
                        : null
                  }
                  return (
                    <button
                      key={i}
                      type="button"
                      data-testid={`ko-tile-${i}`}
                      className={`flex aspect-square flex-col items-start rounded-md border p-1.5 text-[10px] leading-tight transition-colors ${tileStyle(configured, entry.enabled)} ${isSelected ? 'ring-2 ring-accent' : ''}`}
                      onClick={() => setSelectedIndex(i)}
                    >
                      <span className="text-content-secondary/60">{i}</span>
                      {configured ? (
                        <span className="mt-auto flex w-full flex-col items-center truncate">
                          <span className="max-w-full truncate">{leftLabel}</span>
                          <span className="text-content-secondary/60">&darr;</span>
                          <span className="max-w-full truncate">{rightLabel ?? '\u00A0'}</span>
                        </span>
                      ) : (
                        <span className="mt-auto mb-auto w-full text-center text-content-secondary/60">
                          {t('common.notConfigured')}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Right panel: detail editor */}
            <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
              {selectedIndex !== null && editedEntry ? (
                <>
                  <div className={`${selectedField ? 'mb-4' : 'mb-3'}`}>
                    <h4 className={`font-semibold ${selectedField ? 'text-lg' : 'text-sm'}`}>
                      {t('editor.keyOverride.editTitle', { index: selectedIndex })}
                    </h4>
                  </div>

                  <div className="space-y-2">
                    {!selectedField && (
                      <div className="flex items-center gap-3">
                        <label className="min-w-[140px] text-sm text-content">
                          {t('editor.keyOverride.enabled')}
                        </label>
                        <input
                          type="checkbox"
                          data-testid="ko-enabled"
                          checked={editedEntry.enabled}
                          onChange={handleToggleEnabled}
                          disabled={!canEnable}
                          className="h-4 w-4"
                        />
                      </div>
                    )}
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
                      onClose={() => setPopoverState(null)}
                    />
                  )}

                  {!selectedField && (
                    <>
                      <div className="mt-2 space-y-2" data-testid="ko-advanced-fields">
                        <LayerPicker
                          value={editedEntry.layers}
                          onChange={(v) => updateEntry('layers', v)}
                          label={t('editor.keyOverride.layers')}
                          horizontal
                        />
                        <ModifierPicker
                          value={editedEntry.triggerMods}
                          onChange={(v) => updateEntry('triggerMods', v)}
                          label={t('editor.keyOverride.triggerMods')}
                          horizontal
                        />
                        <ModifierPicker
                          value={editedEntry.negativeMods}
                          onChange={(v) => updateEntry('negativeMods', v)}
                          label={t('editor.keyOverride.negativeMods')}
                          horizontal
                        />
                        <ModifierPicker
                          value={editedEntry.suppressedMods}
                          onChange={(v) => updateEntry('suppressedMods', v)}
                          label={t('editor.keyOverride.suppressedMods')}
                          horizontal
                        />
                        <div className="flex items-start gap-3">
                          <label className="min-w-[140px] pt-0.5 text-sm font-medium">
                            {t('editor.keyOverride.options')}
                          </label>
                          <div className="space-y-1">
                            {optionEntries.map(([name, flag]) => (
                              <label key={name} className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={(editedEntry.options & flag) !== 0}
                                  onChange={() => handleToggleOption(flag)}
                                  className="h-4 w-4"
                                />
                                <span className="text-sm">{name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 pt-4">
                        <button
                          type="button"
                          data-testid="ko-fav-btn"
                          className="rounded bg-warning px-3 py-2 text-sm text-black hover:bg-warning/80"
                          onClick={favStore.openModal}
                        >
                          {t('favoriteStore.button')}
                        </button>
                        <button
                          type="button"
                          data-testid="ko-modal-save"
                          className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                          disabled={!hasChanges}
                          onClick={handleEntrySave}
                        >
                          {t('common.save')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-content-muted">
                  {t('editor.keyOverride.selectEntry')}
                </div>
              )}
            </div>
          </div>
        )}

        {favStore.showModal && (
          <FavoriteStoreModal
            favoriteType="keyOverride"
            entries={favStore.entries}
            loading={favStore.loading}
            saving={favStore.saving}
            canSave={editedEntry !== null && isConfigured(editedEntry)}
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
            onClose={favStore.closeModal}
          />
        )}
      </div>
    </div>
  )
}
