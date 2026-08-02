// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestState } from './useTypingTest'
import type { TypingTestConfig } from './types'
import type { ComparisonStats } from './comparison'
import { isTimeBoundedRun } from './types'
import { formatKspc } from '../../shared/kspc'

// Completion screen's "missed characters" list (Phase 1 of mistake
// analysis — see TypingTestState.mistakes) caps how many distinct
// mistake keys are shown, so a run with many small errors doesn't turn
// the results row into an unbounded wall of text.
const MAX_MISTAKE_ENTRIES = 12

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

interface Props {
  state: TypingTestState
  wpm: number
  /** Keystrokes per minute — shown instead of WPM in fileImport mode. */
  kpm?: number
  accuracy: number
  /** Keystrokes per confirmed character (see `useTypingTest`'s `kspc`).
   *  `null`/`undefined` shows '-', same as before measuring starts. */
  kspc?: number | null
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  /** Baseline metrics for the Measurement-row comparison delta, or null when
   *  comparison is off / no matching history. */
  comparison?: ComparisonStats | null
  /** Error-class raw counts (see `TypingTestResult.errorSubstitutions` et
   *  al.) from the just-finished result, or `null` when the result has
   *  none (romaji run, no finalized words, or a legacy pre-error-class
   *  result) — the completion screen's error-mix line is omitted
   *  entirely rather than showing a '-' placeholder, since (unlike WPM /
   *  KSPC) "the metric doesn't apply to this run" is common, not an
   *  in-progress state. */
  errorClasses?: { substitutions: number; omissions: number; insertions: number } | null
}

/** Measurement / results row — below the reading window and the
 *  Unnamed / Next Test row. Live metrics during a run; before measuring
 *  (waiting / countdown) every value reads "-".
 *
 *  The caller (TypingTestView) applies the `hideStatsRow` visibility gate
 *  around this whole component (finished always overrides the hide), so
 *  this component itself doesn't need to know about that toggle. */
