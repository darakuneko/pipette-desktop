// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke tests for the Analyze view shell. The chart components are
// mocked out so we can exercise keyboard-list loading, analysis-tab
// switching, and the period / device selects without dragging recharts
// or real DB data into jsdom.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { TypingKeyboardSummary } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}))

vi.mock('../WpmChart', () => ({
  WpmChart: (props: { uid: string; period: string; deviceScope: string }) => (
    <div data-testid="mock-wpm">{`${props.uid}:${props.period}:${props.deviceScope}`}</div>
  ),
}))

vi.mock('../IntervalChart', () => ({
  IntervalChart: (props: { uid: string; period: string; deviceScope: string }) => (
    <div data-testid="mock-interval">{`${props.uid}:${props.period}:${props.deviceScope}`}</div>
  ),
}))

vi.mock('../HeatmapChart', () => ({
  HeatmapChart: (props: { uid: string; period: string; deviceScope: string }) => (
    <div data-testid="mock-heatmap">{`${props.uid}:${props.period}:${props.deviceScope}`}</div>
  ),
}))

const mockListKeyboards = vi.fn<() => Promise<TypingKeyboardSummary[]>>()
let typingAnalyticsListKeyboardsSpy: ReturnType<typeof vi.spyOn>

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsListKeyboards: () => Promise.resolve([] as TypingKeyboardSummary[]),
  },
  writable: true,
})

const SAMPLE: TypingKeyboardSummary[] = [
  { uid: 'uid-a', productName: 'KB A', vendorId: 1, productId: 1 },
  { uid: 'uid-b', productName: 'KB B', vendorId: 2, productId: 2 },
]

async function importView(): Promise<typeof import('../TypingAnalyticsView')> {
  return await import('../TypingAnalyticsView')
}

describe('TypingAnalyticsView', () => {
  beforeEach(() => {
    mockListKeyboards.mockReset()
    typingAnalyticsListKeyboardsSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListKeyboards')
      .mockImplementation(() => mockListKeyboards())
  })

  afterEach(() => {
    typingAnalyticsListKeyboardsSpy.mockRestore()
  })

  it('shows the empty state when no keyboards have typing data', async () => {
    mockListKeyboards.mockResolvedValue([])
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-no-keyboards')).toBeInTheDocument())
    expect(typingAnalyticsListKeyboardsSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('mock-wpm')).toBeNull()
  })

  it('loads keyboards and renders the WPM chart for the first one by default', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-a')).toBeInTheDocument())
    expect(typingAnalyticsListKeyboardsSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mock-wpm')).toHaveTextContent('uid-a:30d:own')
  })

  it('switches analysis tab to Interval and Heatmap', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('analyze-tab-interval'))
    expect(screen.getByTestId('mock-interval')).toHaveTextContent('uid-a:30d:own')
    expect(screen.queryByTestId('mock-wpm')).toBeNull()

    fireEvent.click(screen.getByTestId('analyze-tab-heatmap'))
    expect(screen.getByTestId('mock-heatmap')).toHaveTextContent('uid-a:30d:own')
    expect(screen.queryByTestId('mock-interval')).toBeNull()
  })

  it('propagates the selected keyboard to the chart props', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-b')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-kb-uid-b'))
    expect(screen.getByTestId('mock-wpm')).toHaveTextContent('uid-b:30d:own')
  })

  it('propagates period and device changes down into the chart', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('analyze-filter-period'), { target: { value: '7d' } })
    expect(screen.getByTestId('mock-wpm')).toHaveTextContent('uid-a:7d:own')

    fireEvent.change(screen.getByTestId('analyze-filter-device'), { target: { value: 'all' } })
    expect(screen.getByTestId('mock-wpm')).toHaveTextContent('uid-a:7d:all')
  })
})
