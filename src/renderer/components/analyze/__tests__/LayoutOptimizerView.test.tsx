// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { LayoutOptimizerView } from '../LayoutOptimizerView'
import type {
  LayoutOptimizerResult,
  TypingKeymapSnapshot,
} from '../../../../shared/types/typing-analytics'
import type { LayoutOptimizerFilters } from '../../../../shared/types/analyze-filters'

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

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<LayoutOptimizerResult | null>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetLayoutOptimizerForRange: (...args: unknown[]) => fetchSpy(...args),
  },
  writable: true,
})

const DEFAULT_FILTER: Required<LayoutOptimizerFilters> = {
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
  filter?: Partial<Required<LayoutOptimizerFilters>>
  snapshot?: TypingKeymapSnapshot | null
  onFilterChange?: (patch: Partial<LayoutOptimizerFilters>) => void
} = {}): void {
  const { filter, snapshot = makeSnapshot(), onFilterChange } = overrides
  render(
    <LayoutOptimizerView
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      snapshot={snapshot}
      filter={{ ...DEFAULT_FILTER, ...filter }}
      onFilterChange={onFilterChange ?? (() => {})}
    />,
  )
}

function makeResult(overrides: Partial<LayoutOptimizerResult> = {}): LayoutOptimizerResult {
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

describe('LayoutOptimizerView', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('shows the no-snapshot empty state when snapshot is null', () => {
    renderView({ snapshot: null })
    expect(screen.getByTestId('analyze-layout-optimizer-no-snapshot')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows the no-target empty state until a target is picked', () => {
    renderView()
    expect(screen.getByTestId('analyze-layout-optimizer-no-target')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches once when a target is picked and renders the metric table', async () => {
    fetchSpy.mockResolvedValue(makeResult())
    renderView({ filter: { targetLayoutId: 'colemak' } })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-layout-optimizer-metric-table')).toBeTruthy()
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('routes target dropdown changes through onFilterChange', () => {
    const onFilterChange = vi.fn()
    renderView({ onFilterChange })
    const targetSelect = screen.getByTestId('analyze-layout-optimizer-target-select') as HTMLSelectElement
    act(() => {
      fireEvent.change(targetSelect, { target: { value: 'colemak' } })
    })
    expect(onFilterChange).toHaveBeenCalledWith({ targetLayoutId: 'colemak' })
  })

  it('shows the skip warning banner when any target exceeds 5%', async () => {
    fetchSpy.mockResolvedValue(
      makeResult({
        targets: [
          { ...makeResult().targets[0], skipRate: 0 },
          { ...makeResult().targets[1], skipRate: 0.12, skippedEvents: 12 },
        ],
      }),
    )
    renderView({ filter: { targetLayoutId: 'colemak' } })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-layout-optimizer-skip-warning')).toBeTruthy()
    })
  })

  it('renders all three panels (heatmap / finger / metric) at once', async () => {
    fetchSpy.mockResolvedValue(makeResult())
    renderView({ filter: { targetLayoutId: 'colemak' } })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-layout-optimizer-heatmap-diff')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-layout-optimizer-finger-diff')).toBeTruthy()
    expect(screen.getByTestId('analyze-layout-optimizer-metric-table')).toBeTruthy()
  })
})
