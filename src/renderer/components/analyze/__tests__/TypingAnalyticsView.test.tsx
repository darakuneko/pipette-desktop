// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke tests for the Analyze view shell. The chart components are
// mocked out so we can exercise keyboard-list loading, analysis-tab
// switching, and the datetime/device selects without dragging recharts
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

interface MockChartProps {
  uid: string
  deviceScope: string
  range: { fromMs: number; toMs: number }
  unit?: string
}

function mockSummary(testId: string) {
  return (props: MockChartProps) => (
    <div data-testid={testId}>
      {`${props.uid}:${props.deviceScope}:range=${props.range.fromMs}-${props.range.toMs}${props.unit ? `:${props.unit}` : ''}`}
    </div>
  )
}

vi.mock('../WpmChart', () => ({ WpmChart: mockSummary('mock-wpm') }))
vi.mock('../IntervalChart', () => ({ IntervalChart: mockSummary('mock-interval') }))
vi.mock('../ActivityChart', () => ({ ActivityChart: mockSummary('mock-activity') }))

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

function wpmText(): string {
  return screen.getByTestId('mock-wpm').textContent ?? ''
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
    expect(wpmText()).toMatch(/^uid-a:own:range=\d+-\d+$/)
  })

  it('switches analysis tab to Interval and Heatmap', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('analyze-tab-interval'))
    expect(screen.getByTestId('mock-interval').textContent).toMatch(/^uid-a:own:range=\d+-\d+:sec$/)
    expect(screen.queryByTestId('mock-wpm')).toBeNull()

    fireEvent.change(screen.getByTestId('analyze-filter-unit'), { target: { value: 'ms' } })
    expect(screen.getByTestId('mock-interval').textContent).toMatch(/:ms$/)

    fireEvent.click(screen.getByTestId('analyze-tab-activity'))
    expect(screen.getByTestId('mock-activity').textContent).toMatch(/^uid-a:own:range=\d+-\d+$/)
    expect(screen.queryByTestId('mock-interval')).toBeNull()
  })

  it('propagates the selected keyboard to the chart props', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-b')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-kb-uid-b'))
    expect(wpmText()).toMatch(/^uid-b:own:range=/)
  })

  it('preselects initialUid when the keyboard is in the list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView initialUid="uid-b" />)
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())
    expect(wpmText()).toMatch(/^uid-b:own:range=/)
  })

  it('falls back to the first keyboard when initialUid is not in the list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView initialUid="uid-unknown" />)
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())
    expect(wpmText()).toMatch(/^uid-a:own:range=/)
  })

  it('propagates datetime-range and device changes down into the chart', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())

    const expectedFrom = new Date('2026-04-19T00:00').getTime()
    fireEvent.change(screen.getByTestId('analyze-filter-from'), { target: { value: '2026-04-19T00:00' } })
    expect(wpmText()).toContain(`range=${expectedFrom}-`)

    fireEvent.change(screen.getByTestId('analyze-filter-device'), { target: { value: 'all' } })
    expect(wpmText()).toMatch(/^uid-a:all:range=/)
  })
})
