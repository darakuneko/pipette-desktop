// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Staging-contract tests for `AnalyzeFilterModal` (Plan-analyze-filter-
// modal): the whole draft leaves via a single `onApply(draft)` call and
// nothing leaves before Apply; Esc / backdrop discard the draft; Reset
// returns the draft to `DEFAULT_ANALYZE_FILTERS`; a keyboard change
// resets the dependent scope fields; disabled rows suppress their
// controls. The parent (`AnalyzePane`) owns commit routing — covered by
// the TypingAnalyticsView suite — so these tests only assert the draft
// payload handed up.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { TypingKeyboardSummary } from '../../../../shared/types/typing-analytics'
import { AnalyzeFilterModal } from '../AnalyzeFilterModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))

const KEYBOARDS: TypingKeyboardSummary[] = [
  { uid: 'uid-a', productName: 'KB A', vendorId: 1, productId: 1 },
  { uid: 'uid-b', productName: 'KB B', vendorId: 2, productId: 2 },
]

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsListDeviceInfos: () => Promise.resolve({
      own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
      remotes: [],
    }),
    typingAnalyticsListKeymapSnapshots: () => Promise.resolve([]),
    typingAnalyticsListAppsForRange: () => Promise.resolve([]),
    typingAnalyticsListTypingTestsForRange: () => Promise.resolve([]),
    typingAnalyticsListTypingTestRunsForRange: () => Promise.resolve([]),
    pipetteSettingsGet: () => Promise.resolve(null),
  },
  writable: true,
})

type ModalProps = Parameters<typeof AnalyzeFilterModal>[0]

function baseProps(overrides: Partial<ModalProps> = {}): ModalProps {
  return {
    onClose: vi.fn(),
    keyboards: KEYBOARDS,
    keyboardsLoading: false,
    analysisTab: 'summary' as const,
    intervalViewMode: 'timeSeries' as const,
    nowMs: 1000,
    committed: {
      uid: 'uid-a',
      deviceScopes: ['own'] as const,
      filterDimension: 'app' as const,
      appScopes: [],
      typingTestScopes: [],
      runIdScopes: [],
      range: { fromMs: 0, toMs: 1000 },
      snapshotSavedAt: null,
    },
    onApply: vi.fn(),
    tid: (id: string) => id,
    ...overrides,
  }
}

describe('AnalyzeFilterModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('seeds the draft from the committed snapshot at mount', async () => {
    render(<AnalyzeFilterModal {...baseProps({
      committed: { ...baseProps().committed, deviceScopes: ['all'] },
    })} />)
    await waitFor(() => expect(screen.getByTestId('analyze-filter-device')).toHaveValue('all'))
  })

  it('does not call onApply until Apply is pressed, then hands up the whole draft once', async () => {
    const onApply = vi.fn()
    render(<AnalyzeFilterModal {...baseProps({ onApply })} />)
    fireEvent.change(await screen.findByTestId('analyze-filter-device'), { target: { value: 'all' } })
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('analyze-filter-modal-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0][0]).toMatchObject({
      uid: 'uid-a',
      filtersPatch: { deviceScopes: ['all'] },
      snapshotSavedAt: null,
    })
    expect(onApply.mock.calls[0][0].range).toEqual({ fromMs: 0, toMs: 1000 })
  })

  it('closes after Apply', () => {
    const onClose = vi.fn()
    render(<AnalyzeFilterModal {...baseProps({ onClose })} />)
    fireEvent.click(screen.getByTestId('analyze-filter-modal-apply'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('discards the draft on Escape without calling onApply', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(<AnalyzeFilterModal {...baseProps({ onApply, onClose })} />)
    fireEvent.change(await screen.findByTestId('analyze-filter-device'), { target: { value: 'all' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('discards the draft on backdrop click without calling onApply', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(<AnalyzeFilterModal {...baseProps({ onApply, onClose })} />)
    fireEvent.change(await screen.findByTestId('analyze-filter-device'), { target: { value: 'all' } })
    fireEvent.click(screen.getByTestId('analyze-filter-modal'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('Reset returns the draft to DEFAULT_ANALYZE_FILTERS before Apply commits it', async () => {
    const onApply = vi.fn()
    render(<AnalyzeFilterModal {...baseProps({
      onApply,
      committed: { ...baseProps().committed, deviceScopes: ['all'], appScopes: ['editor'] },
    })} />)
    fireEvent.change(await screen.findByTestId('analyze-filter-device'), { target: { value: 'own' } })
    fireEvent.click(screen.getByTestId('analyze-filter-modal-reset'))
    fireEvent.click(screen.getByTestId('analyze-filter-modal-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0][0].filtersPatch).toMatchObject({
      deviceScopes: ['own'],
      filterDimension: 'app',
      appScopes: [],
      typingTestScopes: [],
      runIdScopes: [],
    })
  })

  it('resets dependent scope fields when the draft keyboard changes and reports the new uid', async () => {
    const onApply = vi.fn()
    render(<AnalyzeFilterModal {...baseProps({
      onApply,
      committed: { ...baseProps().committed, deviceScopes: ['all'] },
    })} />)
    fireEvent.change(await screen.findByTestId('analyze-filter-keyboard'), { target: { value: 'uid-b' } })
    fireEvent.click(screen.getByTestId('analyze-filter-modal-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0][0]).toMatchObject({
      uid: 'uid-b',
      filtersPatch: { deviceScopes: ['own'] },
    })
  })

  it('disables the Source row on the By App tab with an explanatory note', () => {
    render(<AnalyzeFilterModal {...baseProps({ analysisTab: 'byApp' })} />)
    expect(screen.getByTestId('analyze-filter-source-disabled-note')).toBeInTheDocument()
    expect(screen.queryByTestId('analyze-filter-dimension')).toBeNull()
  })

  it('disables only Device while Interval Distribution forces own-device (Source stays editable)', () => {
    // Distribution forces the device scope to 'own' but IntervalChart
    // still applies App/TypingTest/Run scopes to its query — so the
    // Source row must remain an editable control.
    render(<AnalyzeFilterModal {...baseProps({ analysisTab: 'interval', intervalViewMode: 'distribution' })} />)
    expect(screen.getByTestId('analyze-filter-device-disabled-note')).toBeInTheDocument()
    expect(screen.queryByTestId('analyze-filter-device')).toBeNull()
    expect(screen.queryByTestId('analyze-filter-source-disabled-note')).toBeNull()
    expect(screen.getByTestId('analyze-filter-dimension')).toBeInTheDocument()
  })

  it('renders the Keymap row via KeymapSnapshotTimeline once snapshots resolve', async () => {
    const summaries = [
      { uid: 'uid-a', machineHash: 'm1', productName: 'KB A', savedAt: 500, layers: 1, matrix: { rows: 1, cols: 1 } },
    ]
    const spy = vi
      .spyOn(window.vialAPI, 'typingAnalyticsListKeymapSnapshots')
      .mockResolvedValue(summaries)
    render(<AnalyzeFilterModal {...baseProps({
      committed: { ...baseProps().committed, snapshotSavedAt: 500 },
    })} />)
    await waitFor(() => expect(screen.getByTestId('analyze-snapshot-timeline-select')).toBeInTheDocument())
    expect(screen.getByTestId('analyze-snapshot-timeline-select')).toHaveValue('500')
    spy.mockRestore()
  })
})
