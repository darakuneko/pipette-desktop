// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { TypingTestHistory } from '../../typing-test/TypingTestHistory'
import { ModalCloseButton } from './ModalCloseButton'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

// History opens a modal — it is a dialog trigger, not a stateful toggle, so the
// button keeps a single static style whether the modal is open or closed.
const HISTORY_BUTTON_CLASS =
  'flex h-8 w-full items-center justify-center rounded-md border border-edge px-3 text-sm text-content-secondary transition-colors hover:text-content'

interface HistoryToggleProps {
  results: TypingTestResult[]
  deviceName?: string
  onRename?: (date: string, name: string) => void
  onDelete?: (date: string) => void
}

export function HistoryToggle({ results, deviceName, onRename, onDelete }: HistoryToggleProps) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)

  const handleExportCsv = useCallback((csv: string, filterSlug: string) => {
    const base = deviceName ? `${deviceName}_typing-test-history` : 'typing-test-history'
    window.vialAPI.exportCsv(csv, filterSlug ? `${base}_${filterSlug}` : base)
  }, [deviceName])

  const closeHistory = useCallback(() => setShowHistory(false), [])
  useEscapeClose(closeHistory, showHistory)

  return (
    <>
      <button
        type="button"
        data-testid="typing-test-history-toggle"
        className={HISTORY_BUTTON_CLASS}
        onClick={() => setShowHistory((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={showHistory}
      >
        {t('editor.typingTest.history.title')}
      </button>
      {showHistory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          data-testid="history-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-modal-title"
          onClick={() => setShowHistory(false)}
        >
          <div
            className="flex h-modal-80vh w-modal-wide max-w-modal-vw flex-col rounded-lg bg-surface-alt p-6 shadow-xl"
            data-testid="history-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 id="history-modal-title" className="text-lg font-semibold">{t('editor.typingTest.history.title')}</h3>
              <ModalCloseButton testid="history-modal-close" onClick={() => setShowHistory(false)} />
            </div>
            <TypingTestHistory results={results} onExportCsv={handleExportCsv} onRename={onRename} onDelete={onDelete} deviceName={deviceName} />
          </div>
        </div>
      )}
    </>
  )
}
