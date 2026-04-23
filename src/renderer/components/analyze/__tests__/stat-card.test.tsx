// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatCard, AnalyzeStatGrid } from '../stat-card'
import type { AnalyzeSummaryItem } from '../analyze-summary-table'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'analyze.peak.peakKeystrokesPerMin': 'Peak K/min',
        'analyze.peak.peakKeystrokesPerDay': 'Peak K/day',
        'analyze.peak.longestSession': 'Longest session (min)',
        'analyze.peak.longestSessionDesc': 'Longest continuous typing run, separated by 5+ minutes of idle.',
        'grid-label': 'Grid Label',
      }
      return map[key] ?? key
    },
  }),
}))

describe('StatCard', () => {
  it('renders label / value without tooltip when description is not provided', () => {
    render(
      <StatCard label="Peak WPM" value="120" testid="card-peak" />,
    )
    expect(screen.getByTestId('card-peak').textContent).toContain('Peak WPM')
    expect(screen.getByTestId('card-peak').textContent).toContain('120')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('wraps card in a tooltip when description is provided', () => {
    render(
      <StatCard
        label="Peak WPM"
        value="120"
        testid="card-peak"
        description="Highest WPM reached."
      />,
    )
    expect(screen.getByTestId('card-peak')).toBeInTheDocument()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toBe('Highest WPM reached.')
  })

  it('renders unit and context alongside value', () => {
    render(
      <StatCard
        label="Duration"
        value="12"
        unit="min"
        context="extra info"
        testid="card-duration"
      />,
    )
    const card = screen.getByTestId('card-duration')
    expect(card.textContent).toContain('12')
    expect(card.textContent).toContain('min')
    expect(card.textContent).toContain('extra info')
  })
})

describe('AnalyzeStatGrid', () => {
  it('renders one StatCard per item and preserves testId on grid', () => {
    const items: AnalyzeSummaryItem[] = [
      { labelKey: 'analyze.peak.peakKeystrokesPerMin', value: '300' },
      { labelKey: 'analyze.peak.peakKeystrokesPerDay', value: '20000' },
    ]
    render(
      <AnalyzeStatGrid
        items={items}
        ariaLabelKey="grid-label"
        testId="grid-test"
      />,
    )
    const grid = screen.getByTestId('grid-test')
    expect(grid.getAttribute('aria-label')).toBe('Grid Label')
    expect(grid.textContent).toContain('Peak K/min')
    expect(grid.textContent).toContain('300')
    expect(grid.textContent).toContain('Peak K/day')
    expect(grid.textContent).toContain('20000')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('forwards descriptionKey to StatCard so a tooltip is rendered', () => {
    const items: AnalyzeSummaryItem[] = [
      {
        labelKey: 'analyze.peak.longestSession',
        descriptionKey: 'analyze.peak.longestSessionDesc',
        value: '120',
      },
    ]
    render(
      <AnalyzeStatGrid items={items} ariaLabelKey="grid-label" />,
    )
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toBe('Longest continuous typing run, separated by 5+ minutes of idle.')
  })
})
