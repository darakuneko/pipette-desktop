// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
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

    expect(statCardText('WPM')).toContain('42.0')
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
    expect(screen.queryByText('WPM')).toBeNull()
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

  // Polish item 1: legend items that used to carry a parenthetical
  // explanation inline now show only their head word, with the
  // explanation moved into a hover tooltip (aria-describedby, not
  // always-visible text).
  describe('legend labels (head word only, parenthetical text moved to a hover tooltip)', () => {
    function hoverLegendLabel(text: string): HTMLElement {
      const label = screen.getByText(text)
      fireEvent.mouseEnter(label)
      const describedBy = label.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      return document.getElementById(describedBy!)!
    }

    it('shows bare head words for Overlapped/Unjudged/Pause, with no parenthetical text anywhere in the legend row', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const legendRow = screen.getByTestId('word-timeline-legend')
      expect(within(legendRow).getByText('Overlapped')).toBeTruthy()
      expect(within(legendRow).getByText('Unjudged')).toBeTruthy()
      expect(within(legendRow).getByText('Pause')).toBeTruthy()
      expect(legendRow.textContent).not.toContain('(')
      expect(legendRow.textContent).not.toContain(')')
    })

    it('leaves Normal keystroke / Mistake / Pause before this word unwrapped (no tooltip, since they never carried a parenthetical)', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      expect(screen.getByText('Normal keystroke').getAttribute('aria-describedby')).toBeNull()
      expect(screen.getByText('Mistake').getAttribute('aria-describedby')).toBeNull()
      expect(screen.getByText('Pause before this word').getAttribute('aria-describedby')).toBeNull()
    })

    it('opens the Overlapped tooltip with the former parenthetical text on hover', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const tooltip = hoverLegendLabel('Overlapped')
      expect(tooltip.textContent).toBe('Pressed before the previous key released')
    })

    it('opens the Unjudged tooltip with the former parenthetical text on hover', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const tooltip = hoverLegendLabel('Unjudged')
      expect(tooltip.textContent).toBe('No correctness data')
    })

    it('opens the word-view Pause tooltip ("Shown compressed") when no lineBreaks field is present', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const tooltip = hoverLegendLabel('Pause')
      expect(tooltip.textContent).toBe('Shown compressed')
    })

    it('opens the line-view Pause tooltip ("More than 250ms, shown compressed") when the log carries lineBreaks', () => {
      const lineLog: RunKeystrokeLog = { ...SAMPLE_LOG, lineBreaks: [0] }
      renderWithI18n(<KeystrokeTimelinePanel log={lineLog} />)
      const tooltip = hoverLegendLabel('Pause')
      expect(tooltip.textContent).toBe('More than 250ms, shown compressed')
    })

    // FLAG (consistency fix): the tooltip-bearing label used to carry a
    // dotted-underline + `cursor-help` affordance — no other tooltip
    // trigger in this codebase does that (ErrorMixSection's type labels,
    // CoverageBadge, the Missed table's own bar rows are all plain), so
    // it was removed. The tooltip itself (hover -> aria-describedby ->
    // portaled bubble) still works identically; only the label's own
    // visual styling changed.
    it('renders the tooltip-bearing label plain, with no underline/cursor-help decoration, while the tooltip still opens on hover', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const label = screen.getByText('Overlapped')
      expect(label.className).not.toContain('cursor-help')
      expect(label.className).not.toContain('underline')
      expect(label.className).not.toContain('decoration-dotted')
      const tooltip = hoverLegendLabel('Overlapped')
      expect(tooltip.textContent).toBe('Pressed before the previous key released')
    })
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
    // FLAG (consistency fix): the info glyph used to be a `<button>`,
    // which this codebase's global `button:not(:disabled) { cursor:
    // pointer }` rule (style.css) put a pointer cursor on — inconsistent
    // with every other tooltip-only trigger (CoverageBadge,
    // ErrorMixSection's row labels), none of which are buttons. Now a
    // plain, non-interactive `<span>` — sits at the legend row's right
    // end, with an accessible name via `aria-label` (no native title
    // attribute — lint forbids it).
    const infoButton = screen.getByTestId('word-timeline-legend-info')
    expect(infoButton.tagName).toBe('SPAN')
    expect(infoButton.getAttribute('title')).toBeNull()
    expect(infoButton).toHaveAccessibleName()
    // Right end of the legend row (`ml-auto`), after every swatch. The
    // legend row itself no longer carries its own border/bg (that moved up
    // to the timeline box — see the box-order test below).
    expect(infoButton.className).toContain('ml-auto')
    const legendRow = screen.getByTestId('word-timeline-legend')
    expect(legendRow.contains(infoButton)).toBe(true)
    expect(legendRow.lastElementChild).toBe(infoButton.parentElement)
  })

  describe('the timeline box (title / zoom / legend / rows in one bordered container)', () => {
    it('wraps title, zoom, legend, and the rows scrollport in a single bordered container, in that order', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const box = screen.getByTestId('typing-test-timeline-box')
      expect(box.className).toContain('rounded-md')
      expect(box.className).toContain('border')
      expect(box.className).toContain('border-edge')
      expect(box.className).toContain('bg-surface')

      const title = within(box).getByTestId('typing-test-timeline-title')
      const zoomRow = within(box).getByTestId('word-timeline-zoom-row')
      const legendRow = within(box).getByTestId('word-timeline-legend')
      const canvas = within(box).getByTestId('word-timeline-canvas')

      // Everything the box wraps must actually be INSIDE it (not just
      // rendered somewhere else in the tree)...
      expect(box.contains(title)).toBe(true)
      expect(box.contains(zoomRow)).toBe(true)
      expect(box.contains(legendRow)).toBe(true)
      expect(box.contains(canvas)).toBe(true)

      // ...and in the sketch's own order: title, then zoom, then legend,
      // then rows (swapped from the pre-existing legend-before-zoom order).
      expect(title.compareDocumentPosition(zoomRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(zoomRow.compareDocumentPosition(legendRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(legendRow.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('the box participates in the flex-height chain (flex-1 min-h-0 flex-col), so the rows scrollport inside it still absorbs the remaining height', () => {
      renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
      const box = screen.getByTestId('typing-test-timeline-box')
      expect(box.className).toContain('flex-1')
      expect(box.className).toContain('min-h-0')
      expect(box.className).toContain('flex-col')
      const scrollport = screen.getByTestId('word-timeline-canvas').parentElement!
      expect(scrollport.className).toContain('flex-1')
      expect(scrollport.className).toContain('min-h-0')
    })

    it('the stat cards stay OUTSIDE/above the box', () => {
      const result = makeResult()
      const { container } = renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)
      const box = screen.getByTestId('typing-test-timeline-box')
      const statLabel = screen.getByText('WPM')
      expect(box.contains(statLabel)).toBe(false)
      expect(container.contains(statLabel)).toBe(true)
      expect(statLabel.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  // Coordinator-requested layout tweak (real-device screenshot review):
  // the correlation-unreliable warning used to sit between the stat grid
  // and the timeline box — moved to the very top of the panel, above the
  // stat grid, since it qualifies every stat card's own correctness-
  // derived figures too, not just the timeline box below it.
  it('renders the correlation-unreliable warning ABOVE the stat-card grid, at the very top of the panel', () => {
    const unreliableLog: RunKeystrokeLog = { ...SAMPLE_LOG, charCorrelationUnavailable: true }
    const result = makeResult()
    const { container } = renderWithI18n(<KeystrokeTimelinePanel log={unreliableLog} result={result} />)

    const warning = screen.getByTestId('word-timeline-correlation-note')
    const statLabel = screen.getByText('WPM')

    // The warning is the panel root's first child...
    expect(container.firstElementChild?.firstElementChild).toBe(warning)
    // ...and precedes the stat grid in document order.
    expect(warning.compareDocumentPosition(statLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // FLAG (polish item 1): `getByRole('tooltip')` used to be safe because
  // the info icon was the panel's only `Tooltip` consumer. Now that the
  // legend's own Overlapped/Unjudged/Pause labels each carry their own
  // `Tooltip` too (portaled to `document.body` unconditionally once
  // mounted, per Tooltip.tsx's own comment — `role="tooltip"` exists in
  // the DOM before any hover), several `role="tooltip"` elements coexist
  // and the single-role query throws. Scoped instead via the info
  // button's own `aria-describedby`, same technique the legend-tooltip
  // tests above use.
  it('shows both note texts, joined as two lines, in the legend info tooltip', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    const infoButton = screen.getByTestId('word-timeline-legend-info')
    const describedBy = infoButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const tooltip = document.getElementById(describedBy!)!
    expect(tooltip.className).toContain('whitespace-pre-line')
    expect(tooltip.textContent).toBe(
      'Mistake markers include keystrokes later corrected before submit — a word can show markers and still be 100% accuracy.'
      + '\nPauses are shown compressed on this axis; every duration shown is still the real one.',
    )
  })

  // FLAG (coordinator-requested layout change): these four cases used to
  // assert on `typing-test-mistakes` (MissedCharsList's chip+tooltip
  // presentation). KeystrokeTimelinePanel now renders `MissedTable`
  // instead (see mistake-summary.tsx) — updated in place to the table's
  // own testids rather than being dropped; MissedTable's own detailed
  // table-structure coverage (headers, EMPTY_STAT_VALUE placeholders,
  // shared grid tracks) lives in mistake-summary.test.tsx.
  it('shows the Missed table when the result carries mistakes', () => {
    const result = makeResult({
      mistakes: { a: 3, b: 1 },
      errorSubstitutions: 2,
      errorOmissions: 1,
      errorInsertions: 0,
      errorTargetChars: 20,
    })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    expect(screen.getByTestId('typing-test-missed-table')).toBeTruthy()
    const row = screen.getByTestId('missed-table-row-a')
    expect(within(row).getByTestId('missed-table-row-a-word').textContent).toBe('a')
    expect(within(row).getByTestId('missed-table-row-a-count').textContent).toBe('3')
  })

  // FLAG (coordinator-requested bar-graph rewrite): the "Typed instead"
  // cell used to show "x: 1" (char + count together); the mockup moved
  // counts into the bar's own hover tooltip, so the row's inline cell now
  // reads "→ x" (chars only) instead.
  it('wires buildMissedDetails(log) end to end: a keystroke\'s typedChar/mistakeKey surfaces in the row\'s typed cell and bar split', () => {
    const logWithDetail: RunKeystrokeLog = {
      ...SAMPLE_LOG,
      words: [{
        index: 0, display: 'hi', typed: 'xi', correct: false,
        keystrokes: [
          { pressMs: 0, keycode: 0, row: 0, col: 0, correct: false, expectedChar: 'h', typedChar: 'x', mistakeKey: 'h' },
        ],
      }],
    }
    const result = makeResult({ mistakes: { h: 1 } })
    renderWithI18n(<KeystrokeTimelinePanel log={logWithDetail} result={result} />)

    const row = screen.getByTestId('missed-table-row-h')
    expect(within(row).getByTestId('missed-table-row-h-typed').textContent).toBe('→ x')
  })

  it('omits the Missed table entirely when the result has none (not a "-" placeholder)', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={makeResult()} />)
    expect(screen.queryByTestId('typing-test-missed-table')).toBeNull()
  })

  it('omits the Missed table when no result is supplied at all', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} />)
    expect(screen.queryByTestId('typing-test-missed-table')).toBeNull()
  })

  it('renders the Missed table AFTER the timeline box (below it, same position the old chip list held)', () => {
    const result = makeResult({ mistakes: { a: 3 } })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    const box = screen.getByTestId('typing-test-timeline-box')
    const missedTable = screen.getByTestId('typing-test-missed-table')

    expect(box.compareDocumentPosition(missedTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(box.contains(missedTable)).toBe(false)
  })

  // Coordinator-requested layout tweak (real-device screenshot review):
  // the Missed section used to sit outside any container. Wrapped here
  // (at THIS call site only — see the wrapper's own doc comment in
  // KeystrokeTimelinePanel.tsx) in the exact same bordered-box treatment
  // as the timeline box above. `MistakeRankingSection` (History's "Most
  // missed") renders the same `MissedTable` unboxed — see
  // MistakeRankingSection.test.tsx, unchanged by this tweak.
  // FLAG (polish item 2, height-priority fix): `shrink-0` (flex-shrink: 0)
  // became `min-h-0` — `shrink-0` refused to compress at all, which
  // (verified via the E2E script's 800px-window case) could overflow past
  // the finished-state controls row below in a bounded ancestor with a
  // real content-heavy Missed table. `min-h-0` keeps the default
  // `flex-shrink: 1` in effect, so this box can shrink proportionally
  // instead of forcing an overflow — see the box's own doc comment.
  it('wraps the Missed table in its own bordered box matching the timeline box treatment, with min-h-0 (not shrink-0)', () => {
    const result = makeResult({ mistakes: { a: 3 } })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    const missedBox = screen.getByTestId('typing-test-missed-box')
    const missedTable = screen.getByTestId('typing-test-missed-table')

    expect(missedBox.contains(missedTable)).toBe(true)
    expect(missedBox.className).toContain('rounded-md')
    expect(missedBox.className).toContain('border')
    expect(missedBox.className).toContain('border-edge')
    expect(missedBox.className).toContain('bg-surface')
    expect(missedBox.className).toContain('min-h-0')
    expect(missedBox.className).not.toContain('shrink-0')
  })

  it('omits the Missed box entirely (no empty bordered box) when the result has no mistakes', () => {
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={makeResult()} />)
    expect(screen.queryByTestId('typing-test-missed-box')).toBeNull()
  })

  // Polish item 2: in a bounded ancestor (the History modal's
  // `h-modal-80vh`), the timeline box and the Missed box compete for the
  // same leftover flex space — the timeline box must win, WITHOUT ever
  // overflowing the ancestor at a short window (see the timeline box's own
  // doc comment for the flagged `min-h-64` dead end this replaced). Both
  // boxes now carry `min-h-0` (genuinely shrinkable, default
  // `flex-shrink: 1`, no `shrink-0` anywhere in this pair) so a real space
  // deficit distributes proportionally instead of one box refusing to
  // give at all; this call site also tightens the Missed table's own
  // scrollport cap (`max-h-40`, vs its `max-h-56` default) so it claims
  // less even in the roomy case. jsdom has no layout engine, so this only
  // asserts the STRUCTURAL classes that implement the mechanism, not
  // actual rendered pixel heights (that's the E2E script's job, run
  // against the real, built app — see panel-polish-e2e.ts, which measured
  // 268px timeline vs 182px Missed in the modal, and confirmed zero
  // overflow/overlap at both a normal and an 800px-tall window on the
  // completion screen).
  it('keeps both the timeline box and the Missed box genuinely shrinkable (min-h-0, no shrink-0), with a tighter max-h-40 cap on the Missed table', () => {
    const result = makeResult({ mistakes: { a: 3 } })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    const timelineBox = screen.getByTestId('typing-test-timeline-box')
    expect(timelineBox.className).toContain('min-h-0')
    expect(timelineBox.className).toContain('flex-1')

    const missedBox = screen.getByTestId('typing-test-missed-box')
    expect(missedBox.className).toContain('min-h-0')
    expect(missedBox.className).not.toContain('shrink-0')

    const missedScrollport = screen.getByTestId('missed-table-scrollport')
    expect(missedScrollport.className).toContain('max-h-40')
    expect(missedScrollport.className).not.toContain('max-h-56')
  })

  // Polish item 3: the Missed section used to show a border on its OWN
  // outer box (`typing-test-missed-box`, asserted above) AND an inner
  // border on the table's own scroll container — a visible double
  // border around the same content. The scrollport keeps its scroll/
  // padding but loses the border/rounded classes at THIS call site only
  // (History's own unboxed "Most missed" instance keeps its border —
  // see mistake-summary.test.tsx's `bordered` describe block).
  it('removes the Missed table scrollport\'s own inner border (the outer Missed box is the only frame)', () => {
    const result = makeResult({ mistakes: { a: 3 } })
    renderWithI18n(<KeystrokeTimelinePanel log={SAMPLE_LOG} result={result} />)

    const missedScrollport = screen.getByTestId('missed-table-scrollport')
    expect(missedScrollport.className).not.toContain('border')
    expect(missedScrollport.className).not.toContain('rounded-md')
    // Still scrollable, still padded — only the border/rounded frame is gone.
    expect(missedScrollport.className).toContain('overflow-y-auto')
    expect(missedScrollport.className).toContain('p-2')

    const missedBox = screen.getByTestId('typing-test-missed-box')
    expect(missedBox.contains(missedScrollport)).toBe(true)
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
