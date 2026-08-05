// SPDX-License-Identifier: GPL-2.0-or-later
// History-row cell that opens the per-word keystroke timeline
// (WordTimelineView) for a run — mirrors TypingTestHistory's own
// `NameCell`: a text-action button + local open/closed state. Rendered
// only when the run actually has a saved keystroke log (requirement 7:
// the affordance must be invisible, not disabled, for a run with none).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
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
       *  for non-destructive actions elsewhere in these History rows.
       *
       *  Plain full label, no truncation, no Tooltip: COL_TIMELINE is a
       *  snug fixed-width column sized to fit every built-in pack's
       *  Timeline label in full at this table's font size (see
       *  HistoryResultsPanel) — the strings themselves are kept within
       *  that budget (persona packs that ran long, e.g. 京言葉's original
       *  9-char "タイムラインどすえ", were shortened instead of the column
       *  being widened to fit them), so there's never anything left to
       *  truncate or need a tooltip for. No aria-label on the button — its
       *  own visible text already supplies the accessible name. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${LOAD_BTN} whitespace-nowrap`}
        data-testid={`history-timeline-open-${result.date}`}
      >
        {t('editor.typingTest.history.timeline.linkLabel')}
      </button>
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
