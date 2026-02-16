// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComboEntry } from '../../../shared/types/protocol'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { serialize, deserialize, keycodeLabel } from '../../../shared/keycodes/keycodes'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { KeycodeField } from './KeycodeField'
import { ModalCloseButton } from './ModalCloseButton'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreModal } from './FavoriteStoreModal'

const COMBO_TIMEOUT_QSID = 2
const COMBO_TIMEOUT_WIDTH = 2
const COMBO_TIMEOUT_MAX = 10000

interface Props {
  entries: ComboEntry[]
  onSetEntry: (index: number, entry: ComboEntry) => Promise<void>
  unlocked?: boolean
  onUnlock?: () => void
  qmkSettingsGet?: (qsid: number) => Promise<number[]>
  qmkSettingsSet?: (qsid: number, data: number[]) => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
  onClose: () => void
}

type KeycodeFieldName = 'key1' | 'key2' | 'key3' | 'key4' | 'output'

interface FieldDescriptor {
  key: KeycodeFieldName
  labelKey: string
  labelOpts?: Record<string, unknown>
}

const keycodeFields: FieldDescriptor[] = [
  { key: 'key1', labelKey: 'editor.combo.key', labelOpts: { number: 1 } },
  { key: 'key2', labelKey: 'editor.combo.key', labelOpts: { number: 2 } },
  { key: 'key3', labelKey: 'editor.combo.key', labelOpts: { number: 3 } },
  { key: 'key4', labelKey: 'editor.combo.key', labelOpts: { number: 4 } },
  { key: 'output', labelKey: 'editor.combo.output' },
]

function codeToLabel(code: number): string {
  return keycodeLabel(serialize(code)).replaceAll('\n', ' ')
}

function isConfigured(entry: ComboEntry): boolean {
  return entry.key1 !== 0 || entry.key2 !== 0
}

function comboInputLabel(entry: ComboEntry): string {
  return [entry.key1, entry.key2, entry.key3, entry.key4]
    .filter((k) => k !== 0)
    .map(codeToLabel)
    .join(' ')
}

const TILE_STYLE_CONFIGURED =
  'border-accent bg-accent/20 text-accent font-semibold hover:bg-accent/30'
const TILE_STYLE_EMPTY =
  'border-accent/30 bg-accent/5 text-content-secondary hover:bg-accent/10'

