// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { LineTimelineRow } from '../LineTimelineRow'
import type { LineTimelineLine } from '../line-timeline'
import type { KeystrokeSegment, BlankSegment } from '../word-timeline'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

function keystroke(overrides: Partial<KeystrokeSegment> & { startMs: number; endMs: number; label: string }): KeystrokeSegment {
  return { kind: 'keystroke', trueStartMs: overrides.startMs, lane: 0, ...overrides }
}

function blank(startMs: number, endMs: number): BlankSegment {
  return { kind: 'blank', startMs, endMs, trueDurationMs: endMs - startMs }
}

function makeLine(segments: LineTimelineLine['segments'], laneCount = 1): LineTimelineLine {
  return {
    lineIndex: 0,
    words: [{ index: 0, display: 'hi', typed: 'hi', partial: false, startMs: 0 }],
    segments,
    laneCount,
    stats: { durationSeconds: 1 },
  }
}

describe('LineTimelineRow — header layout', () => {
  it('right-aligns the per-line stats span within the header row (ml-auto)', () => {
    const line = makeLine([keystroke({ startMs: 0, endMs: 100, label: 'h' })])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const stats = screen.getByTestId('line-timeline-stats-0')
    expect(stats.className).toContain('ml-auto')
    // Sits after the line-text span, as the header row's last child — the
    // index badge and line text stay in their original (start) position;
    // only the stats span moves to the row's right end.
    const header = stats.parentElement!
    expect(header.className).toContain('flex')
    expect(header.lastElementChild).toBe(stats)
  })

  it('pins the header (badge + line text + stats + romaji sub-line) to the scrollport via sticky + cqw, not the zoomed canvas', () => {
    const line = makeLine([keystroke({ startMs: 0, endMs: 100, label: 'h' })])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const header = screen.getByTestId('line-timeline-header-0')
    // `.line-timeline-header-sticky` (style.css) is `position: sticky;
    // left: 0; width: 100cqw` — asserted here as class presence, since
    // jsdom doesn't compute container-query/sticky layout; the actual
    // pinned position is verified by the E2E completion-timeline script.
    expect(header.className).toContain('line-timeline-header-sticky')
    // The stats span (and the rest of the header) live INSIDE this pinned
    // wrapper, not as a loose sibling.
    expect(header.contains(screen.getByTestId('line-timeline-stats-0'))).toBe(true)
  })

  it('keeps the romaji sub-line inside the same pinned header wrapper as the badge/text/stats', () => {
    const line = makeLine([keystroke({ startMs: 0, endMs: 100, label: 'h' })])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const header = screen.getByTestId('line-timeline-header-0')
    const romajiLine = screen.getByLabelText(/Romaji:/)
    expect(header.contains(romajiLine)).toBe(true)
  })

  it('never makes the SVG bar strip itself sticky — only the header pins, the strip keeps scrolling/zooming with the canvas', () => {
    const line = makeLine([keystroke({ startMs: 0, endMs: 100, label: 'h' })])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const header = screen.getByTestId('line-timeline-header-0')
    const svg = screen.getByTestId('line-timeline-svg-0')
    expect(header.contains(svg)).toBe(false)
    expect(svg.closest('.line-timeline-header-sticky')).toBeNull()
  })
})

describe('LineTimelineRow — on-bar keystroke labels', () => {
  it('renders one label overlay cell per keystroke segment, with the segment label as its text', () => {
    const line = makeLine([
      keystroke({ startMs: 0, endMs: 100, label: 'h' }),
      blank(100, 150),
      keystroke({ startMs: 150, endMs: 250, label: 'i' }),
    ])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const cells = screen.getAllByTestId('line-timeline-label-cell')
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toBe('h')
    expect(cells[1].textContent).toBe('i')
  })

  it('positions each label cell in % of the shared maxDisplayMs axis, not the line\'s own duration', () => {
    const line = makeLine([keystroke({ startMs: 250, endMs: 500, label: 'x' })])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const cell = screen.getByTestId('line-timeline-label-cell')
    expect(cell.style.left).toBe('25%')
    expect(cell.style.width).toBe('25%')
  })

  it('marks the overlay layer aria-hidden and pointer-events-none so it never intercepts hover/click', () => {
    const line = makeLine([keystroke({ startMs: 0, endMs: 100, label: 'a' })])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const layer = screen.getByTestId('line-timeline-label-layer-0')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.className).toContain('pointer-events-none')
  })

  it('picks a distinct label-color class per segment kind (normal/mistake/overlap/unjudged)', () => {
    const line = makeLine([
      keystroke({ startMs: 0, endMs: 100, label: 'n', correct: true }),
      keystroke({ startMs: 100, endMs: 200, label: 'm', correct: false }),
      keystroke({ startMs: 200, endMs: 300, label: 'o', overlapped: true }),
      keystroke({ startMs: 300, endMs: 400, label: 'u' }),
    ])
    renderWithI18n(
      <LineTimelineRow line={line} maxDisplayMs={1000} romajiInput={false} onHover={vi.fn()} onHoverEnd={vi.fn()} />,
    )
    const labelSpans = screen.getAllByTestId('line-timeline-label-cell').map((cell) => cell.querySelector('.line-timeline-label-text')!)
    expect(labelSpans[0].className).toContain('text-content-inverse')
    expect(labelSpans[1].className).toContain('text-content-inverse')
    expect(labelSpans[2].className).toContain('text-content')
    expect(labelSpans[2].className).toContain('dark:text-content-inverse')
    expect(labelSpans[3].className).toContain('text-content')
    expect(labelSpans[3].className).not.toContain('dark:text-content-inverse')
  })
})
