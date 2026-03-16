// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { AltRepeatKeyEntry, TapDanceEntry } from '../../../shared/types/protocol'
import { AltRepeatKeyOptions } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { KeycodeEntryModalAdapter } from '../../hooks/useKeycodeEntryModal'
import { useKeycodeEntryModal, useEnabledEntryCallbacks } from '../../hooks/useKeycodeEntryModal'
import { KeycodeEntryModalShell, pickHubProps } from './KeycodeEntryModalShell'
import type { FavHubEntryResult } from './FavoriteHubActions'
import { ModifierPicker } from './ModifierPicker'

interface Props {
  entries: AltRepeatKeyEntry[]
  onSetEntry: (index: number, entry: AltRepeatKeyEntry) => Promise<void>
  initialIndex: number
  unlocked?: boolean
  onUnlock?: () => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  onClose: () => void
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
  quickSelect?: boolean
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
}

const optionEntries = Object.entries(AltRepeatKeyOptions).filter(
  (pair): pair is [string, number] => typeof pair[1] === 'number',
)

function isConfigured(entry: AltRepeatKeyEntry): boolean {
  return entry.lastKey !== 0
}

const arAdapter: KeycodeEntryModalAdapter<AltRepeatKeyEntry> = {
  testIdPrefix: 'ar',
  bodyTestId: 'editor-alt-repeat-key',
  favoriteType: 'altRepeatKey',
  titleKey: 'editor.altRepeatKey.editTitle',
  titleParams: (index) => ({ index }),
  keycodeFields: [
    { key: 'lastKey', labelKey: 'editor.altRepeatKey.lastKey' },
    { key: 'altKey', labelKey: 'editor.altRepeatKey.altKey' },
  ],
  createEmptyEntry: () => ({
    lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false,
  }),
  isConfigured,
  guardCodes: (e) => [e.lastKey, e.altKey],
  normalizeEntry: (e) => isConfigured(e) ? e : { ...e, enabled: false },
  closeOnSave: true,
}

export function AltRepeatKeyPanelModal({
  entries, onSetEntry, initialIndex, unlocked, onUnlock,
  tapDanceEntries, deserializedMacros, onClose,
  hubOrigin, hubNeedsDisplayName, hubUploading, hubUploadResult,
  onUploadToHub, onUpdateOnHub, onRemoveFromHub, onRenameOnHub,
  quickSelect, splitKeyMode, basicViewType,
}: Props) {
  const { t } = useTranslation()

  const hook = useKeycodeEntryModal(arAdapter, {
    entry: entries[initialIndex],
    index: initialIndex,
    onSave: onSetEntry,
    onClose,
    unlocked,
    onUnlock,
    quickSelect,
    tapDanceEntries,
    deserializedMacros,
    splitKeyMode,
    basicViewType,
  })

  const { editedEntry } = hook
  const { canEnable, handleToggleEnabled, handleToggleOption, updateEntry } =
    useEnabledEntryCallbacks(hook, isConfigured)

  const hubProps = pickHubProps({
    hubOrigin, hubNeedsDisplayName, hubUploading, hubUploadResult,
    onUploadToHub, onUpdateOnHub, onRemoveFromHub, onRenameOnHub,
  })

  return (
    <KeycodeEntryModalShell
      adapter={arAdapter}
      hook={hook}
      index={initialIndex}
      quickSelect={quickSelect}
      splitKeyMode={splitKeyMode}
      basicViewType={basicViewType}
      hubProps={hubProps}
      renderBeforeFields={() => (
        <div className="flex items-center gap-3">
          <label className="min-w-[140px] text-sm text-content">
            {t('editor.altRepeatKey.enabled')}
          </label>
          <input
            type="checkbox"
            data-testid="ar-enabled"
            checked={editedEntry?.enabled ?? false}
            onChange={handleToggleEnabled}
            disabled={!canEnable}
            className="h-4 w-4"
          />
        </div>
      )}
      renderAfterFields={() => (
        <div className="mt-2 space-y-2" data-testid="ar-advanced-fields">
          <ModifierPicker
            value={editedEntry?.allowedMods ?? 0}
            onChange={(v) => updateEntry('allowedMods', v)}
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
                    checked={((editedEntry?.options ?? 0) & flag) !== 0}
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
    />
  )
}
