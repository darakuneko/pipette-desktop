// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

describe('BigramsChart', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the empty state when the IPC returns no entries', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [] })
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="top"
        minSample={5}
        onViewChange={noop}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-empty')).toBeTruthy()
    })
  })

  it('renders top entries with decoded labels', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { bigramId: '4_11', count: 3, hist: [1, 2, 0, 0, 0, 0, 0, 0], avgIki: 60 },
      ],
    })
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="top"
        minSample={5}
        onViewChange={noop}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content').textContent).toContain('A → H')
    })
    // Top view does not show the p95 column.
    expect(screen.queryByText('analyze.bigrams.column.p95')).toBeNull()
  })

  it('shows the p95 column and the minSample input when view is slow', async () => {
    fetchSpy.mockResolvedValue({
      view: 'slow',
      entries: [
        {
          bigramId: '4_11',
          count: 5,
          hist: [0, 0, 0, 0, 0, 0, 0, 5],
          avgIki: 1500,
          p95: 1900,
        },
      ],
    })
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="slow"
        minSample={5}
        onViewChange={noop}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByText('analyze.bigrams.column.p95')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-min-sample-input')).toBeTruthy()
  })

  it('passes minSample to the IPC only when view is slow', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [] })
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="top"
        minSample={5}
        onViewChange={noop}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
    })
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    // (uid, fromMs, toMs, view, scope, options) — top view leaves
    // minSampleCount undefined so the handler can apply its default.
    const options = lastCall?.[5] as { minSampleCount?: number; limit?: number } | undefined
    expect(options?.minSampleCount).toBeUndefined()
    expect(options?.limit).toBe(30)
  })

  it('passes minSample to the IPC when view is slow', async () => {
    fetchSpy.mockResolvedValue({ view: 'slow', entries: [] })
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="slow"
        minSample={20}
        onViewChange={noop}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
    })
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    const options = lastCall?.[5] as { minSampleCount?: number; limit?: number } | undefined
    expect(options?.minSampleCount).toBe(20)
  })

  it('calls onViewChange when the select changes', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [] })
    const onViewChange = vi.fn()
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="top"
        minSample={5}
        onViewChange={onViewChange}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-view-select')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('analyze-bigrams-view-select'), {
      target: { value: 'slow' },
    })
    expect(onViewChange).toHaveBeenCalledWith('slow')
  })

  it('clamps minSample input to the bounded range', async () => {
    fetchSpy.mockResolvedValue({ view: 'slow', entries: [] })
    const onMinSampleChange = vi.fn()
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="slow"
        minSample={5}
        onViewChange={noop}
        onMinSampleChange={onMinSampleChange}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-min-sample-input')).toBeTruthy()
    })
    // Above bound → clamp to 1000.
    fireEvent.change(screen.getByTestId('analyze-bigrams-min-sample-input'), {
      target: { value: '99999' },
    })
    expect(onMinSampleChange).toHaveBeenLastCalledWith(1000)
    // Below bound → clamp to 1.
    fireEvent.change(screen.getByTestId('analyze-bigrams-min-sample-input'), {
      target: { value: '0' },
    })
    expect(onMinSampleChange).toHaveBeenLastCalledWith(1)
  })

  it('renders the error state when the IPC rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchSpy.mockRejectedValue(new Error('boom'))
    render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        view="top"
        minSample={5}
        onViewChange={noop}
        onMinSampleChange={noop}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-error')).toBeTruthy()
    })
    consoleSpy.mockRestore()
  })
})
