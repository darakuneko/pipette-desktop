// SPDX-License-Identifier: GPL-2.0-or-later
// History-row cell that opens the per-word keystroke timeline
// (WordTimelineView) for a run — mirrors TypingTestHistory's own
// `NameCell`: a text-action button + local open/closed state. Rendered
// only when the run actually has a saved keystroke log (requirement 7:
// the affordance must be invisible, not disabled, for a run with none).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { Tooltip } from '../components/ui/Tooltip'
import { LOAD_BTN } from '../components/editors/store-modal-shared'
import { WordTimelineView } from './WordTimelineView'

interface Props {
  result: TypingTestResult
  uid: string
  availableRunIds: ReadonlySet<string>
}

export function HistoryTimelineCell({ result, uid, availableRunIds }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (!result.runId || !availableRunIds.has(result.runId)) {
    return <td className="px-3 py-1.5" />
  }
  const runId = result.runId

  return (
    <td className="px-3 py-1.5">
      {/* Text link (not an icon button) matching the row's other text-action
       *  conventions (Delete/Load in HistoryResultsPanel) — LOAD_BTN is the
       *  accent-colored twin of DELETE_BTN, the same row-button shape used
       *  for non-destructive actions elsewhere in these History rows. The
       *  Tooltip is kept even though the link now has visible text: its
       *  copy ("Open keystroke timeline") clarifies WHAT opens beyond the
       *  short "Timeline" label. No aria-label on the button itself — the
       *  visible text already supplies its accessible name. */}
      <Tooltip content={t('editor.typingTest.history.timeline.openButton')}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={LOAD_BTN}
          data-testid={`history-timeline-open-${result.date}`}
        >
          {t('editor.typingTest.history.timeline.linkLabel')}
        </button>
      </Tooltip>
      {open && (
        <WordTimelineView
          uid={uid}
          runId={runId}
          result={result}
          onClose={() => setOpen(false)}
        />
      )}
    </td>
  )
}
