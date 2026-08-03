// SPDX-License-Identifier: GPL-2.0-or-later
// Shared "missed characters" list + error-class (Substitution/Omission/
// Insertion) line — extracted out of `TypingTestStatsRow` (the
// completion screen's finished-state summary) so `KeystrokeTimelinePanel`
// can show the identical presentation for a `TypingTestResult` without a
// second, drifting implementation of the same sort/slice/testid logic.
// See .claude/plans/Plan-completion-timeline-view.md PR-A spec point 2.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

// Caps how many distinct mistake keys are shown, so a run with many
// small errors doesn't turn the list into an unbounded wall of text.
export const MAX_MISTAKE_ENTRIES = 12

/** Sorted by count DESC then key ASC (ties break deterministically
 *  instead of on object insertion order), capped to `max` entries. */
export function sortedMistakeEntries(mistakes: Record<string, number>, max: number = MAX_MISTAKE_ENTRIES): [string, number][] {
  return Object.entries(mistakes)
    .sort(([keyA, countA], [keyB, countB]) => countB - countA || keyA.localeCompare(keyB))
    .slice(0, max)
}

interface MissedCharsListProps {
  mistakes: Record<string, number>
}

/** Renders nothing when `mistakes` has no entries — omitted entirely
 *  rather than a '-' placeholder, matching this run's "the metric
 *  doesn't apply" convention (a run with zero mistakes is common, not an
 *  in-progress state). */
export function MissedCharsList({ mistakes }: MissedCharsListProps) {
  const { t } = useTranslation()
  const entries = useMemo(() => sortedMistakeEntries(mistakes), [mistakes])
  if (entries.length === 0) return null
  return (
    <div data-testid="typing-test-mistakes" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-content-muted">
      <span>{t('editor.typingTest.results.mistakesLabel')}:</span>
      {entries.map(([key, count]) => (
        <span key={key} data-testid={`typing-test-mistake-${key}`} className="font-mono">
          {key}:{count}
        </span>
      ))}
    </div>
  )
}

export interface ErrorClassCounts {
  substitutions: number
  omissions: number
  insertions: number
}

interface ErrorClassLineProps {
  errorClasses: ErrorClassCounts
}

/** Raw Substitution/Omission/Insertion counts (see
 *  `TypingTestResult.errorSubstitutions` et al.) — the caller withholds
 *  this entirely (never renders a '-' row) when the run has no error-class
 *  group at all (romaji run, no finalized words, legacy result). */
export function ErrorClassLine({ errorClasses }: ErrorClassLineProps) {
  const { t } = useTranslation()
  return (
    <div data-testid="typing-test-error-classes" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-content-muted">
      <span data-testid="typing-test-error-substitutions">
        {t('editor.typingTest.results.errorSubstitutions', { count: errorClasses.substitutions })}
      </span>
      <span data-testid="typing-test-error-omissions">
        {t('editor.typingTest.results.errorOmissions', { count: errorClasses.omissions })}
      </span>
      <span data-testid="typing-test-error-insertions">
        {t('editor.typingTest.results.errorInsertions', { count: errorClasses.insertions })}
      </span>
    </div>
  )
}
