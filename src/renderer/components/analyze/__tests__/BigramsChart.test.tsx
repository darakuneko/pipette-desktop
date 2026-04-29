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
      appScopes={[]}
      topLimit={10}
      slowLimit={10}
      fingerLimit={10}
      pairIntervalThresholdMs={0}
      onTopLimitChange={noop}
      onSlowLimitChange={noop}
      onFingerLimitChange={noop}
      onPairIntervalThresholdChange={noop}
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

  it('renders all three quadrants with their own limit selects', async () => {
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
    expect(screen.queryByText('analyze.bigrams.quadrant.heatmap')).toBeNull()
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

  // Bucket centers: [30, 80, 125, 175, 250, 400, 750, 1500]. The two
  // entries below land at avgIki = 30 ms (fast) and avgIki = 400 ms
  // (slow), so any threshold in (30, 400] hides the fast one without
  // touching the slow one.
  const thresholdEntries = [
    { bigramId: '4_11', count: 3, hist: [3, 0, 0, 0, 0, 0, 0, 0], avgIki: 30 },
    { bigramId: '7_22', count: 5, hist: [0, 0, 0, 0, 0, 5, 0, 0], avgIki: 400 },
  ]

  it('renders both rows in the Slow ranking when the threshold is 0', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    renderChart({ pairIntervalThresholdMs: 0, slowLimit: 10 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-ranking')).toBeTruthy()
    })
    const rows = screen.getByTestId('analyze-bigrams-slow-ranking').querySelectorAll('tbody tr')
    expect(rows.length).toBe(2)
  })

  it('hides Slow ranking rows whose avgIki is below the threshold', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    renderChart({ pairIntervalThresholdMs: 200, slowLimit: 10 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-ranking')).toBeTruthy()
    })
    const rows = screen.getByTestId('analyze-bigrams-slow-ranking').querySelectorAll('tbody tr')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('400 ms')
  })

  it('shows the empty state when the threshold filters every row out', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    renderChart({ pairIntervalThresholdMs: 1000, slowLimit: 10 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-bigrams-slow-ranking')).toBeNull()
  })

  it('commits an empty threshold input as 0', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    const onPairIntervalThresholdChange = vi.fn()
    renderChart({
      pairIntervalThresholdMs: 200,
      onPairIntervalThresholdChange,
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
    })
    const input = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onPairIntervalThresholdChange).toHaveBeenCalledWith(0)
  })

  it('commits the threshold input on blur with the parsed integer', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    const onPairIntervalThresholdChange = vi.fn()
    renderChart({
      pairIntervalThresholdMs: 0,
      onPairIntervalThresholdChange,
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
    })
    const input = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.blur(input)
    expect(onPairIntervalThresholdChange).toHaveBeenCalledWith(150)
  })

  it('renders the threshold input in both fingerIki and slow quadrants', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-bigrams-finger-threshold-input')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
  })

  it('commits the threshold input on Enter without losing focus first', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    const onPairIntervalThresholdChange = vi.fn()
    renderChart({
      pairIntervalThresholdMs: 0,
      onPairIntervalThresholdChange,
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
    })
    const input = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '300' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPairIntervalThresholdChange).toHaveBeenCalledWith(300)
  })

  it('mirrors a committed threshold to the sibling quadrant input', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries })
    const { rerender } = render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        appScopes={[]}
        topLimit={10}
        slowLimit={10}
        fingerLimit={10}
        pairIntervalThresholdMs={0}
        onTopLimitChange={noop}
        onSlowLimitChange={noop}
        onFingerLimitChange={noop}
        onPairIntervalThresholdChange={noop}
        snapshot={null}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-finger-threshold-input')).toBeTruthy()
    })
    // Simulate the parent persisting a new value (e.g. the slow input
    // committed) — the fingerIki input must pick up the new value.
    rerender(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        appScopes={[]}
        topLimit={10}
        slowLimit={10}
        fingerLimit={10}
        pairIntervalThresholdMs={250}
        onTopLimitChange={noop}
        onSlowLimitChange={noop}
        onFingerLimitChange={noop}
        onPairIntervalThresholdChange={noop}
        snapshot={null}
      />,
    )
    const fingerInput = screen.getByTestId('analyze-bigrams-finger-threshold-input') as HTMLInputElement
    const slowInput = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    expect(fingerInput.value).toBe('250')
    expect(slowInput.value).toBe('250')
  })
})
