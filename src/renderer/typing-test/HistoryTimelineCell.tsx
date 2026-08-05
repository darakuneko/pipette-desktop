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
  const label = t('editor.typingTest.history.timeline.linkLabel')

  return (
    <td className="px-3 py-1.5">
      {/* Text link (not an icon button) matching the row's other text-action
       *  conventions (Delete/Load in HistoryResultsPanel) — LOAD_BTN is the
       *  accent-colored twin of DELETE_BTN, the same row-button shape used
       *  for non-destructive actions elsewhere in these History rows.
       *
       *  Variable-width like Name/Mode (NameCell/ModeCell in
       *  HistoryResultsPanel): `truncate` (which already implies
       *  whitespace-nowrap, so the label can never break mid-word) plus a
       *  Tooltip surfacing the full label when it overflows. COL_TIMELINE is
       *  sized to fit English "Timeline" / standard Japanese "タイムライン"
       *  without truncating — longer persona strings (e.g. 京言葉's 9-char
       *  "タイムラインどすえ") may ellipsis, same tradeoff Name/Mode already
       *  make. No aria-label on the button — its own (possibly truncated)
       *  text plus the Tooltip's full-text bubble already supply the
       *  accessible name/description. */}
      <Tooltip content={label} wrapperClassName="block max-w-full">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${LOAD_BTN} block w-full text-left`}
          data-testid={`history-timeline-open-${result.date}`}
        >
          <span className="block truncate">{label}</span>
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
