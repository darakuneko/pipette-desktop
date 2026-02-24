// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { MacroEditor } from './MacroEditor'
import { ModalCloseButton } from './ModalCloseButton'

interface Props {
  index: number
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  vialProtocol: number
  onSaveMacros: (buffer: number[]) => Promise<void>
  onClose: () => void
  unlocked?: boolean
  onUnlock?: () => void
  isDummy?: boolean
}

export function MacroModal({
  index,
  macroCount,
  macroBufferSize,
  macroBuffer,
  vialProtocol,
  onSaveMacros,
  onClose,
  unlocked,
  onUnlock,
  isDummy,
}: Props) {
  const { t } = useTranslation()
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
        <div className="px-6 pt-6 pb-4 flex items-center justify-between shrink-0">
          <h3 className="text-lg font-semibold">
            {t('editor.macro.editTitle', { index })}
          </h3>
          <ModalCloseButton testid="macro-modal-close" onClick={onClose} />
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MacroEditor
            macroCount={macroCount}
            macroBufferSize={macroBufferSize}
            macroBuffer={macroBuffer}
            vialProtocol={vialProtocol}
            onSaveMacros={onSaveMacros}
            onClose={onClose}
            initialMacro={index}
            unlocked={unlocked}
            onUnlock={onUnlock}
            isDummy={isDummy}
          />
        </div>
      </div>
    </div>
  )
}
