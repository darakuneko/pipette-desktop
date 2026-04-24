// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { KeymapSnapshotTimeline } from '../KeymapSnapshotTimeline'
import type { TypingKeymapSnapshotSummary } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'analyze.snapshotTimeline.title': 'Keymap snapshots',
        'analyze.snapshotTimeline.current': 'Current keymap',
        'analyze.snapshotTimeline.custom': '— Custom range —',
      }
      return map[key] ?? key
    },
  }),
}))

function makeSummary(savedAt: number, overrides: Partial<TypingKeymapSnapshotSummary> = {}): TypingKeymapSnapshotSummary {
  return {
    uid: 'kb-1',
    machineHash: 'hash',
    productName: 'Test',
    savedAt,
    layers: 4,
    matrix: { rows: 5, cols: 12 },
    ...overrides,
  }
}

describe('KeymapSnapshotTimeline', () => {
  it('renders nothing when there are no summaries', () => {
    const { container } = render(
      <KeymapSnapshotTimeline
        summaries={[]}
        range={{ fromMs: 0, toMs: 1000 }}
        nowMs={1000}
        onRangeChange={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a select with the latest snapshot labelled "Current keymap"', () => {
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        range={{ fromMs: 3000, toMs: 5000 }}
        nowMs={5000}
        onRangeChange={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    // Top option = latest, labelled "Current keymap"
    expect(select.options[0].textContent).toBe('Current keymap')
    expect(select.options[0].value).toBe('3000')
    // Then older snapshots, newer-first
    expect(select.options[1].value).toBe('2000')
    expect(select.options[2].value).toBe('1000')
  })

  it('selects the "current" option when range matches the latest snapshot period', () => {
    const sums = [makeSummary(1000), makeSummary(2000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        range={{ fromMs: 2000, toMs: 5000 }}
        nowMs={5000}
        onRangeChange={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('2000')
  })

  it('selects an older snapshot when range matches its period', () => {
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        range={{ fromMs: 1000, toMs: 2000 }}
        nowMs={5000}
        onRangeChange={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('1000')
  })

  it('shows a disabled "— Custom range —" option when range is off-boundary', () => {
    const sums = [makeSummary(1000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        range={{ fromMs: 1500, toMs: 2500 }}
        nowMs={5000}
        onRangeChange={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('custom')
    const customOption = Array.from(select.options).find((o) => o.value === 'custom')
    expect(customOption?.disabled).toBe(true)
    expect(customOption?.textContent).toBe('— Custom range —')
  })

  it('change to "current" sets range to [latest.savedAt, nowMs]', () => {
    const onChange = vi.fn()
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        range={{ fromMs: 1000, toMs: 2000 }}
        nowMs={5000}
        onRangeChange={onChange}
      />,
    )
    fireEvent.change(screen.getByTestId('analyze-snapshot-timeline-select'), { target: { value: '3000' } })
    expect(onChange).toHaveBeenCalledWith({ fromMs: 3000, toMs: 5000 })
  })

  it('change to a mid snapshot sets range to [savedAt, next.savedAt]', () => {
    const onChange = vi.fn()
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        range={{ fromMs: 3000, toMs: 5000 }}
        nowMs={5000}
        onRangeChange={onChange}
      />,
    )
    fireEvent.change(screen.getByTestId('analyze-snapshot-timeline-select'), { target: { value: '2000' } })
    expect(onChange).toHaveBeenCalledWith({ fromMs: 2000, toMs: 3000 })
  })
})
