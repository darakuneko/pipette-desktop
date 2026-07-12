// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KeyHeatmapChart } from '../KeyHeatmapChart'
import { DEFAULT_ANALYZE_FILTERS } from '../../../hooks/useAnalyzeFilters'
import type { HeatmapFilters } from '../../../../shared/types/analyze-filters'
import type {
  TypingBigramAggregateResult,
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
const bigramAggregateSpy = vi.fn<(...args: unknown[]) => Promise<TypingBigramAggregateResult>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetMatrixHeatmapForRange: (...args: unknown[]) => matrixHeatmapSpy(...args),
    typingAnalyticsGetBigramAggregateForRange: (...args: unknown[]) => bigramAggregateSpy(...args),
  },
  writable: true,
})

const range = { fromMs: 0, toMs: 60_000 }

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

/** Controlled wrapper mirroring how `AnalyzePane` drives `KeyHeatmapChart`
 * — filter state lives in the parent, patches flow back through
 * `onHeatmapChange`. Exposes the last patch via `onPatch` for assertions.
 * `appScopes` is forwarded so the fetch-cache tests can vary the filter
 * axes across rerenders. */
function Harness({ onPatch, appScopes = [] }: {
  onPatch?: (patch: Partial<HeatmapFilters>) => void
  appScopes?: string[]
}): JSX.Element {
  const [heatmap, setHeatmap] = useState(DEFAULT_ANALYZE_FILTERS.heatmap)
  return (
    <KeyHeatmapChart
      uid="0xAABB"
      range={range}
      deviceScope="own"
      appScopes={appScopes}
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
  bigramAggregateSpy.mockReset()
  matrixHeatmapSpy.mockResolvedValue({})
  bigramAggregateSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
})

describe('KeyHeatmapChart', () => {
  it('renders Count mode by default with the count ranking table', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('analyze-keyheatmap-speed-ranking')).not.toBeInTheDocument()
    expect(screen.getByTestId('analyze-keyheatmap-mode-toggle-count')).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches to Speed mode, fetches the bigram aggregate, and swaps the ranking table', async () => {
    const onPatch = vi.fn()
    render(<Harness onPatch={onPatch} />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))

    expect(onPatch).toHaveBeenCalledWith({ mode: 'speed' })
    await waitFor(() => {
      expect(bigramAggregateSpy).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-speed-ranking')).toBeInTheDocument()
    })
    // Count-only controls disappear in Speed mode.
    expect(screen.queryByTestId('analyze-keyheatmap-normalization')).not.toBeInTheDocument()
    expect(screen.queryByTestId('analyze-keyheatmap-aggregate')).not.toBeInTheDocument()
    // Group and Top N stay available in both modes.
    expect(screen.getByTestId('analyze-keyheatmap-keygroup')).toBeInTheDocument()
    expect(screen.getByTestId('analyze-keyheatmap-frequent-used-n')).toBeInTheDocument()
  })

  it('shows the Speed empty state when no bigram pair clears the sample threshold', async () => {
    bigramAggregateSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-speed-empty')).toBeInTheDocument()
    })
  })

  it('paints a Speed ranking row once a qualifying bigram pair is fetched', async () => {
    bigramAggregateSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_5', count: 10, hist: [0, 10, 0, 0, 0, 0, 0, 0], avgIki: 80, sd: null },
      ],
      truncated: false,
    })
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(screen.queryByTestId('analyze-keyheatmap-speed-empty')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('analyze-keyheatmap-speed-ranking').textContent).toContain('B')
  })

  it('does not refetch matrix cells when returning to Count mode with unchanged filters', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    expect(matrixHeatmapSpy).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-speed-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-count'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    // Filters never changed while parked in Speed mode, so the cached
    // Count-mode matrix data is reused instead of re-fetched.
    expect(matrixHeatmapSpy).toHaveBeenCalledTimes(1)
  })

  it('does not refetch the bigram aggregate when re-entering Speed mode with unchanged filters', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(bigramAggregateSpy).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-count'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-speed-ranking')).toBeInTheDocument()
    })
    expect(bigramAggregateSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches when a filter change only differs by array boundaries', async () => {
    // ['a','b'] and ['a|b'] must not share a fetch-cache key — a
    // delimiter-joined key would collide and wrongly reuse stale data.
    const { rerender } = render(<Harness appScopes={['a', 'b']} />)
    await waitFor(() => {
      expect(matrixHeatmapSpy).toHaveBeenCalledTimes(1)
    })
    rerender(<Harness appScopes={['a|b']} />)
    await waitFor(() => {
      expect(matrixHeatmapSpy).toHaveBeenCalledTimes(2)
    })
  })

  it('retries the matrix fetch after a failure instead of caching the empty fallback', async () => {
    matrixHeatmapSpy.mockRejectedValueOnce(new Error('ipc down'))
    render(<Harness />)
    await waitFor(() => {
      expect(matrixHeatmapSpy).toHaveBeenCalledTimes(1)
    })
    // Bounce through Speed and back — with the failure cached this
    // would reuse the empty fallback; instead the null-ed fetch key
    // forces a retry.
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-speed-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-count'))
    await waitFor(() => {
      expect(matrixHeatmapSpy).toHaveBeenCalledTimes(2)
    })
  })

  it('does not serve a failed fetch\'s empty fallback under a previously successful key', async () => {
    // The dangerous shape: a success caches key A, a later fetch for
    // key B fails (overwriting the entries with the empty fallback),
    // then the axes revert to A. Without null-ing the key on failure,
    // A still matches and the emptied data would be served as A's.
    const { rerender } = render(<Harness appScopes={['a']} />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    // 1. Speed under axes A — succeeds, caches key A.
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(bigramAggregateSpy).toHaveBeenCalledTimes(1)
    })
    // 2. Axes change to B while in Speed — this fetch fails.
    bigramAggregateSpy.mockRejectedValueOnce(new Error('ipc down'))
    rerender(<Harness appScopes={['b']} />)
    await waitFor(() => {
      expect(bigramAggregateSpy).toHaveBeenCalledTimes(2)
    })
    // 3. Axes revert to A — the failure invalidated the cache, so a
    // fresh fetch runs instead of serving step 2's empty fallback.
    rerender(<Harness appScopes={['a']} />)
    await waitFor(() => {
      expect(bigramAggregateSpy).toHaveBeenCalledTimes(3)
    })
  })

  it('shows the Speed capped notice when the bigram aggregate reports truncated', async () => {
    bigramAggregateSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_5', count: 10, hist: [0, 10, 0, 0, 0, 0, 0, 0], avgIki: 80, sd: null },
      ],
      truncated: true,
    })
    render(<Harness />)
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-ranking')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('analyze-keyheatmap-mode-toggle-speed'))
    await waitFor(() => {
      expect(screen.getByTestId('analyze-keyheatmap-speed-capped-notice')).toBeInTheDocument()
    })
  })

  it('shows the no-layout empty state regardless of mode', async () => {
    const snapshotNoLayout: TypingKeymapSnapshot = { ...buildSnapshot(), layout: null }
    render(
      <KeyHeatmapChart
        uid="0xAABB"
        range={range}
        deviceScope="own"
        appScopes={[]}
        typingTestScopes={[]}
        runIdScopes={[]}
        snapshot={snapshotNoLayout}
        heatmap={DEFAULT_ANALYZE_FILTERS.heatmap}
        onHeatmapChange={() => {}}
      />,
    )
    expect(await screen.findByTestId('analyze-keyheatmap-nolayout')).toBeInTheDocument()
  })
})
