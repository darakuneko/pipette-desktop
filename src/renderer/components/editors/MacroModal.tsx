// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect } from 'react'
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="macro-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="rounded-lg bg-surface-alt p-6 shadow-xl w-[900px] max-w-[90vw] max-h-[90vh] overflow-y-auto"
        data-testid="macro-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            {t('editor.macro.editTitle', { index })}
          </h3>
          <ModalCloseButton testid="macro-modal-close" onClick={onClose} />
        </div>

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
  )
}
