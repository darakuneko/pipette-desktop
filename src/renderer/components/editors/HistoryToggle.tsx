// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { useRunLogAvailability } from '../../hooks/useRunLogAvailability'
import type { TimelineHandoff } from '../../hooks/useRunTimelineHandoff'
import { TypingTestHistory } from '../../typing-test/TypingTestHistory'
import { WordTimelineView } from '../../typing-test/WordTimelineView'
import { ModalCloseButton } from './ModalCloseButton'
import { MODAL_2XL } from './store-modal-shared'
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
  /** Keyboard uid — drives the per-row "open keystroke timeline" cell
   *  (see `useRunLogAvailability`); the column is omitted when unset. */
  uid?: string
  /** Analyze -> Typing Test "open timeline" handoff (consume-once): set
   *  by App.tsx's `useRunTimelineHandoff` once the typing test view has
   *  re-entered. Bundling the runId with its own close handler (rather
   *  than threading two separate optional props) makes "a runId with no
   *  way to consume it" unrepresentable. */
  timelineHandoff?: TimelineHandoff | null
}

export function HistoryToggle({
  results, deviceName, onRename, onDelete, uid, timelineHandoff,
}: HistoryToggleProps) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)
  // Bumped every time History opens (never on close) — feeds
  // `useRunLogAvailability`'s effect dep so the run-log list is refetched
  // on EVERY open, not just the first. See that hook's own doc comment
  // for why "fetch once, ever" missed a run that finishes after the
  // user's first History open.
  const [openSeq, setOpenSeq] = useState(0)
  useEffect(() => {
    if (showHistory) setOpenSeq((s) => s + 1)
  }, [showHistory])
  const { availableRunIds } = useRunLogAvailability(uid ?? null, openSeq)

  // Analyze handoff — jump straight into History instead of making the
  // user find and click the toggle themselves.
  useEffect(() => {
    if (timelineHandoff) setShowHistory(true)
  }, [timelineHandoff])

  const handleExportCsv = useCallback((csv: string, filterSlug: string) => {
    const base = deviceName ? `${deviceName}_typing-test-history` : 'typing-test-history'
    window.vialAPI.exportCsv(csv, filterSlug ? `${base}_${filterSlug}` : base)
  }, [deviceName])

  // Closing History either way (Escape / backdrop / close button) fully
  // consumes a pending handoff too, so a later manual History open
  // never reopens a timeline the user already dismissed.
  const closeHistory = useCallback(() => {
    setShowHistory(false)
    timelineHandoff?.onConsumed()
  }, [timelineHandoff])
  useEscapeClose(closeHistory, showHistory)

  const handoffResult = timelineHandoff
    ? results.find((r) => r.runId === timelineHandoff.runId)
    : undefined

  return (
    <>
      <button
        type="button"
        data-testid="typing-test-history-toggle"
        className={HISTORY_BUTTON_CLASS}
        onClick={() => (showHistory ? closeHistory() : setShowHistory(true))}
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
          onClick={closeHistory}
        >
          <div
            className={`flex h-modal-80vh ${MODAL_2XL} flex-col rounded-lg bg-surface-alt p-6 shadow-xl`}
            data-testid="history-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 id="history-modal-title" className="text-lg font-semibold">{t('editor.typingTest.history.title')}</h3>
              <ModalCloseButton testid="history-modal-close" onClick={closeHistory} />
            </div>
            <TypingTestHistory results={results} onExportCsv={handleExportCsv} onRename={onRename} onDelete={onDelete} deviceName={deviceName} uid={uid} availableRunIds={availableRunIds} />
          </div>
          {/* Analyze handoff: opens beside the History table itself,
           * same nesting `HistoryTimelineCell` uses for a per-row open,
           * so a missing/failed log falls back to WordTimelineView's
           * own graceful loading/error state rather than blocking on
           * `availableRunIds` (not fetched until History is open). */}
          {uid && timelineHandoff && (
            <WordTimelineView
              uid={uid}
              runId={timelineHandoff.runId}
              result={handoffResult}
              onClose={timelineHandoff.onConsumed}
            />
          )}
        </div>
      )}
    </>
  )
}
