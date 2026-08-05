// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { HistoryTimelineCell } from '../HistoryTimelineCell'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}><table><tbody><tr>{ui}</tr></tbody></table></I18nextProvider>)
}

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-01-01T00:00:00.000Z',
    wpm: 80,
    accuracy: 98,
    wordCount: 40,
    correctChars: 200,
    incorrectChars: 4,
    durationSeconds: 30,
    ...overrides,
  }
}

describe('HistoryTimelineCell', () => {
  it('renders nothing when the result has no runId', () => {
    renderWithI18n(<HistoryTimelineCell result={makeResult()} uid="uid-1" availableRunIds={new Set(['run-1'])} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when the runId has no saved log', () => {
    renderWithI18n(<HistoryTimelineCell result={makeResult({ runId: 'run-2' })} uid="uid-1" availableRunIds={new Set(['run-1'])} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the open button when the runId has a saved log, and opens the timeline on click', () => {
    window.vialAPI = { typingRunLogGet: vi.fn().mockResolvedValue({ success: false }) } as unknown as typeof window.vialAPI
    renderWithI18n(<HistoryTimelineCell result={makeResult({ runId: 'run-1' })} uid="uid-1" availableRunIds={new Set(['run-1'])} />)
    const btn = screen.getByTestId('history-timeline-open-2026-01-01T00:00:00.000Z')
    expect(btn).toBeTruthy()
    expect(screen.queryByTestId('word-timeline-modal')).toBeNull()
    fireEvent.click(btn)
    expect(screen.getByTestId('word-timeline-modal')).toBeTruthy()
  })

  it('has no native title attribute and exposes the full label via the shared Tooltip instead', () => {
    // Variable-width cell now (like Name/Mode): the Tooltip carries the
    // label itself (not a separate "Open keystroke timeline" description)
    // so the full text is reachable even when COL_TIMELINE truncates it.
    renderWithI18n(<HistoryTimelineCell result={makeResult({ runId: 'run-1' })} uid="uid-1" availableRunIds={new Set(['run-1'])} />)
    const btn = screen.getByTestId('history-timeline-open-2026-01-01T00:00:00.000Z')
    expect(btn).not.toHaveAttribute('title')
    const bubble = screen.getByRole('tooltip')
    expect(bubble.textContent).toBe(i18n.t('editor.typingTest.history.timeline.linkLabel'))
    expect(btn.getAttribute('aria-describedby')).toBe(bubble.id)
  })

  // Icon -> text link: the row now shows a short visible label ("Timeline")
  // instead of the ChartNoAxesGantt icon. The button itself doesn't need an
  // aria-label since its own (truncate-wrapped) text supplies the
  // accessible name.
  it('renders a text link (no icon) with the visible timeline label', () => {
    renderWithI18n(<HistoryTimelineCell result={makeResult({ runId: 'run-1' })} uid="uid-1" availableRunIds={new Set(['run-1'])} />)
    const btn = screen.getByTestId('history-timeline-open-2026-01-01T00:00:00.000Z')
    expect(btn.querySelector('svg')).toBeNull()
    expect(btn.textContent).toBe(i18n.t('editor.typingTest.history.timeline.linkLabel'))
    expect(btn).not.toHaveAttribute('aria-label')
  })
})
