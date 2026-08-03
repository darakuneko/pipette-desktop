// SPDX-License-Identifier: GPL-2.0-or-later
// History-row cell that opens the per-word keystroke timeline
// (WordTimelineView) for a run — mirrors TypingTestHistory's own
// `NameCell`: a small icon button + local open/closed state. Rendered
// only when the run actually has a saved keystroke log (requirement 7:
// the affordance must be invisible, not disabled, for a run with none).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChartNoAxesGantt } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { Tooltip } from '../components/ui/Tooltip'
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
      <Tooltip content={t('editor.typingTest.history.timeline.openButton')}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded p-1 text-content-muted transition-colors hover:text-content"
          aria-label={t('editor.typingTest.history.timeline.openButton')}
          data-testid={`history-timeline-open-${result.date}`}
        >
          <ChartNoAxesGantt size={ICON_SM} aria-hidden="true" />
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
