// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AltRepeatKeyEntry } from '../../../shared/types/protocol'
import { AltRepeatKeyOptions } from '../../../shared/types/protocol'
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
import { ModifierPicker } from './ModifierPicker'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'

interface Props {
  entries: AltRepeatKeyEntry[]
  onSetEntry: (index: number, entry: AltRepeatKeyEntry) => Promise<void>
  unlocked?: boolean
  onUnlock?: () => void
  onClose: () => void
}

type KeycodeFieldName = 'lastKey' | 'altKey'

const keycodeFields: { key: KeycodeFieldName; labelKey: string }[] = [
  { key: 'lastKey', labelKey: 'editor.altRepeatKey.lastKey' },
  { key: 'altKey', labelKey: 'editor.altRepeatKey.altKey' },
]

// Pre-compute option entries from the numeric enum (filter out reverse mappings)
const optionEntries = Object.entries(AltRepeatKeyOptions).filter(
  (pair): pair is [string, number] => typeof pair[1] === 'number',
)

function codeToLabel(code: number): string {
  return keycodeLabel(serialize(code)).replaceAll('\n', ' ')
}

function isConfigured(entry: AltRepeatKeyEntry): boolean {
  return entry.lastKey !== 0
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

export function AltRepeatKeyPanelModal({
  entries,
  onSetEntry,
  unlocked,
  onUnlock,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [editedEntry, setEditedEntry] = useState<AltRepeatKeyEntry | null>(null)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)
  const preEditValueRef = useRef<number>(0)

  const favStore = useFavoriteStore({
    favoriteType: 'altRepeatKey',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as AltRepeatKeyEntry),
  })

  const clearAction = useConfirmAction(useCallback(() => {
    setEditedEntry((prev) => prev ? {
      lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false,
    } : prev)
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

  const handleEntrySave = useCallback(async () => {
    if (selectedIndex === null || !editedEntry) return
    const codes = [editedEntry.lastKey, editedEntry.altKey]
    await guard(codes, async () => {
      await onSetEntry(selectedIndex, editedEntry)
      setSelectedIndex(null)
    })
  }, [selectedIndex, editedEntry, onSetEntry, guard])

  const updateEntry = useCallback((field: KeycodeFieldName, code: number) => {
    setEditedEntry((prev) => {
      if (!prev) return prev
      const next = { ...prev, [field]: code }
      if (!isConfigured(next)) next.enabled = false
      return next
    })
  }, [])

  const updateField = useCallback((field: KeycodeFieldName, code: number) => {
    updateEntry(field, code)
    setPopoverState(null)
    setSelectedField(null)
  }, [updateEntry])

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedField) return false
      updateEntry(selectedField, code)
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

  const handleToggleEnabled = useCallback(() => {
    setEditedEntry((prev) => prev ? { ...prev, enabled: !prev.enabled } : prev)
  }, [])

  const handleToggleOption = useCallback((flag: number) => {
    setEditedEntry((prev) => prev ? { ...prev, options: prev.options ^ flag } : prev)
  }, [])

  const canEnable = editedEntry !== null && isConfigured(editedEntry)

  const hasChanges =
    selectedIndex !== null &&
    editedEntry !== null &&
    JSON.stringify(entries[selectedIndex]) !== JSON.stringify(editedEntry)

  const hasEntries = entries.length > 0
  const isEditing = selectedIndex !== null

  const headerTitle = isEditing
    ? t('editor.altRepeatKey.editTitle', { index: selectedIndex })
    : t('editor.altRepeatKey.title')

  function renderBody(): React.ReactNode {
    if (!hasEntries) {
      return (
        <div className="text-sm text-content-muted" data-testid="editor-alt-repeat-key">
          {t('common.noEntries')}
        </div>
      )
    }

    if (!isEditing) {
      return (
        <div className="flex-1 min-h-0 px-6 pb-6" data-testid="editor-alt-repeat-key">
          <div className="mt-1 grid h-full grid-cols-6 auto-rows-fr gap-2">
            {entries.map((entry, i) => {
              const configured = isConfigured(entry)
              let leftLabel: string | null = null
              let rightLabel: string | null = null
              if (configured) {
                leftLabel = codeToLabel(entry.lastKey)
                rightLabel = entry.altKey !== 0 ? codeToLabel(entry.altKey) : null
              }
              return (
                <button
                  key={i}
                  type="button"
                  data-testid={`ar-tile-${i}`}
                  className={`relative flex min-h-0 flex-col items-center justify-center rounded-md border p-1.5 text-xs leading-tight transition-colors ${tileStyle(configured, entry.enabled)}`}
                  onClick={() => setSelectedIndex(i)}
                >
                  <span className="absolute top-1 left-1.5 text-[10px] text-content-secondary/60">{i}</span>
                  {configured ? (
                    <span className="flex w-full flex-col items-center truncate">
                      <span className="max-w-full truncate">{leftLabel}</span>
                      <span className="text-content-secondary/60">&darr;</span>
                      <span className="max-w-full truncate">{rightLabel ?? '\u00A0'}</span>
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
        </div>
      )
    }

    return (
      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="editor-alt-repeat-key">
        {/* Left panel: detail editor */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
            {editedEntry && (
              <>
                <div className="space-y-2">
                  {!selectedField && (
                    <div className="flex items-center gap-3">
                      <label className="min-w-[140px] text-sm text-content">
                        {t('editor.altRepeatKey.enabled')}
                      </label>
                      <input
                        type="checkbox"
                        data-testid="ar-enabled"
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
                          label={t(labelKey)}
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
                  <div className="mt-2 space-y-2" data-testid="ar-advanced-fields">
                    <ModifierPicker
                      value={editedEntry.allowedMods}
                      onChange={(v) => setEditedEntry((prev) => prev ? { ...prev, allowedMods: v } : prev)}
                      label={t('editor.altRepeatKey.allowedMods')}
                      horizontal
                    />
                    <div className="flex items-start gap-3">
                      <label className="min-w-[140px] pt-0.5 text-sm font-medium">
                        {t('editor.altRepeatKey.options')}
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
                )}

                {!selectedField && (
                  <div className="flex justify-end gap-2 pt-4">
                    <ConfirmButton
                      testId="ar-modal-clear"
                      confirming={clearAction.confirming}
                      onClick={() => { revertAction.reset(); clearAction.trigger() }}
                      labelKey="common.clear"
                      confirmLabelKey="common.confirmClear"
                    />
                    <ConfirmButton
                      testId="ar-modal-revert"
                      confirming={revertAction.confirming}
                      onClick={() => { clearAction.reset(); revertAction.trigger() }}
                      labelKey="common.revert"
                      confirmLabelKey="common.confirmRevert"
                    />
                    <button
                      type="button"
                      data-testid="ar-modal-save"
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
                data-testid="ar-back-btn"
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
          data-testid="ar-favorites-panel"
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
      data-testid="ar-modal-backdrop"
      onClick={handleClose}
    >
      <div
        className={`overflow-hidden rounded-lg bg-surface-alt shadow-xl ${hasEntries ? 'w-[1050px] max-w-[95vw] h-[80vh] flex flex-col' : 'p-6'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!selectedField && (
          <div className={`flex items-center justify-between shrink-0 ${hasEntries ? 'px-6 pt-6 pb-4' : 'mb-4'}`}>
            <h3 className="text-lg font-semibold">{headerTitle}</h3>
            <ModalCloseButton testid="ar-modal-close" onClick={handleClose} />
          </div>
        )}

        {renderBody()}
      </div>
    </div>
  )
}
