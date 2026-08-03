// SPDX-License-Identifier: GPL-2.0-or-later
// Row-opened detail view for a single run's per-word keystroke timeline
// (see .claude/tasks/backlog/Task-tm-phase5-word-timeline-ui.md). Nests
// inside the History modal (opened from `HistoryTimelineCell`), so its
// own Escape handling must consume the keydown before it can bubble up
// to the History modal's own bubble-phase `useEscapeClose` — this
// mirrors `JsonEditorModal`'s capture-phase + `stopPropagation` handler,
// the established pattern in this codebase for a modal nested inside
// another modal (`useEscapeSwallow` alone would also block THIS view's
// own close, since it swallows unconditionally with no action of its
// own — see its doc comment).
//
// This component owns only the modal shell (backdrop, title, close
// button) and the log fetch/loading/error states — the actual timeline
// content (stat block, legend, zoom, rows) lives in
// `KeystrokeTimelinePanel`, extracted out so a later PR can render the
// identical content inline on the completion screen (see
// .claude/plans/Plan-completion-timeline-view.md).

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { useEscapeCloseCapture } from '../hooks/useEscapeClose'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import { KeystrokeTimelinePanel } from './KeystrokeTimelinePanel'

interface Props {
  uid: string
  runId: string
  /** The already-displayed History row for this run, when known — see
   *  `KeystrokeTimelinePanel`'s own doc comment on its `result` prop. */
  result?: TypingTestResult
  onClose: () => void
}

export function WordTimelineView({ uid, runId, result, onClose }: Props) {
  const { t } = useTranslation()
  const [log, setLog] = useState<RunKeystrokeLog | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    window.vialAPI.typingRunLogGet(uid, runId)
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) setLog(res.data)
        else setLoadError(true)
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [uid, runId])

  // Nested inside the History modal — consume Escape in the capture
  // phase so History's own bubble-phase useEscapeClose never sees it.
  useEscapeCloseCapture(onClose)

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="word-timeline-title"
      data-testid="word-timeline-modal"
      // stopPropagation before closing: via the Analyze handoff
      // (HistoryToggle) this view mounts as a DIRECT SIBLING of History's
      // own backdrop div, not nested inside `history-modal` (which stops
      // propagation on its own click handler) — without this, a backdrop
      // click here would bubble up and close History too. The row-opened
      // path (HistoryTimelineCell) never observed this bug only because
      // it happens to nest inside `history-modal`'s own stop, not because
      // this component was doing the right thing itself.
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <div
        className="flex h-modal-80vh w-modal-wide max-w-modal-vw flex-col rounded-2xl border border-edge bg-surface-alt p-6 shadow-xl"
        data-testid="word-timeline-content"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id="word-timeline-title" className="text-lg font-semibold">
            {t('editor.typingTest.history.timeline.modalTitle')}
          </h3>
          <ModalCloseButton testid="word-timeline-close" onClick={onClose} />
        </div>

        {loading && (
          <p className="text-sm text-content-muted" data-testid="word-timeline-loading">
            {t('editor.typingTest.history.timeline.loading')}
          </p>
        )}
        {!loading && loadError && (
          <p className="text-sm text-danger" data-testid="word-timeline-error">
            {t('editor.typingTest.history.timeline.error')}
          </p>
        )}

        {!loading && !loadError && log && (
          <KeystrokeTimelinePanel log={log} result={result} />
        )}
      </div>
    </div>
  )
}
