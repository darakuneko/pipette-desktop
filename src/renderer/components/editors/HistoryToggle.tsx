// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { TypingTestHistory } from '../../typing-test/TypingTestHistory'
import { ModalCloseButton } from './ModalCloseButton'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function historyToggleClass(active: boolean): string {
  const base = 'rounded-md border px-3 py-1 text-sm transition-colors'
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}

interface HistoryToggleProps {
  results: TypingTestResult[]
  deviceName?: string
}

export function HistoryToggle({ results, deviceName }: HistoryToggleProps) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)

  const handleExportCsv = useCallback((csv: string) => {
    const prefix = deviceName ? `${deviceName}_typing-test-history` : undefined
    window.vialAPI.exportCsv(csv, prefix)
  }, [deviceName])

  const closeHistory = useCallback(() => setShowHistory(false), [])
  useEscapeClose(closeHistory, showHistory)

  return (
    <>
      <button
        type="button"
        data-testid="typing-test-history-toggle"
        className={historyToggleClass(showHistory)}
        onClick={() => setShowHistory((v) => !v)}
        aria-pressed={showHistory}
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
            className="flex h-[80vh] w-[900px] max-w-[90vw] flex-col rounded-lg bg-surface-alt p-6 shadow-xl"
            data-testid="history-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 id="history-modal-title" className="text-lg font-semibold">{t('editor.typingTest.history.title')}</h3>
              <ModalCloseButton testid="history-modal-close" onClick={() => setShowHistory(false)} />
            </div>
            <TypingTestHistory results={results} onExportCsv={handleExportCsv} />
          </div>
        </div>
      )}
    </>
  )
}
