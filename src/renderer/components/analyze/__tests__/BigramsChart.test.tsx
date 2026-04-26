// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BigramsChart } from '../BigramsChart'
import type { TypingBigramAggregateResult } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingBigramAggregateResult>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetBigramAggregateForRange: (...args: unknown[]) => fetchSpy(...args),
  },
  writable: true,
})

const range = { fromMs: 0, toMs: 60_000 }
const noop = (): void => {}

function renderChart(overrides: Partial<Parameters<typeof BigramsChart>[0]> = {}): void {
  render(
    <BigramsChart
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      topLimit={10}
      slowLimit={10}
      fingerLimit={10}
      keyLimit={10}
      onTopLimitChange={noop}
      onSlowLimitChange={noop}
      onFingerLimitChange={noop}
      onKeyLimitChange={noop}
      snapshot={null}
      {...overrides}
    />,
  )
}

describe('BigramsChart', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('renders the empty state when the IPC returns no entries', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [] })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-empty')).toBeTruthy()
    })
  })

  it('fires a single fetch with view=top and a high limit', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [] })
    renderChart()
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
    const call = fetchSpy.mock.calls[0]
    expect(call?.[3]).toBe('top')
    const options = call?.[5] as { limit?: number } | undefined
    expect(options?.limit).toBeGreaterThan(100)
  })

  it('renders all four quadrants with their own limit selects', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { bigramId: '4_11', count: 10, hist: [1, 2, 3, 1, 1, 1, 1, 0], avgIki: 100 },
      ],
    })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByText('analyze.bigrams.quadrant.top')).toBeTruthy()
    expect(screen.getByText('analyze.bigrams.quadrant.slow')).toBeTruthy()
    expect(screen.getByText('analyze.bigrams.quadrant.fingerIki')).toBeTruthy()
    expect(screen.getByText('analyze.bigrams.quadrant.heatmap')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-top-limit-select')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-slow-limit-select')).toBeTruthy()
  })

  it('fires onTopLimitChange when the Top limit select changes', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { bigramId: '4_11', count: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0], avgIki: 30 },
      ],
    })
    const onTopLimitChange = vi.fn()
    renderChart({ onTopLimitChange })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-top-limit-select')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('analyze-bigrams-top-limit-select'), {
      target: { value: '20' },
    })
    expect(onTopLimitChange).toHaveBeenCalledWith(20)
  })

  it('fires onSlowLimitChange when the Slow limit select changes', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { bigramId: '4_11', count: 5, hist: [0, 0, 5, 0, 0, 0, 0, 0], avgIki: 125 },
      ],
    })
    const onSlowLimitChange = vi.fn()
    renderChart({ onSlowLimitChange })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-limit-select')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('analyze-bigrams-slow-limit-select'), {
      target: { value: '30' },
    })
    expect(onSlowLimitChange).toHaveBeenCalledWith(30)
  })

  it('renders the error state when the IPC rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchSpy.mockRejectedValue(new Error('boom'))
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-error')).toBeTruthy()
    })
    consoleSpy.mockRestore()
  })
})
