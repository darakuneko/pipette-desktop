// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComboEntry } from '../../../shared/types/protocol'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { serialize, deserialize, keycodeLabel } from '../../../shared/keycodes/keycodes'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { useMaskedKeycodeSelection } from '../../hooks/useMaskedKeycodeSelection'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { ConfirmButton } from './ConfirmButton'
import { KeycodeField } from './KeycodeField'
import { MaskKeyPreview } from './MaskKeyPreview'
import { ModalCloseButton } from './ModalCloseButton'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'

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
  const [editedEntry, setEditedEntry] = useState<ComboEntry | null>(null)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)
  const preEditValueRef = useRef<number>(0)

  const favStore = useFavoriteStore({
    favoriteType: 'combo',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as ComboEntry),
  })

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

  const clearAction = useConfirmAction(useCallback(() => {
    setEditedEntry((prev) => prev ? { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 } : prev)
    setSelectedField(null)
    setPopoverState(null)
  }, []))

  const revertAction = useConfirmAction(useCallback(() => {
    if (selectedIndex === null || !entries[selectedIndex]) return
    clearPending()
    setEditedEntry(entries[selectedIndex])
    setSelectedField(null)
    setPopoverState(null)
  }, [selectedIndex, entries, clearPending]))

  // Sync edited entry when selection changes
  useEffect(() => {
    setSelectedField(null)
    setPopoverState(null)
    clearAction.reset()
    revertAction.reset()
    if (selectedIndex !== null && entries[selectedIndex]) {
      setEditedEntry(entries[selectedIndex])
    } else {
      setEditedEntry(null)
      if (selectedIndex !== null) setSelectedIndex(null)
    }
  }, [selectedIndex, entries])

  useEffect(() => {
    favStore.refreshEntries()
  }, [favStore.refreshEntries])

  const handleClose = useCallback(() => {
    clearPending()
    onClose()
  }, [clearPending, onClose])

  const handleBack = useCallback(() => {
    setSelectedIndex(null)
  }, [])

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
      setSelectedIndex(null)
    })
  }, [selectedIndex, editedEntry, onSetEntry, guard])

  const updateField = useCallback((field: KeycodeFieldName, code: number) => {
    setEditedEntry((prev) => prev ? { ...prev, [field]: code } : prev)
    setPopoverState(null)
    setSelectedField(null)
  }, [])

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedField) return false
      setEditedEntry((prev) => prev ? { ...prev, [selectedField]: code } : prev)
    },
    onCommit() {
      setPopoverState(null)
      setSelectedField(null)
    },
    resetKey: selectedField,
    initialValue: selectedField && editedEntry ? editedEntry[selectedField] : undefined,
  })

  const handleFieldDoubleClick = useCallback(
    (field: KeycodeFieldName, rect: DOMRect) => {
      if (!selectedField) return
      setPopoverState({ field, anchorRect: rect })
    },
    [selectedField],
  )

  const popoverField = popoverState?.field ?? null

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!popoverField) return
      updateField(popoverField, deserialize(kc.qmkId))
    },
    [popoverField, updateField],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverField) return
      updateField(popoverField, code)
    },
    [popoverField, updateField],
  )

  const hasChanges =
    selectedIndex !== null &&
    editedEntry !== null &&
    JSON.stringify(entries[selectedIndex]) !== JSON.stringify(editedEntry)

  const hasEntries = entries.length > 0
  const isEditing = selectedIndex !== null

  const headerTitle = isEditing
    ? t('editor.combo.editTitle', { index: selectedIndex })
    : t('editor.combo.title')

  function renderBody(): React.ReactNode {
    if (!hasEntries) {
      return (
        <div className="text-sm text-content-muted" data-testid="editor-combo">
          {t('common.noEntries')}
        </div>
      )
    }

    if (!isEditing) {
      return (
        <div className="flex-1 min-h-0 flex flex-col px-6 pb-6" data-testid="editor-combo">
          <div className="mt-1 flex-1 min-h-0 grid grid-cols-6 auto-rows-fr gap-2">
            {entries.map((entry, i) => {
              const configured = isConfigured(entry)
              return (
                <button
                  key={i}
                  type="button"
                  data-testid={`combo-tile-${i}`}
                  className={`relative flex min-h-0 flex-col items-center justify-center rounded-md border p-1.5 text-xs leading-tight transition-colors ${configured ? TILE_STYLE_CONFIGURED : TILE_STYLE_EMPTY}`}
                  onClick={() => setSelectedIndex(i)}
                >
                  <span className="absolute top-1 left-1.5 text-[10px] text-content-secondary/60">{i}</span>
                  {configured ? (
                    <span className="flex w-full flex-col items-center truncate">
                      <span className="max-w-full truncate">{comboInputLabel(entry)}</span>
                      <span className="text-content-secondary/60">&darr;</span>
                      <span className="max-w-full truncate">
                        {entry.output !== 0 ? codeToLabel(entry.output) : '\u00A0'}
                      </span>
                    </span>
                  ) : (
                    <span className="w-full text-center text-content-secondary/60">
                      {t('common.notConfigured')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {qmkSettingsGet && comboTimeout !== null && (
            <div className="shrink-0 mt-4 flex items-center gap-3">
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
      )
    }

    return (
      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="editor-combo">
        {/* Left panel: detail editor */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
            {editedEntry && (
              <>
                <div className="space-y-2">
                  {keycodeFields.map(({ key, labelKey, labelOpts }) => {
                    if (selectedField && selectedField !== key) return null
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <label className="min-w-[140px] text-sm text-content">{t(labelKey, labelOpts)}</label>
                        <KeycodeField
                          value={editedEntry[key]}
                          selected={selectedField === key}
                          selectedMaskPart={selectedField === key && maskedSelection.editingPart === 'inner'}
                          onSelect={() => { if (!selectedField) { preEditValueRef.current = editedEntry[key]; setSelectedField(key) } }}
                          onMaskPartClick={(part) => {
                            if (selectedField === key) {
                              maskedSelection.setEditingPart(part)
                            } else if (!selectedField) {
                              preEditValueRef.current = editedEntry[key]
                              maskedSelection.enterMaskMode(editedEntry[key], part)
                              setSelectedField(key)
                            }
                          }}
                          onDoubleClick={selectedField ? (rect) => handleFieldDoubleClick(key, rect) : undefined}
                          label={t(labelKey, labelOpts)}
                        />
                        {selectedField === key && (
                          <MaskKeyPreview onConfirm={maskedSelection.confirm} />
                        )}
                      </div>
                    )
                  })}
                </div>

                {selectedField && (
                  <div className="mt-3">
                    <TabbedKeycodes
                      onKeycodeSelect={maskedSelection.handleKeycodeSelect}
                      maskOnly={maskedSelection.maskOnly}
                      lmMode={maskedSelection.lmMode}
                      onClose={() => {
                        if (selectedField) {
                          setEditedEntry((prev) => prev ? { ...prev, [selectedField]: preEditValueRef.current } : prev)
                        }
                        maskedSelection.clearMask()
                        setSelectedField(null)
                      }}
                    />
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
                  <div className="flex justify-end gap-2 pt-4">
                    <ConfirmButton
                      testId="combo-modal-clear"
                      confirming={clearAction.confirming}
                      onClick={() => { revertAction.reset(); clearAction.trigger() }}
                      labelKey="common.clear"
                      confirmLabelKey="common.confirmClear"
                    />
                    <ConfirmButton
                      testId="combo-modal-revert"
                      confirming={revertAction.confirming}
                      onClick={() => { clearAction.reset(); revertAction.trigger() }}
                      labelKey="common.revert"
                      confirmLabelKey="common.confirmRevert"
                    />
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
            )}
          </div>

          {/* Fixed footer: Back */}
          {!selectedField && editedEntry && (
            <div className="shrink-0 px-6 py-3">
              <button
                type="button"
                data-testid="combo-back-btn"
                className="rounded-lg border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-content hover:bg-surface-alt"
                onClick={handleBack}
              >
                {t('common.back')}
              </button>
            </div>
          )}
        </div>

        {/* Right panel: favorites (hidden when picker is open) */}
        <div
          className={`w-[456px] shrink-0 flex flex-col ${selectedField ? 'hidden' : ''}`}
          data-testid="combo-favorites-panel"
        >
          <FavoriteStoreContent
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
          />
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="combo-modal-backdrop"
      onClick={handleClose}
    >
      <div
        className={`overflow-hidden rounded-lg bg-surface-alt shadow-xl ${hasEntries ? 'w-[1050px] max-w-[95vw] h-[80vh] flex flex-col' : 'p-6'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!selectedField && (
          <div className={`flex items-center justify-between shrink-0 ${hasEntries ? 'px-6 pt-6 pb-4' : 'mb-4'}`}>
            <h3 className="text-lg font-semibold">{headerTitle}</h3>
            <ModalCloseButton testid="combo-modal-close" onClick={handleClose} />
          </div>
        )}

        {renderBody()}
      </div>
    </div>
  )
}
