// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MacroEditor } from './MacroEditor'
import { ModalCloseButton } from './ModalCloseButton'
import type { MacroAction } from '../../../preload/macro'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { FavHubEntryResult } from './FavoriteHubActions'

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
}: Props) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const modalWidth = isDummy ? 'w-[1000px]' : 'w-[1050px]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="macro-modal-backdrop"
      onClick={onClose}
    >
      <div
        className={`rounded-lg bg-surface-alt shadow-xl ${modalWidth} max-w-[90vw] h-[80vh] flex flex-col overflow-hidden`}
        data-testid="macro-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {!isEditing && (
          <div className="px-6 pt-6 pb-4 shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {t('editor.macro.editTitle', { index })}
              </h3>
              <ModalCloseButton testid="macro-modal-close" onClick={onClose} />
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
            tapDanceEntries={tapDanceEntries}
            deserializedMacros={deserializedMacros}
            hubOrigin={hubOrigin}
            hubNeedsDisplayName={hubNeedsDisplayName}
            hubUploading={hubUploading}
            hubUploadResult={hubUploadResult}
            onUploadToHub={onUploadToHub}
            onUpdateOnHub={onUpdateOnHub}
            onRemoveFromHub={onRemoveFromHub}
          />
        </div>
      </div>
    </div>
  )
}
