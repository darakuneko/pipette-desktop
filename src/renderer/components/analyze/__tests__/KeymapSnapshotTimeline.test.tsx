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
        selectedSavedAt={null}
        onSelectSnapshot={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a select with the latest snapshot labelled "Current keymap"', () => {
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={3000}
        onSelectSnapshot={vi.fn()}
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

  it('drives the selected value from selectedSavedAt regardless of any narrowed range', () => {
    const sums = [makeSummary(1000), makeSummary(2000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={2000}
        onSelectSnapshot={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('2000')
  })

  it('selects an older snapshot when selectedSavedAt points at it', () => {
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={1000}
        onSelectSnapshot={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('1000')
  })

  it('falls back to the latest snapshot when selectedSavedAt is null', () => {
    const sums = [makeSummary(1000), makeSummary(2000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={null}
        onSelectSnapshot={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('2000')
  })

  it('falls back to the latest snapshot when selectedSavedAt is stale (not in summaries)', () => {
    const sums = [makeSummary(1000), makeSummary(2000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={9999}
        onSelectSnapshot={vi.fn()}
      />,
    )
    const select = screen.getByTestId('analyze-snapshot-timeline-select') as HTMLSelectElement
    expect(select.value).toBe('2000')
  })

  it('emits onSelectSnapshot with the savedAt of the picked option', () => {
    const onSelect = vi.fn()
    const sums = [makeSummary(1000), makeSummary(2000), makeSummary(3000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={3000}
        onSelectSnapshot={onSelect}
      />,
    )
    fireEvent.change(screen.getByTestId('analyze-snapshot-timeline-select'), { target: { value: '2000' } })
    expect(onSelect).toHaveBeenCalledWith(2000)
  })

  it('ignores values that do not match any snapshot', () => {
    const onSelect = vi.fn()
    const sums = [makeSummary(1000), makeSummary(2000)]
    render(
      <KeymapSnapshotTimeline
        summaries={sums}
        selectedSavedAt={2000}
        onSelectSnapshot={onSelect}
      />,
    )
    fireEvent.change(screen.getByTestId('analyze-snapshot-timeline-select'), { target: { value: 'nope' } })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
