// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// NOTE (per-day rework): the chart used to take raw results and plot every
// individual one — with many tests in a single day the line zigzagged into
// an unreadable vertical cluster. It now takes pre-aggregated per-day
// points (one best/worst/avg triple per LOCAL calendar day) as its `data`
// prop — the caller (HistoryResultsPanel) owns the TypingTestResult[] ->
// DailyWpmPoint[] aggregation via aggregateWpmByDay (see
// wpm-daily-trend.test.ts for its own unit tests) since it needs that same
// grouping to decide whether to show the "WPM Trend" heading at all; this
// component just draws whatever `data` it's given.
//
// recharts renders zero-size SVGs under jsdom (ResponsiveContainer has no
// real layout to measure), so — same "avoid dragging recharts into jsdom"
// approach WpmChart.test.tsx already uses for its own reference-line
// assertion — recharts is stubbed down to plain divs here too, with Line
// re-rendered as an inspectable div carrying its dataKey/name/stroke.

import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { WpmTrendChart } from '../WpmTrendChart'
import type { DailyWpmPoint } from '../wpm-daily-trend'

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => <div data-testid="wpm-trend-legend-mock" />,
  Line: (props: { dataKey?: string, name?: string, stroke?: string }) => (
    <div data-testid={`wpm-trend-line-${String(props.dataKey)}`} data-name={props.name} data-stroke={props.stroke} />
  ),
}))

function point(overrides: Partial<DailyWpmPoint> = {}): DailyWpmPoint {
  return {
    dayStartMs: new Date(2026, 5, 20).getTime(),
    best: 80,
    worst: 60,
    avg: 70,
    count: 3,
    ...overrides,
  }
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('WpmTrendChart', () => {
  it('renders nothing with fewer than 2 day-points', () => {
    const { container } = renderWithI18n(<WpmTrendChart data={[point()]} />)
    expect(container.querySelector('[data-testid="wpm-trend-chart"]')).toBeNull()
  })

  it('renders nothing with zero day-points', () => {
    const { container } = renderWithI18n(<WpmTrendChart data={[]} />)
    expect(container.querySelector('[data-testid="wpm-trend-chart"]')).toBeNull()
  })

  it('renders the chart container for 2+ day-points', () => {
    const data = [
      point({ dayStartMs: new Date(2026, 5, 18).getTime() }),
      point({ dayStartMs: new Date(2026, 5, 19).getTime() }),
    ]
    renderWithI18n(<WpmTrendChart data={data} />)
    expect(screen.getByTestId('wpm-trend-chart')).toBeTruthy()
  })

  it('renders exactly 3 line series — best/worst/avg — each with a distinct color and localized name', () => {
    const data = [
      point({ dayStartMs: new Date(2026, 5, 18).getTime() }),
      point({ dayStartMs: new Date(2026, 5, 19).getTime() }),
    ]
    renderWithI18n(<WpmTrendChart data={data} />)
    const best = screen.getByTestId('wpm-trend-line-best')
    const worst = screen.getByTestId('wpm-trend-line-worst')
    const avg = screen.getByTestId('wpm-trend-line-avg')
    expect(best.dataset.name).toBe('Best')
    expect(worst.dataset.name).toBe('Worst')
    expect(avg.dataset.name).toBe('Avg')
    const colors = new Set([best.dataset.stroke, worst.dataset.stroke, avg.dataset.stroke])
    expect(colors.size).toBe(3)
  })

  it('renders a legend', () => {
    const data = [
      point({ dayStartMs: new Date(2026, 5, 18).getTime() }),
      point({ dayStartMs: new Date(2026, 5, 19).getTime() }),
    ]
    renderWithI18n(<WpmTrendChart data={data} />)
    expect(screen.getByTestId('wpm-trend-legend-mock')).toBeTruthy()
  })

  it('suppresses the focus-ring outline on the chart wrapper (recharts accessibilityLayer regression guard)', () => {
    const data = [
      point({ dayStartMs: new Date(2026, 5, 18).getTime() }),
      point({ dayStartMs: new Date(2026, 5, 19).getTime() }),
    ]
    renderWithI18n(<WpmTrendChart data={data} />)
    const wrapper = screen.getByTestId('wpm-trend-chart')
    expect(wrapper.className).toContain('[&_*]:focus:outline-none')
    expect(wrapper.className).toContain('[&_*]:focus-visible:outline-none')
  })
})
