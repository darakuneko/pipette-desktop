// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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

  it('shows a LINES card (not Words) when the log carries lineBreaks, with the line count from the log', () => {
    const lineLog: RunKeystrokeLog = { ...SAMPLE_LOG, lineBreaks: [0] } // 1 break -> 2 lines
    renderWithI18n(<KeystrokeTimelinePanel log={lineLog} result={makeResult({ mode: 'words', wordCount: 999 })} />)
    expect(statCardText('Lines')).toContain('2')
    expect(screen.queryByText('Words')).toBeNull()
  })

  it('shows a LINES card for a tatoeba run with no log.lineBreaks, using result.wordCount as the line count', () => {
    const tatoebaLog: RunKeystrokeLog = { ...SAMPLE_LOG, mode: 'tatoeba' }
    renderWithI18n(<KeystrokeTimelinePanel log={tatoebaLog} result={makeResult({ mode: 'tatoeba', wordCount: 10 })} />)
    expect(statCardText('Lines')).toContain('10')
    expect(screen.queryByText('Words')).toBeNull()
  })

  it('keeps the WORDS card for a fileImport run with no log.lineBreaks (line count unknowable)', () => {
    const fileImportLog: RunKeystrokeLog = { ...SAMPLE_LOG, mode: 'fileImport' }
    renderWithI18n(<KeystrokeTimelinePanel log={fileImportLog} result={makeResult({ mode: 'fileImport', wordCount: 7 })} />)
    expect(statCardText('Words')).toContain('7')
    expect(screen.queryByText('Lines')).toBeNull()
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

  it('opts the scroll container into container-type: inline-size, so a LINE row\'s sticky header can pin to its visible width via cqw', () => {
    const { container } = renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    const canvas = screen.getByTestId('word-timeline-canvas')
    const scrollport = canvas.parentElement!
    expect(scrollport.className).toContain('keystroke-timeline-scrollport')
    expect(container.contains(scrollport)).toBe(true)
  })

  describe('rows scrollport height (flex-height chain, not a fixed cap)', () => {
    // No `rowsMaxHeightClass`-style prop exists anymore (codex safety
    // review of an earlier fixed-vh attempt — a fixed vh figure can't
    // adapt to how much OTHER chrome a given run has, e.g. an
    // IME-composition warning or the Missed-chars line). Instead this
    // scrollport ALWAYS carries the same flex-1/min-h-0/overflow-auto
    // classes regardless of caller — TypingTestView.tsx (completion
    // screen) and WordTimelineView.tsx (History modal) now both provide
    // a real bounded-height flex ancestor of their own, so this
    // component needs no caller-supplied sizing prop of any kind. See
    // TypingTestView.tsx's own "Completion screen" comment for that
    // chain end to end.
    it('the scrollport always carries flex-1 min-h-0 overflow-auto, with no caller-supplied sizing prop at all', () => {
      const { container } = renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const scrollport = within(container).getByTestId('word-timeline-canvas').parentElement!
      expect(scrollport.className).toContain('flex-1')
      expect(scrollport.className).toContain('min-h-0')
      expect(scrollport.className).toContain('overflow-auto')
      expect(scrollport.className).not.toMatch(/\bmax-h-/)
      // Still carries the horizontal-scroll/sticky-header container-query
      // opt-in.
      expect(scrollport.className).toContain('keystroke-timeline-scrollport')
    })

    it('the panel\'s own root is flex-1 min-h-0 flex-col, so it correctly stretches within WHATEVER bounded ancestor the caller provides', () => {
      const { container } = renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const root = container.firstElementChild as HTMLElement
      expect(root.className).toContain('flex')
      expect(root.className).toContain('min-h-0')
      expect(root.className).toContain('flex-1')
      expect(root.className).toContain('flex-col')
    })
  })

  it('collapses the two note paragraphs into a legend info icon, with no inline note text', () => {
    const { container } = renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    // The old standalone paragraphs are gone from the panel's own render
    // tree entirely — the notes now live ONLY in the portaled tooltip
    // (outside `container`, which is the panel's own DOM subtree), not as
    // inline text in the flow.
    expect(within(container).queryByText(/Mistake markers include keystrokes later corrected/)).toBeNull()
    expect(within(container).queryByText(/Pauses are shown compressed on this axis/)).toBeNull()
    // The info icon button sits at the legend row's right end, with an
    // accessible name (no native title attribute — lint forbids it).
    const infoButton = screen.getByTestId('word-timeline-legend-info')
    expect(infoButton.tagName).toBe('BUTTON')
    expect(infoButton.getAttribute('title')).toBeNull()
    expect(infoButton).toHaveAccessibleName()
    // Right end of the legend row (`ml-auto`), after every swatch.
    expect(infoButton.className).toContain('ml-auto')
    const legendRow = infoButton.closest('.rounded-md.border.border-edge.bg-surface')
    expect(legendRow?.lastElementChild).toBe(infoButton.parentElement)
  })

  it('shows both note texts, joined as two lines, in the legend info tooltip', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.className).toContain('whitespace-pre-line')
    expect(tooltip.textContent).toBe(
      'Mistake markers include keystrokes later corrected before submit — a word can show markers and still be 100% accuracy.'
      + '\nPauses are shown compressed on this axis; every duration shown is still the real one.',
    )
  })

  it('shows the Missed characters list when the result carries mistakes', () => {
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
  })

  it('omits the Missed characters list entirely when the result has none (not a "-" placeholder)', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={makeResult()} />)
    expect(screen.queryByTestId('typing-test-mistakes')).toBeNull()
  })

  it('omits the Missed characters list when no result is supplied at all', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    expect(screen.queryByTestId('typing-test-mistakes')).toBeNull()
  })

  it('renders the Missed characters list AFTER the legend and the rows scrollport, not between the stat grid and the legend', () => {
    const result = makeResult({ mistakes: { a: 3 } })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    const legendInfo = screen.getByTestId('word-timeline-legend-info')
    const canvas = screen.getByTestId('word-timeline-canvas')
    const mistakes = screen.getByTestId('typing-test-mistakes')

    expect(legendInfo.compareDocumentPosition(mistakes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(canvas.compareDocumentPosition(mistakes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows Substitution/Omission/Insertion as stat cards, sourced from the result', () => {
    const result = makeResult({
      errorSubstitutions: 2,
      errorOmissions: 1,
      errorInsertions: 0,
      errorTargetChars: 20,
    })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    expect(statCardText('Substitution')).toContain('2')
    expect(statCardText('Omission')).toContain('1')
    expect(statCardText('Insertion')).toContain('0')
    // The old standalone error-mix line is gone.
    expect(screen.queryByTestId('typing-test-error-classes')).toBeNull()
  })

  it('shows EMPTY_STAT_VALUE for Substitution/Omission/Insertion when the result has no error-class fields', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={makeResult()} />)

    expect(statCardText('Substitution')).toContain('—')
    expect(statCardText('Omission')).toContain('—')
    expect(statCardText('Insertion')).toContain('—')
  })

  it('shows EMPTY_STAT_VALUE for Substitution/Omission/Insertion when no result is supplied at all', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)

    expect(statCardText('Substitution')).toContain('—')
    expect(statCardText('Omission')).toContain('—')
    expect(statCardText('Insertion')).toContain('—')
  })
})
