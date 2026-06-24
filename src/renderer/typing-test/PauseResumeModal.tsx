// SPDX-License-Identifier: GPL-2.0-or-later
// Confirmation shown when the user resumes a paused imported-text typing
// test (memory mode): continue from where they left off, or start over.

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { BTN_SECONDARY, BTN_ACCENT_OUTLINE } from '../constants/ui-tokens'

interface Props {
  /** Word progress of the saved snapshot, shown for context. */
  wordIndex: number
  totalWords: number
  /** Continue from the saved position. */
  onResume: () => void
  /** Discard the snapshot and start the text from the beginning. */
  onRestart: () => void
  /** Dismiss without choosing (Cancel / Esc / backdrop). */
  onCancel: () => void
}

export function PauseResumeModal({ wordIndex, totalWords, onResume, onRestart, onCancel }: Props) {
  const { t } = useTranslation()
  const backdropRef = useRef<HTMLDivElement>(null)

  useEscapeClose(onCancel)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onCancel()
  }, [onCancel])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-labelledby="typing-resume-title"
      onClick={handleBackdropClick}
      data-testid="typing-resume-modal"
    >
      <div className="flex w-modal-typing flex-col rounded-2xl border border-edge bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id="typing-resume-title" className="text-lg font-semibold text-content">
            {t('editor.typingTest.memory.resumeTitle')}
          </h2>
          <ModalCloseButton testid="typing-resume-close" onClick={onCancel} />
        </div>

        <div className="px-5 py-4 text-sm text-content-secondary">
          {t('editor.typingTest.memory.resumeBody', { current: wordIndex, total: totalWords })}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
          <button
            type="button"
            data-testid="typing-resume-restart"
            onClick={onRestart}
            className={BTN_SECONDARY}
          >
            {t('editor.typingTest.memory.restart')}
          </button>
          <button
            type="button"
            data-testid="typing-resume-resume"
            onClick={onResume}
            className={BTN_ACCENT_OUTLINE}
          >
            {t('editor.typingTest.memory.resume')}
          </button>
        </div>
      </div>
    </div>
  )
}
