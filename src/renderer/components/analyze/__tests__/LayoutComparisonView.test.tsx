// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { LayoutComparisonView } from '../LayoutComparisonView'
import type {
  LayoutComparisonResult,
  TypingKeymapSnapshot,
} from '../../../../shared/types/typing-analytics'
import type { LayoutComparisonFilters } from '../../../../shared/types/analyze-filters'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key
      const params = Object.entries(vars)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')
      return `${key} (${params})`
    },
    i18n: { language: 'en' },
  }),
}))

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<LayoutComparisonResult | null>>()

// useKeyLabelLookup pulls non-built-in maps via these IPC stubs. The
// minimal `colemak` payload is enough for the comparison fetch to fire.
Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetLayoutComparisonForRange: (...args: unknown[]) => fetchSpy(...args),
    keyLabelStoreList: async () => ({ success: true, data: [] }),
    keyLabelStoreGet: async (id: string) => ({
      success: true,
      data: {
        meta: { id, name: id, filename: '', savedAt: '', updatedAt: '' },
        data: { name: id, map: {} as Record<string, string> },
      },
    }),
  },
  writable: true,
})

const DEFAULT_FILTER: Required<LayoutComparisonFilters> = {
  sourceLayoutId: 'qwerty',
  targetLayoutId: null,
}

const range = { fromMs: 0, toMs: 60_000 }

function makeSnapshot(): TypingKeymapSnapshot {
  return {
    uid: 'uid-test',
    machineHash: 'hash-test',
    productName: 'Test',
    savedAt: 0,
    layers: 1,
    matrix: { rows: 1, cols: 1 },
    keymap: [[['KC_A']]],
    layout: { keys: [] },
  }
}

function renderView(overrides: {
  filter?: Partial<Required<LayoutComparisonFilters>>
  snapshot?: TypingKeymapSnapshot | null
  onSkipPercentChange?: (percent: number | null) => void
} = {}): void {
  const { filter, snapshot = makeSnapshot(), onSkipPercentChange } = overrides
  render(
    <LayoutComparisonView
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      snapshot={snapshot}
      filter={{ ...DEFAULT_FILTER, ...filter }}
      onSkipPercentChange={onSkipPercentChange}
    />,
  )
}

function makeResult(overrides: Partial<LayoutComparisonResult> = {}): LayoutComparisonResult {
  return {
    sourceLayoutId: 'qwerty',
    targets: [
      {
        layoutId: 'qwerty',
        totalEvents: 100,
        skippedEvents: 0,
        skipRate: 0,
        fingerLoad: { 'left-index': 0.5, 'right-index': 0.5 },
        handBalance: { left: 0.5, right: 0.5 },
        rowDist: { home: 1 },
        homeRowStay: 1,
      },
      {
        layoutId: 'colemak',
        totalEvents: 100,
        skippedEvents: 0,
        skipRate: 0,
        fingerLoad: { 'left-index': 0.6, 'right-index': 0.4 },
        handBalance: { left: 0.6, right: 0.4 },
        rowDist: { home: 0.9, top: 0.1 },
        homeRowStay: 0.9,
      },
    ],
    ...overrides,
  }
}

describe('LayoutComparisonView', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('shows the no-snapshot empty state when snapshot is null', () => {
    renderView({ snapshot: null })
    expect(screen.getByTestId('analyze-layout-comparison-no-snapshot')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows the no-target empty state until a target is picked', () => {
    renderView()
    expect(screen.getByTestId('analyze-layout-comparison-no-target')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches once when a target is picked and renders the metric table', async () => {
    fetchSpy.mockResolvedValue(makeResult())
    renderView({ filter: { targetLayoutId: 'colemak' } })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-layout-comparison-metric-table')).toBeTruthy()
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('emits the max skip rate via onSkipPercentChange when a result loads', async () => {
    fetchSpy.mockResolvedValue(
      makeResult({
        targets: [
          { ...makeResult().targets[0], skipRate: 0 },
          { ...makeResult().targets[1], skipRate: 0.12, skippedEvents: 12 },
        ],
      }),
    )
    const onSkipPercentChange = vi.fn()
    renderView({ filter: { targetLayoutId: 'colemak' }, onSkipPercentChange })
    await waitFor(() => {
      expect(onSkipPercentChange).toHaveBeenCalledWith(0.12)
    })
    // The legacy inline banner is no longer rendered — the page footer
    // owns the warning now (see TypingAnalyticsView).
    expect(screen.queryByTestId('analyze-layout-comparison-skip-warning')).toBeNull()
  })

  it('renders all three panels (heatmap / finger / metric) at once', async () => {
    fetchSpy.mockResolvedValue(makeResult())
    renderView({ filter: { targetLayoutId: 'colemak' } })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-layout-comparison-heatmap-diff')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-layout-comparison-finger-diff')).toBeTruthy()
    expect(screen.getByTestId('analyze-layout-comparison-metric-table')).toBeTruthy()
  })
})
