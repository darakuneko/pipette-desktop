// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for KeyHeatmapChart's third mode (Duration): mode toggle,
// single non-per-layer fetch, min-sample gate, ranking table, and fill
// presence. Mirrors the Speed-mode coverage in KeyHeatmapChart.test.tsx.

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KeyHeatmapChart } from '../KeyHeatmapChart'
import { DEFAULT_ANALYZE_FILTERS } from '../../../hooks/useAnalyzeFilters'
import { MIN_DURATION_SAMPLE_COUNT } from '../key-heatmap-helpers'
import type { HeatmapFilters } from '../../../../shared/types/analyze-filters'
import type {
  TypingDurationCell,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
} from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}))

const matrixHeatmapSpy = vi.fn<(...args: unknown[]) => Promise<TypingHeatmapByCell>>()
const durationCellsSpy = vi.fn<(...args: unknown[]) => Promise<TypingDurationCell[]>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetMatrixHeatmapForRange: (...args: unknown[]) => matrixHeatmapSpy(...args),
    typingAnalyticsListDurationCells: (...args: unknown[]) => durationCellsSpy(...args),
  },
  writable: true,
})

const range = { fromMs: 0, toMs: 60_000 }

function durationCell(overrides: Partial<TypingDurationCell> = {}): TypingDurationCell {
  return {
    row: 0,
    col: 0,
    layer: 0,
    durationSamples: 0,
    hist: [0, 0, 0, 0, 0, 0, 0, 0],
    sum: 0,
    sumSq: 0,
    ...overrides,
  }
}

function buildSnapshot(): TypingKeymapSnapshot {
  return {
    uid: '0xAABB',
    machineHash: 'hash',
    productName: 'Test',
    savedAt: 0,
    layers: 1,
    matrix: { rows: 1, cols: 2 },
    keymap: [[['KC_A', 'KC_B']]],
    layout: {
      keys: [
        {
          x: 0, y: 0, width: 1, height: 1, x2: 0, y2: 0, width2: 1, height2: 1,
          rotation: 0, rotationX: 0, rotationY: 0, color: '', labels: [], textColor: [], textSize: [],
          row: 0, col: 0, encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
          decal: false, nub: false, stepped: false, ghost: false,
        },
        {
          x: 1, y: 0, width: 1, height: 1, x2: 0, y2: 0, width2: 1, height2: 1,
          rotation: 0, rotationX: 0, rotationY: 0, color: '', labels: [], textColor: [], textSize: [],
          row: 0, col: 1, encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
          decal: false, nub: false, stepped: false, ghost: false,
        },
      ],
    },
  }
}

function Harness({ onPatch }: { onPatch?: (patch: Partial<HeatmapFilters>) => void }): JSX.Element {
  const [heatmap, setHeatmap] = useState(DEFAULT_ANALYZE_FILTERS.heatmap)
  return (
    <KeyHeatmapChart
      uid="0xAABB"
      range={range}
      deviceScope="own"
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      snapshot={buildSnapshot()}
      heatmap={heatmap}
      onHeatmapChange={(patch) => {
        setHeatmap((prev) => ({ ...prev, ...patch }))
        onPatch?.(patch)
      }}
    />
  )
}

beforeEach(() => {
  matrixHeatmapSpy.mockReset()
  durationCellsSpy.mockReset()
  matrixHeatmapSpy.mockResolvedValue({})
  durationCellsSpy.mockResolvedValue([])
})

describe('KeyHeatmapChart — Duration mode', () => {
  it('switches to Duration mode, fetches the duration cells once, and swaps the ranking table', async () => {
    const onPatch = vi.fn()
    render(<Harness onPatch={onPatch} />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))

    expect(onPatch).toHaveBeenCalledWith({ mode: 'duration' })
    await waitFor(() => {
      expect(durationCellsSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-duration-ranking')).toBeInTheDocument()
    })
    // Count-only controls disappear in Duration mode, same as Speed.
    expect(screen.queryByTestId('analyze-keyheatmap-normalization')).not.toBeInTheDocument()
  })

  it('shows the Duration empty state when no cell clears the sample threshold', async () => {
    durationCellsSpy.mockResolvedValue([
      durationCell({ durationSamples: MIN_DURATION_SAMPLE_COUNT - 1, sum: 100 }),
    ])
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-duration-empty')).toBeInTheDocument()
    })
  })

  it('paints a Duration ranking row once a qualifying cell is fetched', async () => {
    durationCellsSpy.mockResolvedValue([
      durationCell({ row: 0, col: 1, durationSamples: 10, sum: 1_000, sumSq: 100_000 }),
    ])
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))
    await waitFor(() => {
      expect(screen.queryByTestId('analyze-keyheatmap-duration-empty')).not.toBeInTheDocument()
    })
    // row 0, col 1 -> keycode KC_B on the fixture snapshot.
    expect(screen.getByTestId('analyze-keyheatmap-duration-ranking').textContent).toContain('B')
  })

  it('does not refetch matrix cells when returning to Count mode with unchanged filters', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    expect(matrixHeatmapSpy).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-duration-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-count'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    expect(matrixHeatmapSpy).toHaveBeenCalledTimes(1)
  })

  it('does not refetch duration cells when re-entering Duration mode with unchanged filters', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))
    await waitFor(() => {
      expect(durationCellsSpy).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-count'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-duration-ranking')).toBeInTheDocument()
    })
    expect(durationCellsSpy).toHaveBeenCalledTimes(1)
  })

  it('shows the Duration min-sample note with the shared threshold', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-duration'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-duration-min-sample-note')).toBeInTheDocument()
    })
    expect(screen.getByTestId('analyze-keyheatmap-duration-min-sample-note').textContent)
      .toContain(String(MIN_DURATION_SAMPLE_COUNT))
  })
})
