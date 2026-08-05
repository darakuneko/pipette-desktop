// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze -> Typing Test handoff consume-once path: `timelineHandoff`
// auto-opens History and the run's keystroke timeline, and closing either
// one clears it (see App.tsx's `useRunTimelineHandoff`).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'
import { HistoryToggle } from '../HistoryToggle'
import type { TypingTestResult } from '../../../../shared/types/pipette-settings'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
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

beforeEach(() => {
  window.vialAPI = {
    typingRunLogList: vi.fn().mockResolvedValue({ success: true, entries: [{ id: 'run-1' }] }),
    typingRunLogGet: vi.fn().mockResolvedValue({ success: false }),
  } as unknown as typeof window.vialAPI
})

describe('HistoryToggle — Analyze run-timeline handoff', () => {
  it('stays closed when no handoff is pending', () => {
    renderWithI18n(<HistoryToggle results={[]} uid="uid-1" />)
    expect(screen.queryByTestId('history-modal')).toBeNull()
  })

  // The Results table gained the Avg Hold/AKH column alongside KPM and
  // Accuracy, crowding MODAL_XL (960px) — bumped one width tier to
  // MODAL_2XL (1200px) so the wider table doesn't force cell truncation
  // more aggressively than necessary.
  it('opens the History modal at the MODAL_2XL width tier', () => {
    renderWithI18n(<HistoryToggle results={[]} />)
    fireEvent.click(screen.getByTestId('typing-test-history-toggle'))
    const modal = screen.getByTestId('history-modal')
    expect(modal.className).toContain('w-modal-2xl')
    expect(modal.className).not.toContain('w-modal-xl ')
  })

  it('auto-opens History and the timeline for a pending timelineHandoff', async () => {
    renderWithI18n(
      <HistoryToggle
        results={[makeResult({ runId: 'run-1' })]}
        uid="uid-1"
        timelineHandoff={{ runId: 'run-1', onConsumed: vi.fn() }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('history-modal')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('word-timeline-modal')).toBeInTheDocument())
  })

  it('clears the handoff (without closing History) when the opened timeline is closed', async () => {
    const onConsumed = vi.fn()
    const { rerender } = renderWithI18n(
      <HistoryToggle
        results={[makeResult({ runId: 'run-1' })]}
        uid="uid-1"
        timelineHandoff={{ runId: 'run-1', onConsumed }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('word-timeline-modal')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('word-timeline-close'))
    expect(onConsumed).toHaveBeenCalledTimes(1)
    // `timelineHandoff` is a controlled, consume-once prop — the real
    // parent (App.tsx's `useRunTimelineHandoff`) clears it in response to
    // `onConsumed`; simulate that same re-render here.
    rerender(
      <I18nextProvider i18n={i18n}>
        <HistoryToggle
          results={[makeResult({ runId: 'run-1' })]}
          uid="uid-1"
          timelineHandoff={null}
        />
      </I18nextProvider>,
    )
    // Closing just the nested timeline leaves History itself open so the
    // user can keep browsing other rows.
    expect(screen.getByTestId('history-modal')).toBeInTheDocument()
    expect(screen.queryByTestId('word-timeline-modal')).toBeNull()
  })

  it('clears the handoff too when History itself is closed', async () => {
    const onConsumed = vi.fn()
    renderWithI18n(
      <HistoryToggle
        results={[makeResult({ runId: 'run-1' })]}
        uid="uid-1"
        timelineHandoff={{ runId: 'run-1', onConsumed }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('history-modal')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('history-modal-close'))
    expect(onConsumed).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('history-modal')).toBeNull()
  })

  it('clicking the handoff timeline\'s own backdrop closes only the timeline, leaving History open (it mounts as a DIRECT SIBLING of history-modal-backdrop, not nested inside history-modal\'s own stopPropagation)', async () => {
    const onConsumed = vi.fn()
    renderWithI18n(
      <HistoryToggle
        results={[makeResult({ runId: 'run-1' })]}
        uid="uid-1"
        timelineHandoff={{ runId: 'run-1', onConsumed }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('word-timeline-modal')).toBeInTheDocument())
    // Click the timeline's own backdrop (not its content box) — before the
    // fix, this bubbled up to `history-modal-backdrop`'s own onClick and
    // closed History too.
    fireEvent.click(screen.getByTestId('word-timeline-modal'))
    expect(onConsumed).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('history-modal')).toBeInTheDocument()
  })
})
