// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { Props } from './typing-test-view-model'
import { TypingTestControlsRow } from './TypingTestControlsRow'
import { TypingTestStatsRow } from './TypingTestStatsRow'
import { KeystrokeTimelinePanel } from './KeystrokeTimelinePanel'

interface FinishedSectionProps {
  state: Props['state']
  wpm: Props['wpm']
  kpm: number
  accuracy: Props['accuracy']
  kspc: number | null
  elapsedSeconds: Props['elapsedSeconds']
  remainingSeconds: Props['remainingSeconds']
  config: Props['config']
  comparison: Props['comparison']
  errorClasses: { substitutions: number; omissions: number; insertions: number } | null
  timelineLog: RunKeystrokeLog | null
  finishedResult: TypingTestResult | null
  lastFinishedLog: RunKeystrokeLog | null
  onNameResult: Props['onNameResult']
  resultNameChips: string[]
  onStart: Props['onStart']
  onPause: Props['onPause']
  onResume: Props['onResume']
  hasSavedMemory: Props['hasSavedMemory']
}

/* Completion screen: once a run finishes WITH a matching in-memory
    log, the shared KeystrokeTimelinePanel — same unified stat block,
    legend, zoom, and rows as History's timeline modal — renders in
    place of the compact stats row (it already contains the
    Missed/error-mix lines that row would otherwise duplicate). It
    renders above the finished-state controls row below, which sits
    at the bottom of the completion screen so the timeline/stats
    content reads first.

    FLEX-HEIGHT CHAIN: how much OTHER chrome sits around the timeline
    rows varies per run on the completion screen — whether the panel's
    correctness-markers note is showing above the stat grid
    (`activeCharCorrelationUnavailable`), whether its Missed box is
    showing below the rows (`hasMistakes`), and the editor's own
    content pane doesn't reserve a fixed fraction of the window for
    typing-test content either — so a fixed-vh height cap on the rows
    can't fit every combination. This wrapper (`isFinished`-only) is
    instead one link in a chain that stretches every ancestor between
    the rows scrollport and the nearest real bounded ancestor, so the
    rows scrollport ends up sized to the actual remaining space and
    scrolls internally:
      KeymapEditor.tsx's content row in typing-test mode, non-view-only
      (`flex min-h-0 flex-1 items-stretch gap-2 overflow-auto` — the
      outermost link named here, sized by `editor-content`
      (AppEditorSurface.tsx) up to App.tsx's `h-screen` root) → its
      `keymap-surface` child (`flex min-h-0 min-w-0 flex-1 flex-col
      gap-3`) → TypingTestPane.tsx's outer `items-stretch` row (`flex
      min-h-0 w-full flex-1 items-stretch gap-2`) → TypingTestPane.tsx's
      `items-center` column (`flex min-h-0 min-w-0 flex-1 flex-col
      items-center`) → TypingTestView's own root (`min-h-0 flex-1`,
      appended to its other classes only once `isFinished` — see the
      comment above its root div in TypingTestView.tsx) → THIS wrapper
      (`flex min-h-0 w-full flex-1 flex-col items-center gap-4`) → the
      div wrapping KeystrokeTimelinePanel (`flex min-h-0 w-full flex-1
      flex-col`) → KeystrokeTimelinePanel's own root (`flex min-h-0
      flex-1 flex-col gap-3`) → its bordered box (`flex min-h-0 flex-1
      flex-col gap-3 rounded-md border border-edge bg-surface p-3`,
      `typing-test-timeline-box`) → the rows scrollport
      (`keystroke-timeline-scrollport`, `min-h-0 flex-1 overflow-auto`).
      The comment above that bordered box — including its HEIGHT
      PRIORITY section — covers how it and the Missed box below it
      share the remaining height; the scrollport's own comment
      explains why it is the one that scrolls internally. The Missed
      box's own wrapper (`min-h-0`, `typing-test-missed-box`) keeps its
      content size — the timeline box above it is the one carrying
      `flex-1` and taking the remaining space — but being `min-h-0`
      it can still shrink when space runs short; only its rows use a
      separately capped scrollport (`missed-table-scrollport`,
      `overflow-y-auto` with a `maxHeightClass`) in `MissedTable`
      (mistake-summary.tsx).
    The controls row below has no `flex-1` — it takes its own content
    height as the last child of this flex-col wrapper, while the
    timeline area's `flex-1` above it takes the remaining space. */
export function TypingTestFinishedSection({
  state,
  wpm,
  kpm,
  accuracy,
  kspc,
  elapsedSeconds,
  remainingSeconds,
  config,
  comparison,
  errorClasses,
  timelineLog,
  finishedResult,
  lastFinishedLog,
  onNameResult,
  resultNameChips,
  onStart,
  onPause,
  onResume,
  hasSavedMemory,
}: FinishedSectionProps) {
  const { t } = useTranslation()
  return (
    <div data-testid="typing-test-finished-wrapper" className="flex min-h-0 w-full flex-1 flex-col items-center gap-4">
      {timelineLog ? (
        <div className="flex min-h-0 w-full flex-1 flex-col" data-testid="typing-test-timeline-panel">
          <KeystrokeTimelinePanel log={timelineLog} result={finishedResult ?? undefined} />
        </div>
      ) : (
        <>
          <TypingTestStatsRow
            state={state}
            wpm={wpm}
            kpm={kpm}
            accuracy={accuracy}
            kspc={kspc}
            elapsedSeconds={elapsedSeconds}
            remainingSeconds={remainingSeconds}
            config={config}
            comparison={comparison}
            errorClasses={errorClasses}
          />
          {/* No log to show a timeline for (recording consent was off,
              view-only, or nothing saveable) — hint that enabling it
              would surface this same panel next time. Omitted for a
              stale-runId log (present but not yet matching this run)
              since that's a transient rendering edge, not "no
              consent". */}
          {!lastFinishedLog && (
            <p data-testid="typing-test-timeline-consent-hint" className="text-xs text-content-muted">
              {t('editor.typingTest.results.timelineConsentHint')}
            </p>
          )}
        </>
      )}
      {/* Finished-state controls row (result name + Next Test) —
          deliberately LAST, below the timeline panel (or the fallback
          stats row + consent hint above), not above it — the
          timeline/stats content is what the user reads first once a
          run finishes; naming the result and starting the next one is
          the closing action. */}
      <TypingTestControlsRow
        state={state}
        config={config}
        onNameResult={onNameResult}
        resultNameChips={resultNameChips}
        onStart={onStart}
        onPause={onPause}
        onResume={onResume}
        hasSavedMemory={hasSavedMemory}
      />
    </div>
  )
}
