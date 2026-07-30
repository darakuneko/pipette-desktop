// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for DurationSection: histogram folding, mean/SD/samples
// stats, the always-on population-average subline + position label,
// refetch on filter-prop change, and the empty state.

import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DurationSection } from '../DurationSection'
import type { TypingDurationCell } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    i18n: { language: 'en' },
  }),
}))

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children, data }: { children?: ReactNode; data?: unknown[] }) => (
    <div data-testid="analyze-duration-barchart" data-json={JSON.stringify(data)}>{children}</div>
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Bar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Cell: () => null,
}))

vi.mock('../../../hooks/useEffectiveTheme', () => ({
  useEffectiveTheme: () => 'light',
}))

const range = { fromMs: 0, toMs: 60_000 }

const durationFetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingDurationCell[]>>()

function cell(overrides: Partial<TypingDurationCell> = {}): TypingDurationCell {
  return {
    row: 0,
    col: 0,
    layer: 0,
    durationSamples: 0,
    hist: [0, 0, 0, 0, 0, 0, 0, 0],
    sum: 0,
    sumSq: 0,
    ...overrides,
  }
}

function setVialAPI(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsListDurationCells: (...args: unknown[]) => durationFetchSpy(...args),
    },
    writable: true,
    configurable: true,
  })
}

function renderSection(overrides: Partial<Parameters<typeof DurationSection>[0]> = {}): ReturnType<typeof render> {
  return render(
    <DurationSection
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      {...overrides}
    />,
  )
}

describe('DurationSection', () => {
  beforeEach(() => {
    setVialAPI()
    durationFetchSpy.mockReset()
    durationFetchSpy.mockResolvedValue([])
  })

  it('renders the empty state with a recording-conditions message when there is no data', async () => {
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-empty')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-duration-chart')).toBeNull()
  })

  it('computes mean/SD/samples from Σsum/ΣsumSq/Σn across cells', async () => {
    durationFetchSpy.mockResolvedValue([
      cell({ row: 0, col: 0, hist: [1, 0, 0, 0, 0, 0, 0, 0], durationSamples: 1, sum: 80, sumSq: 6_400 }),
      cell({ row: 0, col: 1, hist: [0, 1, 0, 0, 0, 0, 0, 0], durationSamples: 1, sum: 120, sumSq: 14_400 }),
    ])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-summary')).toBeTruthy()
    })
    const text = screen.getByTestId('analyze-duration-summary').textContent ?? ''
    // Mean = (80+120)/2 = 100ms; SD of [80,120] = 20ms; samples = 2.
    expect(text).toContain('100 ms')
    expect(text).toContain('20 ms')
    expect(text).toContain('2')
  })

  // Regression guard: SD and Samples used to render as bare numbers
  // with no explanation of what they mean (user feedback: "SD is not
  // understandable without an explanation"). Both now carry a
  // `descriptionKey`, rendered into a hover tooltip bubble that's
  // always portaled to `document.body` (opacity-hidden until hover —
  // see ui/Tooltip.tsx), so the assertion searches the whole document
  // rather than the stat-grid container, same as RolloverSection's
  // equivalent test.
  it('describes SD and Samples in a hover tooltip', async () => {
    durationFetchSpy.mockResolvedValue([
      cell({ hist: [1, 0, 0, 0, 0, 0, 0, 0], durationSamples: 1, sum: 80, sumSq: 6_400 }),
    ])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-summary')).toBeTruthy()
    })
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toContain('analyze.duration.stat.sdDesc')
      expect(text).toContain('analyze.duration.stat.samplesDesc')
    })
  })

  it('shows the population-average subline and a neutral position label unconditionally', async () => {
    durationFetchSpy.mockResolvedValue([
      cell({ hist: [0, 0, 0, 1, 0, 0, 0, 0], durationSamples: 1, sum: 116, sumSq: 116 * 116 }),
      cell({ row: 0, col: 1, hist: [0, 0, 0, 1, 0, 0, 0, 0], durationSamples: 1, sum: 116, sumSq: 116 * 116 }),
    ])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-summary')).toBeTruthy()
    })
    const text = screen.getByTestId('analyze-duration-summary').textContent ?? ''
    expect(text).toContain('analyze.duration.stat.populationAverage')
    expect(text).toContain('analyze.benchmark.position.average')
  })

  it('renders the histogram bars with the folded per-bucket counts', async () => {
    durationFetchSpy.mockResolvedValue([
      cell({ hist: [3, 0, 0, 0, 0, 0, 0, 0], durationSamples: 3, sum: 120, sumSq: 4_800 }),
      cell({ row: 0, col: 1, hist: [0, 2, 0, 0, 0, 0, 0, 0], durationSamples: 2, sum: 130, sumSq: 8_450 }),
    ])
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-barchart')).toBeTruthy()
    })
    const json = screen.getByTestId('analyze-duration-barchart').getAttribute('data-json')
    const data = JSON.parse(json ?? '[]') as { index: number; label: string; count: number }[]
    expect(data[0]).toEqual({ index: 0, label: 'analyze.duration.bin.lt50', count: 3 })
    expect(data[1]).toEqual({ index: 1, label: 'analyze.duration.bin.50to80', count: 2 })
    expect(data).toHaveLength(8)
  })

  it('refetches when the range prop changes (shared-filter reactivity contract)', async () => {
    const { rerender } = renderSection()
    await waitFor(() => expect(durationFetchSpy).toHaveBeenCalledTimes(1))
    rerender(
      <DurationSection
        uid="0xAABB"
        range={{ fromMs: 60_000, toMs: 120_000 }}
        deviceScopes={['own']}
        appScopes={[]}
        typingTestScopes={[]}
        runIdScopes={[]}
      />,
    )
    await waitFor(() => expect(durationFetchSpy).toHaveBeenCalledTimes(2))
  })

  it('resets to empty and stops fetching when uid is falsy', async () => {
    durationFetchSpy.mockResolvedValue([cell({ durationSamples: 1, sum: 100, sumSq: 10_000 })])
    renderSection({ uid: '' })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-empty')).toBeTruthy()
    })
    expect(durationFetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to empty on a rejected fetch instead of throwing', async () => {
    durationFetchSpy.mockRejectedValue(new Error('boom'))
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-duration-empty')).toBeTruthy()
    })
  })

  it('forces the own device scope even when deviceScopes is an all/hash scope (scope consistency with IntervalChart distribution mode)', async () => {
    renderSection({ deviceScopes: ['all'] })
    await waitFor(() => expect(durationFetchSpy).toHaveBeenCalledTimes(1))
    expect(durationFetchSpy.mock.calls[0][1]).toBe('own')

    durationFetchSpy.mockClear()
    renderSection({ deviceScopes: [{ kind: 'hash', machineHash: 'abc123' }] })
    await waitFor(() => expect(durationFetchSpy).toHaveBeenCalledTimes(1))
    expect(durationFetchSpy.mock.calls[0][1]).toBe('own')
  })

  // This section only ever renders under AnalyzePane's "Section"
  // filter-row select, which already labels it visually (shared
  // `sectionTitle` key) — no in-body <h3> here. `aria-label` on the
  // section keeps the name available to assistive tech even without a
  // visible heading.
  it('has no visible section title, but exposes the same name via aria-label', async () => {
    renderSection()
    const section = await waitFor(() => screen.getByTestId('analyze-duration-section'))
    expect(screen.queryByText('analyze.duration.sectionTitle')).toBeNull()
    expect(section.getAttribute('aria-label')).toBe('analyze.duration.sectionTitle')
  })
})
