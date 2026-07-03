// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke tests for the Analyze view shell. The chart components are
// mocked out so we can exercise keyboard-list loading, analysis-tab
// switching, and the datetime/device selects without dragging recharts
// or real DB data into jsdom.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { TypingKeyboardSummary, TypingKeymapSnapshot, TypingKeymapSnapshotSummary } from '../../../../shared/types/typing-analytics'
import { formatRunDateLabel } from '../../../hooks/useRunLabels'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))

type MockScope = 'own' | 'all' | { kind: 'hash'; machineHash: string }

interface MockChartProps {
  uid: string
  // Multi charts pass `deviceScopes`; single-scope charts (Heatmap /
  // Activity) keep `deviceScope` — the mock derives a primary scope
  // from whichever shape lands so the same template covers both.
  deviceScope?: MockScope
  deviceScopes?: readonly MockScope[]
  range: { fromMs: number; toMs: number }
  unit?: string
  granularity?: 'auto' | number
}

// Serialise the scope so the hash-scope object round-trips into a
// comparable string in the `textContent` snapshot assertions.
function scopeText(scope: MockScope): string {
  return typeof scope === 'string' ? scope : `hash:${scope.machineHash}`
}

function primaryScope(props: MockChartProps): MockScope {
  if (props.deviceScope !== undefined) return props.deviceScope
  if (props.deviceScopes && props.deviceScopes.length > 0) return props.deviceScopes[0]
  return 'own'
}

function mockSummary(testId: string) {
  return (props: MockChartProps) => (
    <div data-testid={testId}>
      {`${props.uid}:${scopeText(primaryScope(props))}:range=${props.range.fromMs}-${props.range.toMs}${props.unit ? `:${props.unit}` : ''}`}
    </div>
  )
}

