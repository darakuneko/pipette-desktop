// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { WordTimelineView } from '../WordTimelineView'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

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
        { pressMs: 80, releaseMs: 140, keycode: 0, row: 0, col: 1, correct: false, overlapped: true, expectedChar: 'i' },
      ],
    },
  ],
}

const SAMPLE_LOG_WITH_LINES: RunKeystrokeLog = {
  ...SAMPLE_LOG,
  words: [
    ...SAMPLE_LOG.words,
    {
      index: 1,
      display: 'go',
      typed: 'go',
      correct: true,
      keystrokes: [
        { pressMs: 500, releaseMs: 560, keycode: 0, row: 0, col: 0, correct: true, expectedChar: 'g' },
        { pressMs: 580, releaseMs: 640, keycode: 0, row: 0, col: 1, correct: true, expectedChar: 'o' },
      ],
    },
  ],
  lineBreaks: [0],
}

// A single line whose true span is 8.73s — fractional, sub-second
// precision, matching the shape `analyze-format`'s mm:ss `formatDuration`
// mishandles (no rounding on the seconds field: "0:8.73"). Regression
// fixture for the line-view duration display bug (see LineTimelineRow's
// own doc comment on `formatLineDurationSeconds`).
const SAMPLE_LOG_LINE_DURATION: RunKeystrokeLog = {
  ...SAMPLE_LOG,
  words: [
    {
      index: 0,
      display: 'hi',
      typed: 'hi',
      correct: true,
      keystrokes: [
        { pressMs: 0, releaseMs: 8730, keycode: 0, row: 0, col: 0, correct: true, expectedChar: 'h' },
      ],
    },
  ],
  lineBreaks: [],
}

beforeEach(() => {
  window.vialAPI = {
    typingRunLogGet: vi.fn().mockResolvedValue({ success: true, data: SAMPLE_LOG }),
  } as unknown as typeof window.vialAPI
  // jsdom doesn't implement layout, so clientWidth is always 0 — the
  // component floors the fit width via CANVAS_MIN_WIDTH_PX regardless.
})

