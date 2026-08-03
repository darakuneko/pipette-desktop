// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { KeystrokeTimelinePanel } from '../KeystrokeTimelinePanel'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

/** No keystroke carries an `overlapped` verdict — keeps `avgOverlap`
 *  (and thus the Overlap card) deterministically `undefined` regardless
 *  of which fixture variant a test uses, so tests don't have to hand-
 *  compute the pooled overlap ratio just to assert on unrelated cards. */
const SAMPLE_LOG: RunKeystrokeLog = {
  runId: 'run-1',
  uid: 'uid-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 5000,
  mode: 'words',
  language: 'english',
  words: [
    {
      index: 0,
      display: 'hi',
      typed: 'hi',
      correct: true,
      keystrokes: [
        { pressMs: 0, releaseMs: 60, keycode: 0, row: 0, col: 0, correct: true, expectedChar: 'h' },
        { pressMs: 80, releaseMs: 140, keycode: 0, row: 0, col: 1, correct: true, expectedChar: 'i' },
      ],
    },
  ],
}

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-01-01T00:00:00.000Z',
    wpm: 42,
    accuracy: 95,
    wordCount: 10,
    correctChars: 50,
    incorrectChars: 2,
    durationSeconds: 10,
    ...overrides,
  }
}

/** Finds the StatCard for a given label text and returns its whole
 *  textContent (label + value + unit + context) — StatCard doesn't
 *  expose a per-card testid via `AnalyzeStatGrid`, so this walks up from
 *  the label span to the card's own container div. */
function statCardText(labelText: string): string {
  const label = screen.getByText(labelText)
  return label.parentElement?.textContent ?? ''
}

describe('KeystrokeTimelinePanel', () => {
  it('shows every unified stat card sourced from the result when one is supplied', () => {
    const result = makeResult({
      wpm: 42,
      accuracy: 95,
      wordCount: 10,
      durationSeconds: 10,
      kspcKeystrokes: 12,
      kspcChars: 10,
    })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    expect(statCardText('Run WPM')).toContain('42.0')
    expect(statCardText('KPM')).toContain('300') // (50 correctChars * 60) / 10s
    expect(statCardText('Accuracy')).toContain('95.0%')
    expect(statCardText('KSPC')).toContain('1.20') // 12 keystrokes / 10 chars
    expect(statCardText('Time')).toContain('0:10')
    expect(statCardText('Words')).toContain('10')
    // No keystroke in the fixture carries an overlap verdict.
    expect(statCardText('Overlap')).toContain('—')
  })

  it('falls back to the model/log-derived values for WPM/Accuracy/Time, and EMPTY_STAT_VALUE for KPM/KSPC/Words, when no result is supplied', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)

    expect(screen.getByText('Word Pace')).toBeTruthy()
    expect(screen.queryByText('Run WPM')).toBeNull()
    // Time falls back to the resolved log's own durationMs (5000ms -> 5s).
    expect(statCardText('Time')).toContain('0:05')
    expect(statCardText('KPM')).toContain('—')
    expect(statCardText('KSPC')).toContain('—')
    expect(statCardText('Words')).toContain('—')
  })

  it('renders the legend and one row per word', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    expect(screen.getByText('Normal keystroke')).toBeTruthy()
    expect(screen.getByText('Mistake')).toBeTruthy()
    expect(screen.getByTestId('word-timeline-row-0')).toBeTruthy()
    expect(screen.getAllByTestId('word-timeline-keystroke')).toHaveLength(2)
  })

  it('shows the Missed characters list and error-mix line when the result carries them', () => {
    const result = makeResult({
      mistakes: { a: 3, b: 1 },
      errorSubstitutions: 2,
      errorOmissions: 1,
      errorInsertions: 0,
      errorTargetChars: 20,
    })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    expect(screen.getByTestId('typing-test-mistakes')).toBeTruthy()
    expect(screen.getByTestId('typing-test-mistake-a').textContent).toBe('a:3')
    expect(screen.getByTestId('typing-test-error-classes')).toBeTruthy()
    expect(screen.getByTestId('typing-test-error-substitutions').textContent).toContain('2')
  })

  it('omits the Missed/error-mix section entirely when the result has neither (not a "-" placeholder)', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={makeResult()} />)
    expect(screen.queryByTestId('typing-test-mistakes')).toBeNull()
    expect(screen.queryByTestId('typing-test-error-classes')).toBeNull()
  })

  it('omits the Missed/error-mix section when no result is supplied at all', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    expect(screen.queryByTestId('typing-test-mistakes')).toBeNull()
    expect(screen.queryByTestId('typing-test-error-classes')).toBeNull()
  })
})
