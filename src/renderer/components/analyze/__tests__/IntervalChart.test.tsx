// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for the population-benchmark reference line only. Same
// recharts stub rationale as WpmChart.test.tsx.

import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IntervalChart } from '../IntervalChart'
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
  ReferenceLine: (props: { y?: number }) => (
    <div data-testid="analyze-reference-line" data-y={props.y} />
  ),
}))

const emptyPeakRecords: PeakRecords = {
  peakWpm: null,
  lowestWpm: null,
  peakKeystrokesPerMin: null,
  peakKeystrokesPerDay: null,
  longestSession: null,
}

function minuteRow(minuteMs: number): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes: 40,
    activeMs: 60_000,
    intervalMinMs: 80,
    intervalP25Ms: 120,
    intervalP50Ms: 180,
    intervalP75Ms: 260,
    intervalMaxMs: 900,
  }
}

const rows: TypingMinuteStatsRow[] = [minuteRow(0), minuteRow(60_000)]
const range = { fromMs: 0, toMs: 2 * 60_000 }

function setVialAPI(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsListMinuteStatsLocal: () => Promise.resolve(rows),
      typingAnalyticsGetPeakRecordsLocal: () => Promise.resolve(emptyPeakRecords),
    },
    writable: true,
    configurable: true,
  })
}

function renderChart(overrides: Partial<Parameters<typeof IntervalChart>[0]> = {}): void {
  render(
    <IntervalChart
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      unit="ms"
      granularity={60_000}
      viewMode="timeSeries"
      showBenchmark
      {...overrides}
    />,
  )
}

describe('IntervalChart benchmark reference line', () => {
  beforeEach(() => {
    setVialAPI()
  })

  it('renders the reference line at the population IKI mean (in ms) when the toggle is on', async () => {
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-reference-line')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-reference-line').getAttribute('data-y')).toBe('238.66')
  })

  // Regression guard: the chart's y-axis switches its *tick label* text
  // between ms and seconds via `unit`, but the plotted data (and thus the
  // reference line) always stays in ms. A conversion applied here by
  // mistake would put the line 1000x off whenever `unit === 'sec'`.
  it('keeps the reference line value in ms even when the display unit is seconds', async () => {
    renderChart({ unit: 'sec' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-reference-line')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-reference-line').getAttribute('data-y')).toBe('238.66')
  })

  it('does not render the reference line when the toggle is off', async () => {
    renderChart({ showBenchmark: false })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-interval-chart')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-reference-line')).toBeNull()
  })

  it('does not render the reference line in distribution mode even when the toggle is on', async () => {
    renderChart({ viewMode: 'distribution' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-interval-distribution')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-reference-line')).toBeNull()
  })
})
