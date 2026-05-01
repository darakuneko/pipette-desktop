// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { KeycodeEntryModalAdapter } from '../../hooks/useKeycodeEntryModal'
import { useKeycodeEntryModal } from '../../hooks/useKeycodeEntryModal'
import { KeycodeEntryModalShell, pickHubProps } from './KeycodeEntryModalShell'
import type { FavHubEntryResult } from './FavoriteHubActions'

interface Props {
  index: number
  entry: TapDanceEntry
  onSave: (index: number, entry: TapDanceEntry) => Promise<void>
  onClose: () => void
  isDummy?: boolean
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
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
  vialProtocol: number
}

const TAPPING_TERM_MIN = 0
const TAPPING_TERM_MAX = 10000

const tdAdapter: KeycodeEntryModalAdapter<TapDanceEntry> = {
  testIdPrefix: 'td',
  favoriteType: 'tapDance',
  titleKey: 'editor.tapDance.editTitle',
  titleParams: (index) => ({ index }),
  keycodeFields: [
    { key: 'onTap', labelKey: 'editor.tapDance.onTap' },
    { key: 'onHold', labelKey: 'editor.tapDance.onHold' },
    { key: 'onDoubleTap', labelKey: 'editor.tapDance.onDoubleTap' },
    { key: 'onTapHold', labelKey: 'editor.tapDance.onTapHold' },
  ],
  createEmptyEntry: () => ({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 }),
  isConfigured: (e) => e.onTap !== 0 || e.onHold !== 0 || e.onDoubleTap !== 0 || e.onTapHold !== 0,
  guardCodes: () => [], // TapDance has no unlock guard
  closeOnSave: false,
  showFavorites: ({ isDummy }) => !isDummy,
  modalWidth: ({ isDummy }) => isDummy ? 'w-[900px]' : 'w-[1050px]',
}

export function TapDanceModal({
  index, entry, onSave, onClose, isDummy,
  tapDanceEntries, deserializedMacros,
  hubOrigin, hubNeedsDisplayName, hubUploading, hubUploadResult,
  onUploadToHub, onUpdateOnHub, onRemoveFromHub, onRenameOnHub,
  quickSelect, splitKeyMode, basicViewType, vialProtocol,
}: Props) {
  const { t } = useTranslation()

  const hook = useKeycodeEntryModal(tdAdapter, {
    entry,
    index,
    onSave,
    onClose,
    isDummy,
    quickSelect,
    vialProtocol,
    tapDanceEntries,
    deserializedMacros,
    splitKeyMode,
    basicViewType,
  })

  const { editedEntry, setEditedEntry } = hook

  const handleTappingTermChange = (value: string) => {
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const numValue = Math.max(TAPPING_TERM_MIN, Math.min(TAPPING_TERM_MAX, parsed))
    setEditedEntry((prev) => prev ? { ...prev, tappingTerm: numValue } : prev)
  }

  const hubProps = pickHubProps({
    hubOrigin, hubNeedsDisplayName, hubUploading, hubUploadResult,
    onUploadToHub, onUpdateOnHub, onRemoveFromHub, onRenameOnHub,
  })

  return (
    <KeycodeEntryModalShell
      adapter={tdAdapter}
      hook={hook}
      index={index}
      quickSelect={quickSelect}
      splitKeyMode={splitKeyMode}
      basicViewType={basicViewType}
      hubProps={hubProps}
      renderAfterFields={() => (
        <div className="flex items-center gap-3">
          <label className="min-w-[140px] text-sm text-content">
            {t('editor.tapDance.tappingTerm')}
          </label>
          <input
            type="number"
            min={TAPPING_TERM_MIN}
            max={TAPPING_TERM_MAX}
            value={editedEntry?.tappingTerm ?? 0}
            onChange={(e) => handleTappingTermChange(e.target.value)}
            className="flex-1 rounded border border-edge px-2 py-1 text-sm"
          />
        </div>
      )}
    />
  )
}