export function TypingTestStatsRow({
  state,
  wpm,
  kpm = 0,
  accuracy,
  kspc = null,
  elapsedSeconds,
  remainingSeconds,
  config,
  comparison,
  errorClasses = null,
}: Props) {
  const { t } = useTranslation()
  const showStats = state.status === 'running' || state.status === 'finished' || state.status === 'paused'

  // Char-progress modes (imported fileImport text; Tatoeba sentences) count
  // progress by character (spaces included): each word-gap is one separator
  // char, so total = Σ word lengths + (words - 1). Gated on the mode (not
  // `lines`) so single-line / word-flow sources count chars too.
  const charProgress = config.mode === 'fileImport' || config.mode === 'tatoeba'
  const totalChars = useMemo(
    () => (charProgress ? state.words.reduce((sum, w) => sum + w.length, 0) + Math.max(0, state.words.length - 1) : 0),
    [charProgress, state.words],
  )
  const typedChars = useMemo(() => {
    if (!charProgress) return 0
    let sum = state.currentInput.length
    for (let i = 0; i < state.currentWordIndex && i < state.words.length; i++) sum += state.words[i].length
    sum += Math.min(state.currentWordIndex, Math.max(0, state.words.length - 1)) // separators passed
    return Math.min(sum, totalChars)
  }, [charProgress, state.words, state.currentWordIndex, state.currentInput, totalChars])

  // Completion screen's missed-characters list: sorted by count DESC then
  // key ASC (ties break deterministically instead of on object insertion
  // order), capped to the top MAX_MISTAKE_ENTRIES.
  const mistakeEntries = useMemo(
    () =>
      Object.entries(state.mistakes)
        .sort(([keyA, countA], [keyB, countB]) => countB - countA || keyA.localeCompare(keyB))
        .slice(0, MAX_MISTAKE_ENTRIES),
    [state.mistakes],
  )

  const displayTime = isTimeBoundedRun(config) && remainingSeconds !== null
    ? formatTime(remainingSeconds)
    : formatTime(elapsedSeconds)

  return (
    // Centres on the full available (window-driven) width so all stats stay
    // on one line instead of wrapping — independent of the keyboard width,
    // like the reading window above.
    <div
      data-testid="typing-test-results"
      className="flex w-full flex-col items-center gap-2"
    >
      <div className="flex flex-wrap items-center justify-center gap-8 text-sm">
        <div className="flex items-baseline gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.wpm')}:</span>
          <span data-testid="typing-test-wpm" className="font-mono text-lg font-semibold text-accent tabular-nums">
            {showStats ? wpm : '-'}
          </span>
          {comparison && (
            <span className="inline-flex min-w-12 justify-start">
              {showStats && <ComparisonDelta current={wpm} baseline={comparison.wpm} testid="wpm" />}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.kpm')}:</span>
          <span data-testid="typing-test-kpm" className="font-mono text-lg font-semibold text-accent tabular-nums">
            {showStats ? kpm : '-'}
          </span>
          {comparison && (
            <span className="inline-flex min-w-12 justify-start">
              {showStats && <ComparisonDelta current={kpm} baseline={comparison.kpm} testid="kpm" />}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.accuracy')}:</span>
          <span data-testid="typing-test-accuracy" className="font-mono text-lg font-semibold tabular-nums">
            {showStats ? `${accuracy}%` : '-'}
          </span>
          {comparison && (
            <span className="inline-flex min-w-12 justify-start">
              {showStats && <ComparisonDelta current={accuracy} baseline={comparison.accuracy} suffix="%" testid="accuracy" />}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.kspc')}:</span>
          <span data-testid="typing-test-kspc" className="font-mono text-lg font-semibold tabular-nums">
            {showStats && kspc !== null ? formatKspc(kspc) : '-'}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.time')}:</span>
          <span data-testid="typing-test-time" className="font-mono text-lg font-semibold tabular-nums">
            {showStats ? displayTime : '-'}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          {/* Char-progress modes (fileImport / Tatoeba) track character
              progress (spaces included); everything else tracks words. */}
          <span className="text-content-muted">{t(charProgress ? 'editor.typingTest.chars' : 'editor.typingTest.words')}:</span>
          <span data-testid="typing-test-word-count" className="font-mono text-lg font-semibold tabular-nums">
            {!showStats
              ? '-'
              : charProgress
              ? t('editor.typingTest.wordCount', { current: typedChars, total: totalChars })
              : t('editor.typingTest.wordCount', {
                  current: state.currentWordIndex,
                  total: state.words.length,
                })}
          </span>
        </div>
        {state.status === 'finished' && config.mode === 'quote' && state.currentQuote && (
          <span data-testid="typing-test-quote-source" className="text-content-muted italic">
            {t('editor.typingTest.quoteSource', { source: state.currentQuote.source })}
          </span>
        )}
      </div>
      {state.status === 'finished' && mistakeEntries.length > 0 && (
        <div data-testid="typing-test-mistakes" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-content-muted">
          <span>{t('editor.typingTest.results.mistakesLabel')}:</span>
          {mistakeEntries.map(([key, count]) => (
            <span key={key} data-testid={`typing-test-mistake-${key}`} className="font-mono">
              {key}:{count}
            </span>
          ))}
        </div>
      )}
      {state.status === 'finished' && errorClasses && (
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
      )}
    </div>
  )
}

/** Signed delta of the live metric against the comparison baseline: an arrow +
 *  the difference, green when ahead, red when behind, muted when level. */
function ComparisonDelta({ current, baseline, suffix, testid }: { current: number; baseline: number; suffix?: string; testid: string }) {
  const diff = current - baseline
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : ''
  const color = diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : 'text-content-muted'
  return (
    <span data-testid={`typing-test-delta-${testid}`} className={`font-mono text-xs ${color}`}>
      {arrow}{diff > 0 ? '+' : ''}{diff}{suffix ?? ''}
    </span>
  )
}
