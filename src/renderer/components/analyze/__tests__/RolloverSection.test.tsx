// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for RolloverSection: rate computation (incl. "—" on empty),
// refetch on filter-prop change (shared-filter reactivity contract),
// reference line + under-bias note gated on showBenchmark, and the
// chart series staying in percent with gaps on null-ratio buckets.

import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RolloverSection } from '../RolloverSection'
import type { TypingMinuteStatsRow, TypingRolloverMinuteRow } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    i18n: { language: 'en' },
  }),
}))

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children?: ReactNode; data?: unknown[] }) => (
    <div data-testid="analyze-rollover-linechart" data-json={JSON.stringify(data)}>{children}</div>
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Line: () => null,
  ReferenceLine: (props: { y?: number }) => (
    <div data-testid="analyze-reference-line" data-y={props.y} />
  ),
}))

const MINUTE = 60_000
const range = { fromMs: 0, toMs: 3 * MINUTE }

const rolloverFetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingRolloverMinuteRow[]>>()
const minuteStatsFetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingMinuteStatsRow[]>>()

function statsRow(minuteMs: number, overrides: Partial<TypingMinuteStatsRow> = {}): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes: 10,
    activeMs: 1_000,
    intervalMinMs: 50,
    intervalP25Ms: 100,
    intervalP50Ms: 150,
    intervalP75Ms: 200,
    intervalMaxMs: 400,
    ...overrides,
  }
}

function setVialAPI(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsListRolloverMinutes: (...args: unknown[]) => rolloverFetchSpy(...args),
      typingAnalyticsListMinuteStatsLocal: (...args: unknown[]) => minuteStatsFetchSpy(...args),
    },
    writable: true,
    configurable: true,
  })
}

function renderSection(overrides: Partial<Parameters<typeof RolloverSection>[0]> = {}): ReturnType<typeof render> {
  return render(
    <RolloverSection
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      granularity={MINUTE}
      showBenchmark
      {...overrides}
    />,
  )
}