vi.mock('../WpmChart', () => ({ WpmChart: mockSummary('mock-wpm') }))
vi.mock('../IntervalChart', () => ({ IntervalChart: mockSummary('mock-interval') }))
vi.mock('../ActivityChart', () => ({ ActivityChart: mockSummary('mock-activity') }))
vi.mock('../KeyHeatmapChart', () => ({ KeyHeatmapChart: mockSummary('mock-keyheatmap') }))
vi.mock('../ErgonomicsChart', () => ({
  // Surface the finger-assignment open callback as a button so the
  // modal-open test can drive it; the button now lives inside the real
  // chart's title row instead of the AnalyzePane filter bar.
  ErgonomicsChart: (props: MockChartProps & { onOpenFingerAssignment?: () => void }) => (
    <div data-testid="mock-ergonomics">
      {`${props.uid}:${scopeText(primaryScope(props))}:range=${props.range.fromMs}-${props.range.toMs}`}
      {props.onOpenFingerAssignment ? (
        <button
          type="button"
          data-testid="analyze-finger-assignment-open"
          onClick={props.onOpenFingerAssignment}
        >
          open
        </button>
      ) : null}
    </div>
  ),
}))
vi.mock('../BigramsChart', () => ({ BigramsChart: mockSummary('mock-bigrams') }))
vi.mock('../LayerUsageChart', () => ({ LayerUsageChart: mockSummary('mock-layer') }))
// Monitor App charts mounted alongside their parent tabs (WPM /
// Activity). Mocked here so the existing "renders mock-wpm" specs
// still see a single mock and don't trip on the new IPC calls.
vi.mock('../WpmByAppChart', () => ({ WpmByAppChart: mockSummary('mock-wpm-by-app') }))
vi.mock('../AppUsageChart', () => ({ AppUsageChart: mockSummary('mock-app-usage') }))
// Summary tab is the default landing tab. Mock it shallow so the
// streak/goal IPCs underneath don't matter for shell-level smoke tests.
vi.mock('../SummaryView', () => ({
  SummaryView: (props: { uid: string; deviceScope?: MockScope }) => (
    <div data-testid="mock-summary">
      {`${props.uid}:${scopeText(props.deviceScope ?? 'own')}`}
    </div>
  ),
}))

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
    typingAnalyticsListDeviceInfos: () => Promise.resolve({
      own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
      remotes: [],
    }),
    // Ergonomics/Heatmap charts call into the matrix-heatmap endpoint
    // when rendered for real (not all tests mock them out), so stub it
    // with an empty payload to avoid `undefined is not a function`.
    typingAnalyticsGetMatrixHeatmapForRange: () => Promise.resolve({}),
    typingAnalyticsGetPeakRecords: () => Promise.resolve(emptyPeakRecords),
    typingAnalyticsGetPeakRecordsLocal: () => Promise.resolve(emptyPeakRecords),
    // Summary's StreakGoalCard pulls daily summaries via these IPCs.
    // The mocked SummaryView short-circuits the call in this suite, but
    // the stubs stay so any future spec that unmocks SummaryView (or
    // mounts the real card) doesn't trip on `undefined is not a function`.
    typingAnalyticsListItems: () => Promise.resolve([]),
    typingAnalyticsListItemsLocal: () => Promise.resolve([]),
    typingAnalyticsListItemsForHash: () => Promise.resolve([]),
    // The AppSelect filter mounted in the analyze pane fetches the
    // distinct app names for the current range. An empty list keeps
    // the dropdown showing only "All apps" — fine for these tests
    // since they don't exercise the app filter.
    typingAnalyticsListAppsForRange: () => Promise.resolve([]),
    // Run rows for the chip's run labels / the modal's Results select.
    // Empty by default; the history-less-run chip test overrides it.
    typingAnalyticsListTypingTestRunsForRange: () => Promise.resolve([]),
    pipetteSettingsGet: () => Promise.resolve(null),
    // `useAnalyzeFilters` debounces filter writes through this patcher.
    // Stubbing it with a no-op keeps the tests focused on prop
    // propagation without waiting on the 300 ms flush timer.
    pipetteSettingsPatch: () => Promise.resolve({ success: true as const }),
    // Analyze mount pulls analytics via this IPC. Resolving `false`
    // keeps the rate-limit ref unset so nothing leaks across tests.
    syncAnalyticsNow: () => Promise.resolve(false),
    // The overlay subscribes to sync progress events. The default stub
    // is a no-op subscriber returning a no-op unsubscribe function.
    syncOnProgress: () => () => {},
    // Hub origin is fetched once on AnalyzePane mount to build "open
    // on Hub" links. Returning a non-empty string keeps the upload
    // panel rendering without forcing every test to override.
    hubGetOrigin: () => Promise.resolve('https://pipette-hub-test.example'),
    openExternal: () => Promise.resolve(undefined),
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

// Filter interactions now go chip -> staged modal -> control -> Apply
// (Plan-analyze-filter-modal). `openFilterModal` opens pane A's modal;
// callers then change a control and click `analyze-filter-modal-apply`
// to commit — nothing reaches the chart props before Apply.
function openFilterModal(): void {
  fireEvent.click(screen.getByTestId('analyze-filter-chip'))
}

function applyFilterModal(): void {
  fireEvent.click(screen.getByTestId('analyze-filter-modal-apply'))
}

