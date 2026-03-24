// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { KeyOverrideEntry, TapDanceEntry } from '../../../shared/types/protocol'
import { KeyOverrideOptions } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { KeycodeEntryModalAdapter } from '../../hooks/useKeycodeEntryModal'
import { useKeycodeEntryModal, useEnabledEntryCallbacks } from '../../hooks/useKeycodeEntryModal'
import { KeycodeEntryModalShell, pickHubProps } from './KeycodeEntryModalShell'
import type { FavHubEntryResult } from './FavoriteHubActions'
import { LayerPicker } from './LayerPicker'
import { ModifierPicker } from './ModifierPicker'

interface Props {
  entries: KeyOverrideEntry[]
  onSetEntry: (index: number, entry: KeyOverrideEntry) => Promise<void>
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

type ModifierFieldName = 'triggerMods' | 'negativeMods' | 'suppressedMods'

const modifierFields: { key: ModifierFieldName; labelKey: string }[] = [
  { key: 'triggerMods', labelKey: 'editor.keyOverride.triggerMods' },
  { key: 'negativeMods', labelKey: 'editor.keyOverride.negativeMods' },
  { key: 'suppressedMods', labelKey: 'editor.keyOverride.suppressedMods' },
]

const optionEntries = Object.entries(KeyOverrideOptions).filter(
  (pair): pair is [string, number] => typeof pair[1] === 'number',
)

function isConfigured(entry: KeyOverrideEntry): boolean {
  return entry.triggerKey !== 0 || entry.triggerMods !== 0
}

const koAdapter: KeycodeEntryModalAdapter<KeyOverrideEntry> = {
  testIdPrefix: 'ko',
  bodyTestId: 'editor-key-override',
  favoriteType: 'keyOverride',
  titleKey: 'editor.keyOverride.editTitle',
  titleParams: (index) => ({ index }),
  keycodeFields: [
    { key: 'triggerKey', labelKey: 'editor.keyOverride.triggerKey' },
    { key: 'replacementKey', labelKey: 'editor.keyOverride.replacementKey' },
  ],
  createEmptyEntry: () => ({
    triggerKey: 0, replacementKey: 0, layers: 0xffff,
    triggerMods: 0, negativeMods: 0, suppressedMods: 0,
    options: 0, enabled: false,
  }),
  isConfigured,
  guardCodes: (e) => [e.triggerKey, e.replacementKey],
  normalizeEntry: (e) => isConfigured(e) ? e : { ...e, enabled: false },
  closeOnSave: true,
}

export function KeyOverridePanelModal({
  entries, onSetEntry, initialIndex, unlocked, onUnlock,
  tapDanceEntries, deserializedMacros, onClose,
  hubOrigin, hubNeedsDisplayName, hubUploading, hubUploadResult,
  onUploadToHub, onUpdateOnHub, onRemoveFromHub, onRenameOnHub,
  quickSelect, splitKeyMode, basicViewType,
}: Props) {
  const { t } = useTranslation()

  const hook = useKeycodeEntryModal(koAdapter, {
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
      adapter={koAdapter}
      hook={hook}
      index={initialIndex}
      quickSelect={quickSelect}
      splitKeyMode={splitKeyMode}
      basicViewType={basicViewType}
      hubProps={hubProps}
      renderBeforeFields={() => (
        <div className="flex items-center gap-3">
          <label className="min-w-[140px] text-sm text-content">
            {t('editor.keyOverride.enabled')}
          </label>
          <input
            type="checkbox"
            data-testid="ko-enabled"
            checked={editedEntry?.enabled ?? false}
            onChange={handleToggleEnabled}
            disabled={!canEnable}
            className="h-4 w-4"
          />
        </div>
      )}
      renderAfterFields={() => (
        <div className="space-y-2" data-testid="ko-advanced-fields">
          <LayerPicker
            value={editedEntry?.layers ?? 0xffff}
            onChange={(v) => updateEntry('layers', v)}
            label={t('editor.keyOverride.layers')}
            horizontal
          />
          {modifierFields.map(({ key, labelKey }) => (
            <ModifierPicker
              key={key}
              value={editedEntry?.[key] ?? 0}
              onChange={(v) => updateEntry(key, v)}
              label={t(labelKey)}
              horizontal
            />
          ))}
          <div className="flex items-start gap-3">
            <label className="min-w-[140px] pt-0.5 text-sm font-medium">
              {t('editor.keyOverride.options')}
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
