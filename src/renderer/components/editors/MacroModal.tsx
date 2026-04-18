// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MacroEditor } from './MacroEditor'
import { ModalCloseButton } from './ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import type { MacroAction } from '../../../preload/macro'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

interface Props {
  index: number
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  vialProtocol: number
  onSaveMacros: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
  parsedMacros?: MacroAction[][] | null
  onClose: () => void
  unlocked?: boolean
  onUnlock?: () => void
  isDummy?: boolean
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
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
  autoAdvance?: boolean
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
  layers?: number
}

export function MacroModal({
  index,
  macroCount,
  macroBufferSize,
  macroBuffer,
  vialProtocol,
  onSaveMacros,
  parsedMacros,
  onClose,
  unlocked,
  onUnlock,
  isDummy,
  tapDanceEntries,
  deserializedMacros,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRenameOnHub,
  quickSelect,
  autoAdvance,
  splitKeyMode,
  basicViewType,
  layers,
}: Props) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const modalWidth = isDummy ? 'w-[1200px]' : 'w-[1300px]'
  const modalHeight = isEditing ? 'max-h-[90vh]' : 'h-[90vh]'

  useEscapeClose(onClose, !isRecording && !isEditing)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="macro-modal-backdrop"
      onClick={isRecording ? undefined : onClose}
    >
      <div
        className={`rounded-lg bg-surface-alt shadow-xl ${modalWidth} max-w-[95vw] ${modalHeight} flex flex-col overflow-hidden`}
        data-testid="macro-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {!isEditing && (
          <div className="px-6 pt-6 pb-4 shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {t('editor.macro.editTitle', { index })}
              </h3>
              {!isRecording && (
                <ModalCloseButton testid="macro-modal-close" onClick={onClose} />
              )}
            </div>
            <p className="mt-1 text-xs text-warning">{t('editor.macro.unlockWarning')}</p>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MacroEditor
            macroCount={macroCount}
            macroBufferSize={macroBufferSize}
            macroBuffer={macroBuffer}
            vialProtocol={vialProtocol}
            onSaveMacros={onSaveMacros}
            parsedMacros={parsedMacros}
            onClose={onClose}
            initialMacro={index}
            unlocked={unlocked}
            onUnlock={onUnlock}
            isDummy={isDummy}
            onEditingChange={setIsEditing}
            onRecordingChange={setIsRecording}
            tapDanceEntries={tapDanceEntries}
            deserializedMacros={deserializedMacros}
            hubOrigin={hubOrigin}
            hubNeedsDisplayName={hubNeedsDisplayName}
            hubUploading={hubUploading}
            hubUploadResult={hubUploadResult}
            onUploadToHub={onUploadToHub}
            onUpdateOnHub={onUpdateOnHub}
            onRemoveFromHub={onRemoveFromHub}
            onRenameOnHub={onRenameOnHub}
            quickSelect={quickSelect}
            autoAdvance={autoAdvance}
            splitKeyMode={splitKeyMode}
            basicViewType={basicViewType}
            layers={layers}
          />
        </div>
      </div>
    </div>
  )
}