describe('TypingAnalyticsView', () => {
  beforeEach(async () => {
    // The pane's syncAnalyticsNow rate-limit map lives at module scope
    // so split-view panes share it; clear between tests so each spec
    // starts with a clean slate.
    const { _resetAnalyticsSyncRateLimitForTests } = await import('../AnalyzePane')
    _resetAnalyticsSyncRateLimitForTests()
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
    await waitFor(() => expect(screen.getByTestId('analyze-filter-chip')).toBeInTheDocument())
    openFilterModal()
    await waitFor(() => expect(screen.getByTestId('analyze-no-keyboards')).toBeInTheDocument())
    expect(typingAnalyticsListKeyboardsSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('mock-wpm')).toBeNull()
  })

  it('defaults to the Summary tab on mount', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('analyze-filter-chip-keyboard')).toHaveTextContent('KB A'))
    await waitFor(() => expect(screen.getByTestId('mock-summary')).toBeInTheDocument())
    expect(text('mock-summary')).toBe('uid-a:own')
    expect(screen.queryByTestId('mock-wpm')).toBeNull()
    expect(screen.queryByTestId('analyze-keyheatmap-empty')).toBeNull()
  })

  it('renders the mocked KeyHeatmapChart after switching to the Heatmap tab when a snapshot is available', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    mockGetSnapshot.mockResolvedValue(SNAPSHOT)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-summary')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-keyHeatmap'))
    await waitFor(() => expect(screen.getByTestId('mock-keyheatmap')).toBeInTheDocument())
    expect(text('mock-keyheatmap')).toMatch(/^uid-a:own:range=/)
  })

  it('switches analysis tab from Summary to WPM / Interval / Activity', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-summary')).toBeInTheDocument())

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
    await waitFor(() => expect(screen.getByTestId('analyze-filter-chip-keyboard')).toHaveTextContent('KB A'))
    openFilterModal()
    await screen.findByTestId('analyze-kb-uid-b')
    fireEvent.change(screen.getByTestId('analyze-filter-keyboard'), { target: { value: 'uid-b' } })
    applyFilterModal()
    await waitFor(() => expect(screen.getByTestId('analyze-filter-chip-keyboard')).toHaveTextContent('KB B'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-b:own:range=/)
  })

  it('preselects initialUid when the keyboard is in the list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView initialUid="uid-b" />)
    await waitFor(() => expect(screen.getByTestId('analyze-filter-chip-keyboard')).toHaveTextContent('KB B'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-b:own:range=/)
  })

  it('falls back to the first keyboard when initialUid is not in the list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView initialUid="uid-unknown" />)
    await waitFor(() => expect(screen.getByTestId('analyze-filter-chip-keyboard')).toHaveTextContent('KB A'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    expect(text('mock-wpm')).toMatch(/^uid-a:own:range=/)
  })

  it('propagates time-of-day and device changes down into the chart', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByTestId('mock-summary')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())
    const initialFromMs = Number.parseInt(text('mock-wpm').match(/range=(\d+)-/)?.[1] ?? '0', 10)

    // Open the staged modal, edit both Period and Device, then Apply —
    // draft edits don't reach the chart until the single Apply commit.
    openFilterModal()
    await screen.findByTestId('analyze-filter-device')
    fireEvent.click(screen.getByTestId('analyze-filter-range'))
    // DayPicker drives the date portion; we cover the time-input wiring
    // here with HH:mm changes, which update the draft range immediately.
    fireEvent.change(screen.getByTestId('analyze-filter-range-from'), { target: { value: '09:30' } })
    fireEvent.change(screen.getByTestId('analyze-filter-device'), { target: { value: 'all' } })
    applyFilterModal()

    await waitFor(() => {
      const fromMs = Number.parseInt(text('mock-wpm').match(/range=(\d+)-/)?.[1] ?? '0', 10)
      const d = new Date(fromMs)
      expect(d.getHours()).toBe(9)
      expect(d.getMinutes()).toBe(30)
      expect(fromMs).not.toBe(initialFromMs)
    })
    expect(text('mock-wpm')).toMatch(/^uid-a:all:range=/)
  })

  it('shows the keyboards-loading overlay before listKeyboards resolves and hides it after', async () => {
    let resolveKb: (v: TypingKeyboardSummary[]) => void = () => {}
    mockListKeyboards.mockReturnValue(new Promise<TypingKeyboardSummary[]>((r) => { resolveKb = r }))
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    expect(screen.getByText('analyze.loading.keyboards')).toBeInTheDocument()
    resolveKb([])
    await waitFor(() => expect(screen.queryByText('analyze.loading.keyboards')).toBeNull())
    openFilterModal()
    await waitFor(() => expect(screen.getByTestId('analyze-no-keyboards')).toBeInTheDocument())
  })

  it('flips to the syncing phase while syncAnalyticsNow is in flight', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    let resolveSync: (v: boolean) => void = () => {}
    const syncSpy = vi
      .spyOn(window.vialAPI, 'syncAnalyticsNow')
      .mockImplementation(() => new Promise<boolean>((r) => { resolveSync = r }))
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(screen.getByText('analyze.loading.syncing')).toBeInTheDocument())
    // Device name is intentionally suppressed in the overlay (the
    // sidebar already surfaces it), so only the sidebar button
    // renders the product name.
    expect(screen.getAllByText(SAMPLE[0].productName).length).toBe(1)
    resolveSync(true)
    await waitFor(() => expect(screen.queryByText('analyze.loading.syncing')).toBeNull())
    syncSpy.mockRestore()
  })

  it('keeps a persisted hash scope when typingAnalyticsListDeviceInfos rejects', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const getSpy = vi.spyOn(window.vialAPI, 'pipetteSettingsGet').mockResolvedValue({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      analyze: {
        filters: {
          deviceScopes: [{ kind: 'hash', machineHash: 'survivinghash' }],
        },
      },
    })
    const hashSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListDeviceInfos')
      .mockRejectedValue(new Error('drive down'))
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(hashSpy).toHaveBeenCalledWith('uid-a'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    // The hash must not be demoted to 'own' by a transient failure —
    // the charts stay on the persisted selection.
    await waitFor(() => {
      expect(text('mock-wpm')).toMatch(/^uid-a:hash:survivinghash:range=/)
    })
    hashSpy.mockRestore()
    getSpy.mockRestore()
  })

  it('releases the overlay when typingAnalyticsListDeviceInfos rejects', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const hashSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListDeviceInfos')
      .mockRejectedValue(new Error('drive down'))
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(hashSpy).toHaveBeenCalledWith('uid-a'))
    // A stalled `preparing` phase would leave this text in the DOM; the
    // error branch must let the overlay disappear instead.
    await waitFor(() => expect(screen.queryByText('analyze.loading.preparing')).toBeNull())
    hashSpy.mockRestore()
  })

  it('ignores sync progress events for keyboards other than the selected one', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    let registered: ((p: { syncUnit: string; current?: number; total?: number }) => void) | null = null
    const subSpy = vi
      .spyOn(window.vialAPI, 'syncOnProgress')
      .mockImplementation((cb) => {
        registered = cb as typeof registered
        return () => { registered = null }
      })
    const syncSpy = vi
      .spyOn(window.vialAPI, 'syncAnalyticsNow')
      .mockImplementation(() => new Promise<boolean>(() => {}))
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(registered).not.toBeNull())
    // Wrong uid: filter must drop it.
    registered!({ syncUnit: 'keyboards/uid-b/devices/m1/days/2026-04-24', current: 1, total: 5 })
    // Right uid: progress reaches the overlay (rendered current/total numbers).
    registered!({ syncUnit: 'keyboards/uid-a/devices/m1/days/2026-04-24', current: 3, total: 5 })
    await waitFor(() => expect(screen.getByText('3 / 5')).toBeInTheDocument())
    syncSpy.mockRestore()
    subSpy.mockRestore()
  })

  it('renders an option per remote hash in the Device dropdown', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const hashSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListDeviceInfos')
      .mockResolvedValue({
        own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
        remotes: [
          { machineHash: 'hashone12345678901234', osPlatform: 'darwin', osRelease: '23.6' },
          { machineHash: 'hashtwo12345678901234', osPlatform: 'win32', osRelease: '10.0' },
        ],
      })
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(hashSpy).toHaveBeenCalledWith('uid-a'))
    openFilterModal()
    await screen.findByTestId('analyze-filter-device')
    // Each option renders as `analyze-filter-device-option-${key}` —
    // a missing entry would throw inside the assertion below. The
    // modal's own `useAnalyzeScopeOptions(draftUid)` fetch resolves
    // asynchronously, so wait for the remote options to land.
    await waitFor(() => {
      expect(screen.getByTestId('analyze-filter-device-option-own')).toBeInTheDocument()
      expect(screen.getByTestId('analyze-filter-device-option-all')).toBeInTheDocument()
      expect(
        screen.getByTestId('analyze-filter-device-option-hash:hashone12345678901234'),
      ).toBeInTheDocument()
      expect(
        screen.getByTestId('analyze-filter-device-option-hash:hashtwo12345678901234'),
      ).toBeInTheDocument()
    })
    hashSpy.mockRestore()
  })

  it('propagates hash scope selection into chart props', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const hashSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListDeviceInfos')
      .mockResolvedValue({
        own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
        remotes: [
          { machineHash: 'hashone12345678901234', osPlatform: 'darwin', osRelease: '23.6' },
        ],
      })
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(hashSpy).toHaveBeenCalledWith('uid-a'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))

    // Single-select <select>: changing to the hash replaces the
    // selection outright, so the chart's only scope flips to the hash.
    // Staged via the modal — nothing reaches the chart until Apply.
    openFilterModal()
    await waitFor(() => expect(
      screen.getByTestId('analyze-filter-device-option-hash:hashone12345678901234'),
    ).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('analyze-filter-device'), {
      target: { value: 'hash:hashone12345678901234' },
    })
    applyFilterModal()
    await waitFor(() => {
      expect(text('mock-wpm')).toMatch(/^uid-a:hash:hashone12345678901234:range=/)
    })

    // Switching back to `'own'` replaces the selection with the local device.
    openFilterModal()
    fireEvent.change(await screen.findByTestId('analyze-filter-device'), { target: { value: 'own' } })
    applyFilterModal()
    await waitFor(() => {
      expect(text('mock-wpm')).toMatch(/^uid-a:own:range=/)
    })
    hashSpy.mockRestore()
  })

  it('auto-closes the finger-assignment modal when the selected scope is a remote hash', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    mockGetSnapshot.mockResolvedValue(SNAPSHOT)
    const hashSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListDeviceInfos')
      .mockResolvedValue({
        own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
        remotes: [
          { machineHash: 'remote12345678901234', osPlatform: 'darwin', osRelease: '23.6' },
        ],
      })
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    // Default Summary doesn't render the snapshot-aware charts, so move
    // off Summary first to confirm the snapshot reaches Heatmap, then
    // open the modal via the Ergonomics tab button.
    await waitFor(() => expect(screen.getByTestId('mock-summary')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-keyHeatmap'))
    await waitFor(() => expect(screen.getByTestId('mock-keyheatmap')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-ergonomics'))
    const openButton = await screen.findByTestId('analyze-finger-assignment-open')
    fireEvent.click(openButton)
    await waitFor(() => expect(screen.getByTestId('finger-assignment-modal')).toBeInTheDocument())
    // Single-select: picking the remote hash replaces the scope so
    // `effectiveSnapshot` drops to null and the modal closes. Staged
    // via the filter modal, applied on Apply.
    openFilterModal()
    await waitFor(() => expect(
      screen.getByTestId('analyze-filter-device-option-hash:remote12345678901234'),
    ).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('analyze-filter-device'), {
      target: { value: 'hash:remote12345678901234' },
    })
    applyFilterModal()
    await waitFor(() => expect(screen.queryByTestId('finger-assignment-modal')).toBeNull())
    hashSpy.mockRestore()
  })

  it('falls back to own when a persisted hash is missing from the remote list', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const getSpy = vi.spyOn(window.vialAPI, 'pipetteSettingsGet').mockResolvedValue({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      analyze: {
        filters: {
          deviceScopes: [{ kind: 'hash', machineHash: 'stalehash123' }],
        },
      },
    })
    const hashSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListDeviceInfos')
      .mockResolvedValue({
        own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
        remotes: [
          { machineHash: 'otherhash456', osPlatform: 'darwin', osRelease: '23.6' },
        ],
      })
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(hashSpy).toHaveBeenCalledWith('uid-a'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    await waitFor(() => {
      expect(text('mock-wpm')).toMatch(/^uid-a:own:range=/)
    })
    hashSpy.mockRestore()
    getSpy.mockRestore()
  })

  it('fires syncAnalyticsNow for the initial keyboard on Analyze mount', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const syncSpy = vi.spyOn(window.vialAPI, 'syncAnalyticsNow').mockResolvedValue(true)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('uid-a'))
    syncSpy.mockRestore()
  })

  it('keeps the snapshot under the all-devices scope', async () => {
    // Regression: the snapshot gate used to be `isOwnScope ? snap : null`
    // which swallowed `'all'` too, even though `'all'` aggregates the
    // own device in. The mock-chart only renders when the tab picks the
    // non-null branch, so a returning testid proves the snapshot stayed.
    mockListKeyboards.mockResolvedValue(SAMPLE)
    mockGetSnapshot.mockResolvedValue(SNAPSHOT)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    // Summary is the default tab; switch to Heatmap to exercise the
    // snapshot gate this regression test was written for.
    await waitFor(() => expect(screen.getByTestId('mock-summary')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('analyze-tab-keyHeatmap'))
    await waitFor(() => expect(screen.getByTestId('mock-keyheatmap')).toBeInTheDocument())
    openFilterModal()
    fireEvent.change(await screen.findByTestId('analyze-filter-device'), { target: { value: 'all' } })
    applyFilterModal()
    await waitFor(() => expect(text('mock-keyheatmap')).toMatch(/^uid-a:all:range=/))
    fireEvent.click(screen.getByTestId('analyze-tab-ergonomics'))
    await waitFor(() => expect(screen.getByTestId('mock-ergonomics')).toBeInTheDocument())
  })

  it('fires syncAnalyticsNow again when the selected keyboard switches', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const syncSpy = vi.spyOn(window.vialAPI, 'syncAnalyticsNow').mockResolvedValue(true)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('uid-a'))
    openFilterModal()
    fireEvent.change(await screen.findByTestId('analyze-filter-keyboard'), { target: { value: 'uid-b' } })
    applyFilterModal()
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('uid-b'))
    syncSpy.mockRestore()
  })

  it('clamps the range to the snapshot active window when an older snapshot is picked in the modal', async () => {
    // Range integrity check: selecting snapshot 1000 from
    // [1000, 2000] should set toMs = 2000 (the next snapshot's
    // savedAt). Backend's selector reads `[fromMs, toMs)` so picking
    // savedAt = 1000 stays correct even though toMs touches 2000.
    // The snapshot pick lives in the modal's Keymap row now — the
    // committed range only moves on Apply.
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const summaries: TypingKeymapSnapshotSummary[] = [
      { uid: 'uid-a', machineHash: 'm1', productName: 'KB A', savedAt: 1000, layers: 1, matrix: { rows: 1, cols: 1 } },
      { uid: 'uid-a', machineHash: 'm1', productName: 'KB A', savedAt: 2000, layers: 1, matrix: { rows: 1, cols: 1 } },
    ]
    const summariesSpy = vi.spyOn(window.vialAPI, 'typingAnalyticsListKeymapSnapshots').mockResolvedValue(summaries)
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(summariesSpy).toHaveBeenCalledWith('uid-a'))
    fireEvent.click(screen.getByTestId('analyze-tab-wpm'))
    await waitFor(() => expect(screen.getByTestId('mock-wpm')).toBeInTheDocument())
    openFilterModal()
    const select = await screen.findByTestId('analyze-snapshot-timeline-select')
    fireEvent.change(select, { target: { value: '1000' } })
    // Draft-only until Apply — the chart keeps the committed range.
    expect(text('mock-wpm')).not.toContain('range=1000-2000')
    applyFilterModal()
    await waitFor(() => {
      expect(text('mock-wpm')).toContain('range=1000-2000')
    })
    summariesSpy.mockRestore()
  })

  it('omits the Keymap row for a keyboard without snapshots after a switch', async () => {
    // The previous keyboard's snapshot list must not leak into the next
    // keyboard's modal: uid-b has no snapshots, so its Keymap row is
    // absent entirely.
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const summariesSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListKeymapSnapshots')
      .mockImplementation(async (uid: string) => {
        if (uid === 'uid-a') {
          return [{ uid, machineHash: 'm1', productName: 'KB', savedAt: 1000, layers: 1, matrix: { rows: 1, cols: 1 } }] as TypingKeymapSnapshotSummary[]
        }
        return [] as TypingKeymapSnapshotSummary[]
      })
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(summariesSpy).toHaveBeenCalledWith('uid-a'))
    // uid-a has a snapshot — its modal shows the Keymap row.
    openFilterModal()
    await screen.findByTestId('analyze-snapshot-timeline-select')
    fireEvent.change(screen.getByTestId('analyze-filter-keyboard'), { target: { value: 'uid-b' } })
    applyFilterModal()
    await waitFor(() => expect(summariesSpy).toHaveBeenCalledWith('uid-b'))
    // uid-b has none — reopening the modal renders no Keymap row.
    openFilterModal()
    await screen.findByTestId('analyze-filter-device')
    expect(screen.queryByTestId('analyze-filter-modal-keymap-row')).toBeNull()
    expect(screen.queryByTestId('analyze-snapshot-timeline-select')).toBeNull()
    summariesSpy.mockRestore()
  })

  it('labels a history-less run with its date stamp in the chip Source segment', async () => {
    // Regression: a run filtered in Analyze that never recorded a
    // History entry (unnamed run with Save Unnamed off) used to render
    // as its raw runId UUID in the chip, while the modal's Results
    // dropdown showed the date — both now resolve through
    // useRunLabels.labelFor, so the chip gets the same date stamp.
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const firstMs = Date.UTC(2026, 3, 1, 9, 30)
    const getSpy = vi.spyOn(window.vialAPI, 'pipetteSettingsGet').mockResolvedValue({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      // No typingTestResults — the run has no History entry.
      analyze: {
        filters: {
          filterDimension: 'typingTest',
          typingTestScopes: ['tatoeba-japanese'],
          runIdScopes: ['acb0f4e9-0000-4000-8000-000000000000'],
        },
      },
    })
    const runsSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListTypingTestRunsForRange')
      .mockResolvedValue([{ runId: 'acb0f4e9-0000-4000-8000-000000000000', firstMs }])
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => {
      expect(text('analyze-filter-chip-source')).toContain(formatRunDateLabel(firstMs))
    })
    expect(text('analyze-filter-chip-source')).toContain('tatoeba-japanese')
    expect(text('analyze-filter-chip-source')).not.toContain('acb0f4e9')
    runsSpy.mockRestore()
    getSpy.mockRestore()
  })

  it('omits the Keymap row when listKeymapSnapshots rejects', async () => {
    mockListKeyboards.mockResolvedValue(SAMPLE)
    const summariesSpy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListKeymapSnapshots')
      .mockRejectedValue(new Error('drive down'))
    const { TypingAnalyticsView } = await importView()
    render(<TypingAnalyticsView />)
    await waitFor(() => expect(summariesSpy).toHaveBeenCalledWith('uid-a'))
    openFilterModal()
    await screen.findByTestId('analyze-filter-device')
    expect(screen.queryByTestId('analyze-filter-modal-keymap-row')).toBeNull()
    expect(screen.queryByTestId('analyze-snapshot-timeline-select')).toBeNull()
    summariesSpy.mockRestore()
  })

})
