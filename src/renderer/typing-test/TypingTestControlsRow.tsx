// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen, Pause, Play, CircleCheck } from 'lucide-react'
import { ICON_SM, ICON_LG } from '../constants/ui-tokens'
import type { TypingTestState } from './useTypingTest'
import type { TypingTestConfig } from './types'
import { ResultNameModal } from './ResultNameModal'
import { Tooltip } from '../components/ui/Tooltip'

interface Props {
  state: TypingTestState
  config: TypingTestConfig
  /** Name the just-finished result inline from the completion screen
   *  (imported fileImport text only). Keyed to the most recent saved result. */
  onNameResult?: (name: string) => void
  /** Quick-insert chips for the result-name modal (material label, timestamp,
   *  WPM / KPM / Accuracy of the just-finished result). */
  resultNameChips?: string[]
  /** Start a fresh run (Next Test / Restart — both restart the test). */
  onStart?: () => void
  /** Memory mode (imported fileImport text): pause the running run. */
  onPause?: () => void
  /** Memory mode: open the resume dialog for a paused / saved run. */
  onResume?: () => void
  /** A paused fileImport run is saved and can be resumed. */
  hasSavedMemory?: boolean
}

/** State-based controls row, below the reading window:
 *  - not started (waiting / countdown): Next Test (+ Resume if a run is
 *    saved for imported fileImport text)
 *  - in progress (running / paused): Pause or Resume (fileImport) + Restart
 *  - finished: result name (fileImport) + Next Test
 *  Next Test and Restart share the same action; only the label differs.
 *
 *  The caller (TypingTestView) applies the `hideControls` visibility gate
 *  around this whole component (finished always overrides the hide), so
 *  this component itself doesn't need to know about that toggle. */
export function TypingTestControlsRow({
  state,
  config,
  onNameResult,
  resultNameChips = [],
  onStart,
  onPause,
  onResume,
  hasSavedMemory,
}: Props) {
  const { t } = useTranslation()

  return (
    <>
      {state.status === 'finished' && (
        <p data-testid="typing-test-complete" className="flex items-center gap-1.5 text-lg font-semibold text-accent">
          <CircleCheck size={ICON_LG} aria-hidden="true" />
          {t('editor.typingTest.complete')}
        </p>
      )}
      <div className="flex items-center gap-2">
        {config.mode === 'fileImport' && (
          state.status === 'running' ? (
            <button
              type="button"
              data-testid="typing-memory-pause"
              className="flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-sm text-content-secondary transition-colors hover:text-content"
              onClick={onPause}
            >
              <Pause size={ICON_SM} aria-hidden="true" />
              <span>{t('editor.typingTest.memory.pause')}</span>
            </button>
          ) : (state.status === 'paused' || ((state.status === 'waiting' || state.status === 'countdown') && hasSavedMemory)) ? (
            <button
              type="button"
              data-testid="typing-memory-resume"
              className="flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-sm text-accent transition-colors hover:text-accent/80"
              onClick={onResume}
            >
              <Play size={ICON_SM} aria-hidden="true" />
              <span>{t('editor.typingTest.memory.resumeButton')}</span>
            </button>
          ) : null
        )}
        {state.status === 'finished' && (
          <ResultNameField key={state.startTime ?? 'none'} onName={onNameResult} chips={resultNameChips} />
        )}
        <button
          type="button"
          data-testid={state.status === 'running' || state.status === 'paused' ? 'typing-test-restart' : 'typing-test-start'}
          className="flex h-8 items-center rounded-md border border-edge px-2.5 text-sm text-content-secondary transition-colors hover:text-content"
          onClick={onStart}
        >
          {t(state.status === 'running' || state.status === 'paused' ? 'editor.typingTest.restart' : 'editor.typingTest.nextTest')}
        </button>
      </div>
    </>
  )
}

/** Name for the just-finished result (imported fileImport text). A button showing
 *  the current name (or the "Unnamed" placeholder) with an edit icon; clicking
 *  opens the naming modal with quick-insert chips. Mounted with a per-test
 *  `key`, so the draft starts empty for a fresh result. */
function ResultNameField({ onName, chips }: { onName?: (name: string) => void; chips: string[] }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  const commit = (newName: string): void => {
    setName(newName)
    onName?.(newName)
  }

  return (
    <>
      <Tooltip content={t('editor.typingTest.nameResult')}>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          aria-label={t('editor.typingTest.nameResult')}
          className={`flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-sm transition-colors hover:text-content ${name ? 'text-content-secondary' : 'text-content-muted'}`}
          data-testid="typing-test-result-name"
        >
          <SquarePen size={ICON_SM} aria-hidden="true" />
          <span>{name || t('editor.typingTest.history.unnamed')}</span>
        </button>
      </Tooltip>
      {modalOpen && (
        <ResultNameModal
          initialName={name}
          chips={chips}
          onSave={commit}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}