describe('RolloverSection', () => {
  beforeEach(() => {
    setVialAPI()
    rolloverFetchSpy.mockReset()
    minuteStatsFetchSpy.mockReset()
    rolloverFetchSpy.mockResolvedValue([])
    minuteStatsFetchSpy.mockResolvedValue([])
  })

  it('renders the overall rate as a 1-decimal percent from Σoc/Σon', async () => {
    rolloverFetchSpy.mockResolvedValue([
      { minuteTs: 0, oc: 1, on: 4 },
      { minuteTs: MINUTE, oc: 2, on: 4 },
    ])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-summary')).toBeTruthy()
    })
    // Σoc=3, Σon=8 -> 37.5%
    expect(screen.getByTestId('analyze-rollover-summary').textContent).toContain('37.5%')
  })

  it('bakes the median p50 / worst p95 effective sampling period into the description params', async () => {
    minuteStatsFetchSpy.mockResolvedValue([
      statsRow(0, { pollP50Ms: 10, pollP95Ms: 30 }),
      statsRow(MINUTE, { pollP50Ms: 20, pollP95Ms: 90 }),
    ])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-summary')).toBeTruthy()
    })
    // The description renders into a tooltip bubble portaled to
    // document.body (always mounted, just opacity-hidden until hover —
    // see ui/Tooltip.tsx), so the assertion searches the whole document
    // rather than scoping to the stat-grid container. The portal mounts
    // via the tooltip's own effect, a tick after the stat-grid testid
    // above appears, so this also needs `waitFor` rather than a single
    // read right after the first one settles.
    // Median p50 of [10, 20] = 15 ms; worst (max) p95 of [30, 90] = 90 ms.
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toContain('"p50":"15 ms"')
      expect(text).toContain('"p95":"90 ms"')
    })
  })

  it('still renders the rollover chart/stat when the minute-stats fetch rejects', async () => {
    // `listMinuteStatsForScope` is de-duped and can be a promise
    // literally shared with IntervalChart's own fetch — a rejection
    // there is out of this section's control and must only degrade the
    // sampling-period caption to "—", never blank the rollover data,
    // which comes from the other (independent) fetch.
    rolloverFetchSpy.mockResolvedValue([{ minuteTs: 0, oc: 1, on: 4 }])
    minuteStatsFetchSpy.mockRejectedValue(new Error('boom'))
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-summary')).toBeTruthy()
    })
    // Rollover rate still computed from the successful fetch.
    expect(screen.getByTestId('analyze-rollover-summary').textContent).toContain('25.0%')
    // Chart still renders (not replaced by the empty/no-data state).
    expect(screen.getByTestId('analyze-rollover-chart')).toBeTruthy()
  })

  it('shows "—" for the rate when no minute has observed-overlap data', async () => {
    rolloverFetchSpy.mockResolvedValue([])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-summary')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-rollover-summary').textContent).toContain('—')
  })

  it('refetches when the range prop changes (shared-filter reactivity contract)', async () => {
    const { rerender } = renderSection()
    await waitFor(() => expect(rolloverFetchSpy).toHaveBeenCalledTimes(1))

    rerender(
      <RolloverSection
        uid="0xAABB"
        range={{ fromMs: MINUTE, toMs: 4 * MINUTE }}
        deviceScopes={['own']}
        appScopes={[]}
        typingTestScopes={[]}
        runIdScopes={[]}
        granularity={MINUTE}
        showBenchmark
      />,
    )
    await waitFor(() => expect(rolloverFetchSpy).toHaveBeenCalledTimes(2))
  })

  it('resets to empty and stops fetching when uid is falsy', async () => {
    rolloverFetchSpy.mockResolvedValue([{ minuteTs: 0, oc: 1, on: 2 }])
    renderSection({ uid: '' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-empty')).toBeTruthy()
    })
    expect(rolloverFetchSpy).not.toHaveBeenCalled()
  })

  it('renders the reference line and the under-bias note only when showBenchmark is on', async () => {
    rolloverFetchSpy.mockResolvedValue([{ minuteTs: 0, oc: 1, on: 2 }])
    renderSection({ showBenchmark: true })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-reference-line')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-rollover-under-bias-note')).toBeTruthy()
  })

  it('renders neither the reference line nor the under-bias note when showBenchmark is off', async () => {
    rolloverFetchSpy.mockResolvedValue([{ minuteTs: 0, oc: 1, on: 2 }])
    renderSection({ showBenchmark: false })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-chart')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-reference-line')).toBeNull()
    expect(screen.queryByTestId('analyze-rollover-under-bias-note')).toBeNull()
  })

  // Regression guard: the chart used to render above the stat card,
  // the only section on this tab that did — every sibling display here
  // (chart above numbers) is the other way around. Pin chart-then-stat
  // order so a future edit can't silently flip it back.
  it('renders the chart above the stat card, matching every other section\'s chart-then-numbers order', async () => {
    rolloverFetchSpy.mockResolvedValue([{ minuteTs: 0, oc: 1, on: 2 }])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-chart')).toBeTruthy()
    })
    const chart = screen.getByTestId('analyze-rollover-chart')
    const summary = screen.getByTestId('analyze-rollover-summary')
    // DOCUMENT_POSITION_FOLLOWING (4) set on `chart` relative to
    // `summary` means chart comes first in document order.
    expect(chart.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('bucketizes the series in percent, filling every bucket in range with a null gap where unobserved', async () => {
    // Range is [0, 3*MINUTE) at 1-min granularity -> 3 buckets. Only
    // minute 0 has data; the other two must come back null (a gap in
    // the line), not 0%.
    rolloverFetchSpy.mockResolvedValue([{ minuteTs: 0, oc: 1, on: 2 }])
    renderSection({ granularity: MINUTE })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-rollover-linechart')).toBeTruthy()
    })
    const json = screen.getByTestId('analyze-rollover-linechart').getAttribute('data-json')
    const data = JSON.parse(json ?? '[]') as { bucketStartMs: number; ratioPercent: number | null }[]
    expect(data).toEqual([
      { bucketStartMs: 0, ratioPercent: 50 },
      { bucketStartMs: MINUTE, ratioPercent: null },
      { bucketStartMs: 2 * MINUTE, ratioPercent: null },
    ])
  })
})