export function ComboPanelModal({
  entries,
  onSetEntry,
  unlocked,
  onUnlock,
  qmkSettingsGet,
  qmkSettingsSet,
  onSettingsUpdate,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [comboTimeout, setComboTimeout] = useState<number | null>(null)
  const [savedTimeout, setSavedTimeout] = useState<number | null>(null)
  const favStore = useFavoriteStore({
    favoriteType: 'combo',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as ComboEntry),
  })

  // Detail editor state
  const [editedEntry, setEditedEntry] = useState<ComboEntry | null>(null)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)

  // Load combo timeout
  useEffect(() => {
    if (!qmkSettingsGet) return
    let cancelled = false
    qmkSettingsGet(COMBO_TIMEOUT_QSID).then((data) => {
      if (cancelled) return
      let value = 0
      for (let i = 0; i < COMBO_TIMEOUT_WIDTH && i < data.length; i++) {
        value |= data[i] << (8 * i)
      }
      setComboTimeout(value)
      setSavedTimeout(value)
    }).catch(() => {
      // device may not support this setting
    })
    return () => { cancelled = true }
  }, [qmkSettingsGet])

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

  // Escape key closes modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleTimeoutSave = useCallback(async () => {
    if (comboTimeout === null || !qmkSettingsSet) return
    const bytes: number[] = []
    for (let i = 0; i < COMBO_TIMEOUT_WIDTH; i++) {
      bytes.push((comboTimeout >> (8 * i)) & 0xff)
    }
    await qmkSettingsSet(COMBO_TIMEOUT_QSID, bytes)
    onSettingsUpdate?.(COMBO_TIMEOUT_QSID, bytes)
    setSavedTimeout(comboTimeout)
  }, [comboTimeout, qmkSettingsSet, onSettingsUpdate])

  const handleEntrySave = useCallback(async () => {
    if (selectedIndex === null || !editedEntry) return
    const codes = [editedEntry.key1, editedEntry.key2, editedEntry.key3, editedEntry.key4, editedEntry.output]
    await guard(codes, async () => {
      await onSetEntry(selectedIndex, editedEntry)
    })
  }, [selectedIndex, editedEntry, onSetEntry, guard])

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!selectedField) return
      const code = deserialize(kc.qmkId)
      setEditedEntry((prev) => prev ? { ...prev, [selectedField]: code } : prev)
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
      setEditedEntry((prev) => prev ? { ...prev, [popoverState.field]: code } : prev)
      closePopover()
      setSelectedField(null)
    },
    [popoverState, closePopover],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverState) return
      setEditedEntry((prev) => prev ? { ...prev, [popoverState.field]: code } : prev)
      closePopover()
      setSelectedField(null)
    },
    [popoverState, closePopover],
  )

  const hasChanges = selectedIndex !== null && editedEntry !== null
    && JSON.stringify(entries[selectedIndex]) !== JSON.stringify(editedEntry)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="combo-modal-backdrop"
      onClick={handleClose}
    >
      <div
        className={`overflow-hidden rounded-lg bg-surface-alt shadow-xl ${entries.length > 0 ? 'w-[950px] max-w-[95vw] max-h-[90vh] flex flex-col' : 'p-6'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header (hidden when picker is open) */}
        {!selectedField && (
          <div className={`flex items-center justify-between ${entries.length > 0 ? 'px-6 pt-6 pb-4' : 'mb-4'}`}>
            <h3 className="text-lg font-semibold">{t('editor.combo.title')}</h3>
            <ModalCloseButton testid="combo-modal-close" onClick={handleClose} />
          </div>
        )}

        {entries.length === 0 ? (
          <div className="text-sm text-content-muted" data-testid="editor-combo">
            {t('common.noEntries')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="editor-combo">
            {/* Left panel: grid + timeout (hidden when picker is open) */}
            <div className={`w-[456px] shrink-0 overflow-y-auto border-r border-edge px-6 pb-6 ${selectedField ? 'hidden' : ''}`}>
              <div className="mt-1 grid grid-cols-6 gap-2">
                {entries.map((entry, i) => {
                  const configured = isConfigured(entry)
                  const isSelected = selectedIndex === i
                  return (
                    <button
                      key={i}
                      type="button"
                      data-testid={`combo-tile-${i}`}
                      className={`flex aspect-square flex-col items-start rounded-md border p-1.5 text-[10px] leading-tight transition-colors ${configured ? TILE_STYLE_CONFIGURED : TILE_STYLE_EMPTY} ${isSelected ? 'ring-2 ring-accent' : ''}`}
                      onClick={() => setSelectedIndex(i)}
                    >
                      <span className="text-content-secondary/60">{i}</span>
                      {configured ? (
                        <span className="mt-auto flex w-full flex-col items-center truncate">
                          <span className="max-w-full truncate">{comboInputLabel(entry)}</span>
                          <span className="text-content-secondary/60">&darr;</span>
                          <span className="max-w-full truncate">
                            {entry.output !== 0 ? codeToLabel(entry.output) : '\u00A0'}
                          </span>
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
              {qmkSettingsGet && comboTimeout !== null && (
                <div className="mt-4 flex items-center gap-3">
                  <label className="text-sm">{t('editor.combo.timeout')}</label>
                  <input
                    type="number"
                    min={0}
                    max={COMBO_TIMEOUT_MAX}
                    value={comboTimeout}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10) || 0
                      setComboTimeout(Math.max(0, Math.min(COMBO_TIMEOUT_MAX, v)))
                    }}
                    className="w-28 rounded border border-edge px-2 py-1 text-sm"
                    data-testid="combo-timeout-input"
                  />
                  <button
                    type="button"
                    data-testid="combo-timeout-save"
                    className="rounded bg-accent px-3 py-1 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                    disabled={comboTimeout === savedTimeout}
                    onClick={handleTimeoutSave}
                  >
                    {t('common.save')}
                  </button>
                </div>
              )}
            </div>

            {/* Right panel: detail editor */}
            <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
              {selectedIndex !== null && editedEntry ? (
                <>
                  <div className={`${selectedField ? 'mb-4' : 'mb-3'}`}>
                    <h4 className={`font-semibold ${selectedField ? 'text-lg' : 'text-sm'}`}>
                      {t('editor.combo.editTitle', { index: selectedIndex })}
                    </h4>
                  </div>
                  <div className="space-y-2">
                    {keycodeFields.map(({ key, labelKey, labelOpts }) => {
                      if (selectedField && selectedField !== key) return null
                      return (
                        <div key={key} className="flex items-center gap-3">
                          <label className="min-w-[140px] text-sm text-content">{t(labelKey, labelOpts)}</label>
                          <KeycodeField
                            value={editedEntry[key]}
                            selected={selectedField === key}
                            onSelect={() => { if (!selectedField) setSelectedField(key) }}
                            onDoubleClick={selectedField ? (rect) => handleFieldDoubleClick(key, rect) : undefined}
                            label={t(labelKey, labelOpts)}
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

                  {popoverState && editedEntry && (
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
                        data-testid="combo-fav-btn"
                        className="rounded bg-warning px-3 py-2 text-sm text-black hover:bg-warning/80"
                        onClick={favStore.openModal}
                      >
                        {t('favoriteStore.button')}
                      </button>
                      <button
                        type="button"
                        data-testid="combo-modal-save"
                        className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                        disabled={!hasChanges}
                        onClick={handleEntrySave}
                      >
                        {t('common.save')}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-content-muted">
                  {t('editor.combo.selectEntry')}
                </div>
              )}
            </div>
          </div>
        )}

        {favStore.showModal && (
          <FavoriteStoreModal
            favoriteType="combo"
            entries={favStore.entries}
            loading={favStore.loading}
            saving={favStore.saving}
            canSave={editedEntry !== null && isConfigured(editedEntry)}
            onSave={favStore.saveFavorite}
            onLoad={favStore.loadFavorite}
            onRename={favStore.renameEntry}
            onDelete={favStore.deleteEntry}
            onClose={favStore.closeModal}
          />
        )}
      </div>
    </div>
  )
}
