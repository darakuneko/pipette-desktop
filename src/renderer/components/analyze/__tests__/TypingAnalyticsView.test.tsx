// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke tests for the Analyze view shell. The chart components are
// mocked out so we can exercise keyboard-list loading, analysis-tab
// switching, and the datetime/device selects without dragging recharts
// or real DB data into jsdom.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { TypingKeyboardSummary, TypingKeymapSnapshot } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))

interface MockChartProps {
  uid: string
  deviceScope: string
  range: { fromMs: number; toMs: number }
  unit?: string
  granularity?: 'auto' | number
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
vi.mock('../KeyHeatmapChart', () => ({ KeyHeatmapChart: mockSummary('mock-keyheatmap') }))

const mockListKeyboards = vi.fn<() => Promise<TypingKeyboardSummary[]>>()
const mockGetSnapshot = vi.fn<() => Promise<TypingKeymapSnapshot | null>>()
let typingAnalyticsListKeyboardsSpy: ReturnType<typeof vi.spyOn>
let typingAnalyticsGetSnapshotSpy: ReturnType<typeof vi.spyOn>

const emptyPeakRecords = {
  peakWpm: null,
  lowestWpm: null,
  peakKeystrokesPerMin: null,
  peakKeystrokesPerDay: null,
  longestSession: null,
}

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsListKeyboards: () => Promise.resolve([] as TypingKeyboardSummary[]),
    typingAnalyticsGetKeymapSnapshotForRange: () => Promise.resolve(null as TypingKeymapSnapshot | null),
    typingAnalyticsListKeymapSnapshots: () => Promise.resolve([]),
    typingAnalyticsGetPeakRecords: () => Promise.resolve(emptyPeakRecords),
    typingAnalyticsGetPeakRecordsLocal: () => Promise.resolve(emptyPeakRecords),
    pipetteSettingsGet: () => Promise.resolve(null),
    // `useAnalyzeFilters` debounces filter writes through this setter.
    // Stubbing it with a no-op keeps the tests focused on prop
    // propagation without waiting on the 300 ms flush timer.
    pipetteSettingsSet: () => Promise.resolve({ success: true as const }),
    // Analyze mount pulls analytics via this IPC. Resolving `false`
    // keeps the rate-limit ref unset so nothing leaks across tests.
    syncAnalyticsNow: () => Promise.resolve(false),
  },
  writable: true,
})

const SAMPLE: TypingKeyboardSummary[] = [
  { uid: 'uid-a', productName: 'KB A', vendorId: 1, productId: 1 },
  { uid: 'uid-b', productName: 'KB B', vendorId: 2, productId: 2 },
]

const SNAPSHOT: TypingKeymapSnapshot = {
  uid: 'uid-a',
  machineHash: 'm1',
  productName: 'KB A',
  savedAt: 0,
  layers: 1,
  matrix: { rows: 1, cols: 1 },
  keymap: [[['KC_NO']]],
  layout: { keys: [] },
}

async function importView(): Promise<typeof import('../TypingAnalyticsView')> {
  return await import('../TypingAnalyticsView')
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? ''
}

describe('TypingAnalyticsView', () => {
  beforeEach(() => {
    mockListKeyboards.mockReset()
    mockGetSnapshot.mockReset().mockResolvedValue(null)
    typingAnalyticsListKeyboardsSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListKeyboards')
      .mockImplementation(() => mockListKeyboards())
    typingAnalyticsGetSnapshotSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsGetKeymapSnapshotForRange')
      .mockImplementation(() => mockGetSnapshot())
  })

  afterEach(() => {
    typingAnalyticsListKeyboardsSpy.mockRestore()
    typingAnalyticsGetSnapshotSpy.mockRestore()
  })

  it('shows the empty state when no keyboards have typing data', async () => {
    mockListKeyboards.mockResolvedValue([])
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-no-keyboards')).toBeInTheDocument())
    expect(typingAnalyticsListKeyboardsSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('mock-wpm')).toBeNull()
  })

  it('defaults to the Heatmap tab, showing the no-snapshot notice without one', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-a')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('analyze-keyheatmap-empty')).toBeInTheDocument())
    expect(screen.queryByTestId('mock-wpm')).toBeNull()
  })

  it('renders the mocked KeyHeatmapChart when a snapshot is available', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    mockGetSnapshot.mockResolvedValue(SNAPSHOT)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-keyheatmap')).toBeInTheDocument())
    expect(text('mock-keyheatmap')).toMatch(/^uid-a:own:range=/)
  })

  it('switches analysis tab from Heatmap to WPM / Interval / Activity', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-keyheatmap-empty')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-a:own:range=\d+-\d+$/)

    fireEvent.click(screen.getByTestId('analyze-tab-interval'))
    expect(text('mock-interval')).toMatch(/:sec$/)

    fireEvent.change(screen.getByTestId('analyze-filter-unit'), { target: { value: 'ms' } })
    expect(text('mock-interval')).toMatch(/:ms$/)

    fireEvent.click(screen.getByTestId('analyze-tab-activity'))
    expect(text('mock-activity')).toMatch(/^uid-a:own:range=\d+-\d+$/)
  })

  it('propagates the selected keyboard to the chart props', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-b')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-kb-uid-b'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-b:own:range=/)
  })

  it('preselects initialUid when the keyboard is in the list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView initialUid="uid-b" />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-b')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-b:own:range=/)
  })

  it('falls back to the first keyboard when initialUid is not in the list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView initialUid="uid-unknown" />)
    await waitFor(() => expect(screen.getByTestId('analyze-kb-uid-a')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-a:own:range=/)
  })

  it('propagates datetime-range and device changes down into the chart', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-keyheatmap-empty')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())

    const expectedFrom = new Date('2026-04-19T00:00').getTime()
    fireEvent.change(screen.getByTestId('analyze-filter-from'), { target: { value: '2026-04-19T00:00' } })
    expect(text('mock-wpm')).toContain(`range=${expectedFrom}-`)

    fireEvent.change(screen.getByTestId('analyze-filter-device'), { target: { value: 'all' } })
    expect(text('mock-wpm')).toMatch(/^uid-a:all:range=/)
  })

  it('fires syncAnalyticsNow for the initial keyboard on Analyze mount', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const syncSpy = vi.spyOn(window.vialAPI, 'syncAnalyticsNow').mockResolvedValue(true)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('uid-a'))
    syncSpy.mockRestore()
  })

  it('fires syncAnalyticsNow again when the selected keyboard switches', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const syncSpy = vi.spyOn(window.vialAPI, 'syncAnalyticsNow').mockResolvedValue(true)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('uid-a'))
    fireEvent.click(screen.getByTestId('analyze-kb-uid-b'))
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('uid-b'))
    syncSpy.mockRestore()
  })
})
