// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for the population-benchmark reference line only. recharts
// renders zero-size SVGs under jsdom (ResponsiveContainer has no real
// layout to measure), so — same "avoid dragging recharts into jsdom"
// approach the TypingAnalyticsView suite already uses for the chart
// components themselves — the module is stubbed down to plain divs.
// ReferenceLine is the one primitive under test, so it renders its `y`
// prop into the DOM instead of an SVG line.

import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { WpmChart } from '../WpmChart'
import type { PeakRecords, TypingMinuteStatsRow } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
  Line: () => null,
  Bar: () => null,
  Cell: () => null,
  ReferenceLine: (props: { y?: number; yAxisId?: string }) => (
    <div data-testid="analyze-reference-line" data-y={props.y} data-y-axis-id={props.yAxisId} />
  ),
}))

const emptyPeakRecords: PeakRecords = {
  peakWpm: null,
  lowestWpm: null,
  peakKeystrokesPerMin: null,
  peakKeystrokesPerDay: null,
  longestSession: null,
}

function minuteRow(minuteMs: number, keystrokes: number, activeMs: number): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes,
    activeMs,
    intervalMinMs: null,
    intervalP25Ms: null,
    intervalP50Ms: null,
    intervalP75Ms: null,
    intervalMaxMs: null,
  }
}

const rows: TypingMinuteStatsRow[] = [minuteRow(0, 50, 60_000), minuteRow(60_000, 60, 60_000)]
const range = { fromMs: 0, toMs: 2 * 60_000 }

function setVialAPI(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsListMinuteStatsLocal: () => Promise.resolve(rows),
      typingAnalyticsListBksMinuteLocal: () => Promise.resolve([]),
      typingAnalyticsGetPeakRecordsLocal: () => Promise.resolve(emptyPeakRecords),
    },
    writable: true,
    configurable: true,
  })
}

function renderChart(overrides: Partial<Parameters<typeof WpmChart>[0]> = {}): void {
  render(
    <WpmChart
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      granularity={60_000}
      viewMode="timeSeries"
      minActiveMs={0}
      showBenchmark
      {...overrides}
    />,
  )
}

describe('WpmChart benchmark reference line', () => {
  beforeEach(() => {
    setVialAPI()
  })

  it('renders the reference line at the population WPM mean when the toggle is on', async () => {
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-reference-line')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-reference-line').getAttribute('data-y')).toBe('51.56')
  })

  it('does not render the reference line when the toggle is off', async () => {
    renderChart({ showBenchmark: false })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-wpm-chart')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-reference-line')).toBeNull()
  })

  it('does not render the reference line in timeOfDay mode even when the toggle is on', async () => {
    renderChart({ viewMode: 'timeOfDay' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-wpm-time-of-day')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-reference-line')).toBeNull()
  })
})

describe('WpmChart section order', () => {
  beforeEach(() => {
    setVialAPI()
  })

  // Regression guard, same pattern as RolloverSection's order-lock test:
  // pins chart-then-stat order in timeSeries mode, per the Analyze
  // convention that a chart always renders above its stat numbers.
  it('renders the chart above the stat card in timeSeries mode', async () => {
    renderChart({ viewMode: 'timeSeries' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-wpm-summary')).toBeTruthy()
    })
    const plot = screen.getByTestId('analyze-wpm-plot')
    const summary = screen.getByTestId('analyze-wpm-summary')
    expect(plot.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // Same guard for the timeOfDay bar chart, which shares the same
  // AnalyzeStatGrid testid as timeSeries above.
  it('renders the chart above the stat card in timeOfDay mode', async () => {
    renderChart({ viewMode: 'timeOfDay' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-wpm-summary')).toBeTruthy()
    })
    const plot = screen.getByTestId('analyze-wpm-plot')
    const summary = screen.getByTestId('analyze-wpm-summary')
    expect(plot.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
