// SPDX-License-Identifier: GPL-2.0-or-later

import type { ComboEntry, TapDanceEntry } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { KeycodeEntryModalAdapter } from '../../hooks/useKeycodeEntryModal'
import { useKeycodeEntryModal } from '../../hooks/useKeycodeEntryModal'
import { KeycodeEntryModalShell, pickHubProps } from './KeycodeEntryModalShell'
import type { FavHubEntryResult } from './FavoriteHubActions'

interface Props {
  entries: ComboEntry[]
  onSetEntry: (index: number, entry: ComboEntry) => Promise<void>
  unlocked?: boolean
  onUnlock?: () => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  initialIndex: number
  onClose: () => void
  // Hub integration (optional)
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

const comboAdapter: KeycodeEntryModalAdapter<ComboEntry> = {
  testIdPrefix: 'combo',
  favoriteType: 'combo',
  titleKey: 'editor.combo.editTitle',
  titleParams: (index) => ({ index }),
  keycodeFields: [
    { key: 'key1', labelKey: 'editor.combo.key', labelOpts: { number: 1 } },
    { key: 'key2', labelKey: 'editor.combo.key', labelOpts: { number: 2 } },
    { key: 'key3', labelKey: 'editor.combo.key', labelOpts: { number: 3 } },
    { key: 'key4', labelKey: 'editor.combo.key', labelOpts: { number: 4 } },
    { key: 'output', labelKey: 'editor.combo.output' },
  ],
  createEmptyEntry: () => ({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }),
  isConfigured: (e) => e.key1 !== 0 || e.key2 !== 0,
  guardCodes: (e) => [e.key1, e.key2, e.key3, e.key4, e.output],
  closeOnSave: true,
}

export function ComboPanelModal({
  entries,
  onSetEntry,
  unlocked,
  onUnlock,
  tapDanceEntries,
  deserializedMacros,
  initialIndex,
  onClose,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRenameOnHub,
  quickSelect,
  splitKeyMode,
  basicViewType,
}: Props) {
  const hook = useKeycodeEntryModal(comboAdapter, {
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

  const hubProps = pickHubProps({
    hubOrigin, hubNeedsDisplayName, hubUploading, hubUploadResult,
    onUploadToHub, onUpdateOnHub, onRemoveFromHub, onRenameOnHub,
  })

  return (
    <KeycodeEntryModalShell
      adapter={comboAdapter}
      hook={hook}
      index={initialIndex}
      quickSelect={quickSelect}
      splitKeyMode={splitKeyMode}
      basicViewType={basicViewType}
      hubProps={hubProps}
    />
  )
}
