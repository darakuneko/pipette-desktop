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

/* Completion screen (Plan-completion-timeline-view PR-B): once a run
    finishes WITH a matching in-memory log, the shared
    KeystrokeTimelinePanel — same unified stat block, legend, zoom,
    and rows as History's timeline modal — replaces the old compact
    stats row entirely (it already contains the Missed/error-mix
    lines the old row also showed, so both would otherwise
    duplicate). Rendered above the finished-state controls row below
    (moved to the bottom of the completion screen so the
    timeline/stats content reads first).

    FLEX-HEIGHT CHAIN (codex safety review of an earlier, fixed-vh
    `rowsMaxHeightClass` cap — replaced because a fixed vh figure
    can't adapt to how much OTHER chrome a given run actually has:
    Lines=1 leaves less sidebar height claimed, an IME-composition
    warning or the Missed-chars line adds MORE panel-internal
    content, and the editor's own content pane doesn't reserve a
    fixed fraction of the window either — any single vh number is
    right for some combination of these and wrong for others). This
    wrapper (`isFinished`-only) is the top of a chain that makes the
    rows area the ONLY thing that scrolls, by making every link
    between it and the nearest real bounded ancestor stretch instead
    of taking its natural content height:
      KeymapEditor.tsx's own `overflow-auto` content-pane row (the
      true bound — pre-existing, unrelated to typing-test) → its
      `keymap-surface` child (pre-existing `min-h-0 flex-1`) →
      TypingTestPane.tsx's outer `items-stretch` row (pre-existing
      `min-h-0 flex-1`) → TypingTestPane.tsx's `items-center` column
      (now ALSO `min-h-0`, alongside its pre-existing `flex-1`) →
      this component's own root (`min-h-0 flex-1`, but ONLY once
      `isFinished` — see its own className comment above) → THIS
      wrapper (`min-h-0 flex-1 flex-col`) → the timeline panel
      (`min-h-0 flex-1`) → KeystrokeTimelinePanel's OWN root (already
      `flex min-h-0 flex-1 flex-col gap-3` — unchanged) → its stat
      grid / Missed-chars / legend / zoom (unchanged, naturally
      sized — `shrink-0` by simply never being given `flex-1`) → the
      rows scrollport (already `flex-1 min-h-0 overflow-auto` —
      unchanged, this is the only element that actually scrolls).
    The controls row below stays naturally sized (no flex-1) — it's
    the last child of a `flex-col` wrapper, so it just takes
    whatever height its own content needs and never grows, i.e. it
    is `shrink-0` in effect without needing the class name (a flex
    item's default `flex-shrink: 1` only matters when its siblings'
    combined natural height already exceeds the wrapper — since the
    rows area is the one absorbing the slack via its own `flex-1`,
    the controls row is never asked to shrink below its content). */
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