describe('WordTimelineView', () => {
  it('shows a loading state, then the legend and stat grid once the log resolves', async () => {
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    expect(screen.getByTestId('word-timeline-loading')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('word-timeline-loading')).toBeNull())
    expect(screen.getByText('Normal keystroke')).toBeTruthy()
    expect(screen.getByText('Mistake')).toBeTruthy()
    expect(screen.getByTestId('word-timeline-zoom')).toBeTruthy()
  })

  it('shows an error state when the log fetch fails', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({ success: false, error: 'nope' })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-error')).toBeTruthy())
  })

  it('renders a keystroke rect per observed keystroke', async () => {
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByTestId('word-timeline-keystroke')).toHaveLength(2))
  })

  it('shows the charCorrelationUnavailable footer note only when the log flags it, omitting it otherwise', async () => {
    const { unmount } = renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-zoom')).toBeTruthy())
    expect(screen.queryByTestId('word-timeline-correlation-note')).toBeNull()
    unmount()

    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({
      success: true,
      data: { ...SAMPLE_LOG, charCorrelationUnavailable: true },
    })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-correlation-note')).toBeTruthy())
  })

  it('shows the partial badge for an in-flight (unsubmitted) word', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({
      success: true,
      data: {
        ...SAMPLE_LOG,
        words: [{ ...SAMPLE_LOG.words[0], partial: true }],
      },
    })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Partial')).toBeTruthy())
  })

  it('moving the zoom slider grows the canvas width beyond the fit level', async () => {
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-zoom')).toBeTruthy())
    const slider = screen.getByTestId('word-timeline-zoom') as HTMLInputElement
    const canvas = screen.getByTestId('word-timeline-canvas')
    await waitFor(() => expect(canvas.style.width).not.toBe(''))
    const widthBefore = canvas.style.width
    const max = Number(slider.max)
    fireEvent.change(slider, { target: { value: String(max) } })
    expect(canvas.style.width).not.toBe(widthBefore)
    expect(parseFloat(canvas.style.width)).toBeGreaterThan(parseFloat(widthBefore))
  })

  it('labels the pace card "Run WPM" (not "Word Pace") when a History result is supplied, since it shows result.wpm — a different metric', async () => {
    const result = { date: '2026-01-01', wpm: 42, accuracy: 95, wordCount: 10, correctChars: 50, incorrectChars: 2, durationSeconds: 10 }
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" result={result} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Run WPM')).toBeTruthy())
    expect(screen.queryByText('Word Pace')).toBeNull()
  })

  it('labels the pace card "Word Pace" (the model-derived fallback) when no result is supplied', async () => {
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Word Pace')).toBeTruthy())
    expect(screen.queryByText('Run WPM')).toBeNull()
  })

  it('hides the entire Zoom row (including its label) when the log has zero drawable content', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({
      success: true,
      data: { ...SAMPLE_LOG, words: [{ index: 0, display: '', typed: '', correct: true, keystrokes: [] }] },
    })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-canvas')).toBeTruthy())
    expect(screen.queryByTestId('word-timeline-zoom')).toBeNull()
    expect(screen.queryByText('Zoom')).toBeNull()
  })

  it('auto-selects line rows (never word rows) once the log has a lineBreaks field, and legend uses the line-view blank wording', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({ success: true, data: SAMPLE_LOG_WITH_LINES })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('line-timeline-row-0')).toBeTruthy())
    expect(screen.queryByTestId('word-timeline-row-0')).toBeNull()
    expect(screen.getByText('Pause (>250ms, shown compressed)')).toBeTruthy()
    expect(screen.queryByText('Pause (shown compressed)')).toBeNull()
  })

  it('treats an empty lineBreaks array ([]) as a single-line log, still line mode (field PRESENCE, not emptiness, selects the mode)', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({
      success: true,
      data: { ...SAMPLE_LOG, lineBreaks: [] },
    })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('line-timeline-row-0')).toBeTruthy())
    expect(screen.queryByTestId('word-timeline-row-0')).toBeNull()
  })

  it('falls back to word rows (and the word-view legend wording) for a legacy log with no lineBreaks field at all', async () => {
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-row-0')).toBeTruthy())
    expect(screen.queryByTestId('line-timeline-row-0')).toBeNull()
    expect(screen.getByText('Pause (shown compressed)')).toBeTruthy()
    expect(screen.queryByText('Pause (>250ms, shown compressed)')).toBeNull()
  })

  it('renders a fractional line duration as seconds-with-one-decimal ("8.7s"), never mm:ss ("0:8...")', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({ success: true, data: SAMPLE_LOG_LINE_DURATION })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('line-timeline-row-0')).toBeTruthy())
    const row = screen.getByTestId('line-timeline-row-0')
    expect(row.textContent).toContain('8.7s')
    expect(row.textContent).not.toMatch(/0:8/)
  })

  it('renders one row per line, grouping words per lineBreaks (2 words across 2 lines -> 2 line rows, not 1)', async () => {
    window.vialAPI.typingRunLogGet = vi.fn().mockResolvedValue({ success: true, data: SAMPLE_LOG_WITH_LINES })
    renderWithI18n(<WordTimelineView uid="uid-1" runId="run-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('line-timeline-row-0')).toBeTruthy())
    expect(screen.getByTestId('line-timeline-row-1')).toBeTruthy()
    expect(screen.getAllByTestId('line-timeline-keystroke')).toHaveLength(4)
  })

  it('closes only itself on Escape, leaving an outer modal open (nested-modal Escape isolation)', async () => {
    const onCloseTimeline = vi.fn()
    const onCloseOuter = vi.fn()
    function Outer() {
      // Mirrors HistoryToggle's own bubble-phase useEscapeClose.
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') onCloseOuter() })
      return <WordTimelineView uid="uid-1" runId="run-1" onClose={onCloseTimeline} />
    }
    renderWithI18n(<Outer />)
    await waitFor(() => expect(screen.getByTestId('word-timeline-zoom')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCloseTimeline).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })
})
