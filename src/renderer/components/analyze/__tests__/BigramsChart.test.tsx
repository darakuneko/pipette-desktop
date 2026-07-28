// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { BigramsChart } from '../BigramsChart'
import { ALL_PAIRS_LIMIT } from '../analyze-constants'
import { deserialize } from '../../../../shared/keycodes/keycodes'
import { parseKle } from '../../../../shared/kle/kle-parser'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramAggregateResult,
  TypingBigramTopEntry,
  TypingKeymapSnapshot,
} from '../../../../shared/types/typing-analytics'

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

/** Builds `count` distinct entries without hand-writing each fixture.
 * `hist` mirrors the shape used elsewhere in this file (one bucket
 * populated) so `avgIkiAtOrAboveThreshold` resolves a real value. The
 * capped-notice tests drive the notice off the mocked `truncated` flag
 * directly, so `count` only needs to be a few rows, not
 * `ALL_PAIRS_LIMIT`. */
function buildEntries(count: number): TypingBigramTopEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    ngramId: `${i}_${i + 1}`,
    count: count - i,
    hist: [0, 0, 1, 0, 0, 0, 0, 0],
    avgIki: 125,
    sd: 10,
  }))
}

function renderChart(overrides: Partial<Parameters<typeof BigramsChart>[0]> = {}): void {
  render(
    <BigramsChart
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      topLimit={10}
      slowLimit={10}
      fingerLimit={10}
      pairIntervalThresholdMs={0}
      gram={2}
      onTopLimitChange={noop}
      onSlowLimitChange={noop}
      onFingerLimitChange={noop}
      onPairIntervalThresholdChange={noop}
      onGramChange={noop}
      snapshot={null}
      {...overrides}
    />,
  )
}

describe('BigramsChart', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('renders the empty state when the IPC returns no entries', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-empty')).toBeTruthy()
    })
  })

  it('fires a single fetch with view=top and a high limit', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
    renderChart()
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
    const call = fetchSpy.mock.calls[0]
    expect(call?.[3]).toBe('top')
    const options = call?.[5] as { limit?: number } | undefined
    expect(options?.limit).toBe(ALL_PAIRS_LIMIT)
  })

  it('renders all three quadrants with their own limit selects', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11', count: 10, hist: [1, 2, 3, 1, 1, 1, 1, 0], avgIki: 100, sd: 25 },
      ],
      truncated: false,
    })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByText('analyze.bigrams.quadrant.top')).toBeTruthy()
    expect(screen.getByText('analyze.bigrams.quadrant.slow')).toBeTruthy()
    expect(screen.getByText('analyze.bigrams.quadrant.fingerIki')).toBeTruthy()
    expect(screen.queryByText('analyze.bigrams.quadrant.heatmap')).toBeNull()
    expect(screen.getByTestId('analyze-bigrams-top-limit-select')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-slow-limit-select')).toBeTruthy()
  })

  it('fires onTopLimitChange when the Top limit select changes', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11', count: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 0 },
      ],
      truncated: false,
    })
    const onTopLimitChange = vi.fn()
    renderChart({ onTopLimitChange })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-top-limit-select')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('analyze-bigrams-top-limit-select'), {
      target: { value: '20' },
    })
    expect(onTopLimitChange).toHaveBeenCalledWith(20)
  })

  it('fires onSlowLimitChange when the Slow limit select changes', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11', count: 5, hist: [0, 0, 5, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 },
      ],
      truncated: false,
    })
    const onSlowLimitChange = vi.fn()
    renderChart({ onSlowLimitChange })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-limit-select')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('analyze-bigrams-slow-limit-select'), {
      target: { value: '30' },
    })
    expect(onSlowLimitChange).toHaveBeenCalledWith(30)
  })

  it('renders the error state when the IPC rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchSpy.mockRejectedValue(new Error('boom'))
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-error')).toBeTruthy()
    })
    consoleSpy.mockRestore()
  })

  // Bucket centers: [30, 80, 125, 175, 250, 400, 750, 1500]. The two
  // entries below land at avgIki = 30 ms (fast) and avgIki = 400 ms
  // (slow), so any threshold in (30, 400] hides the fast one without
  // touching the slow one.
  const thresholdEntries = [
    { ngramId: '4_11', count: 3, hist: [3, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 4 },
    { ngramId: '7_22', count: 5, hist: [0, 0, 0, 0, 0, 5, 0, 0], avgIki: 400, sd: 40 },
  ]

  it('renders both rows in the Slow ranking when the threshold is 0', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    renderChart({ pairIntervalThresholdMs: 0, slowLimit: 10 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-ranking')).toBeTruthy()
    })
    const rows = screen.getByTestId('analyze-bigrams-slow-ranking').querySelectorAll('tbody tr')
    expect(rows.length).toBe(2)
  })

  it('hides Slow ranking rows whose avgIki is below the threshold', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    renderChart({ pairIntervalThresholdMs: 200, slowLimit: 10 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-ranking')).toBeTruthy()
    })
    const rows = screen.getByTestId('analyze-bigrams-slow-ranking').querySelectorAll('tbody tr')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('400 ms')
  })

  it('shows the empty state when the threshold filters every row out', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    renderChart({ pairIntervalThresholdMs: 1000, slowLimit: 10 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-bigrams-slow-ranking')).toBeNull()
  })

  it('commits an empty threshold input as 0', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    const onPairIntervalThresholdChange = vi.fn()
    renderChart({
      pairIntervalThresholdMs: 200,
      onPairIntervalThresholdChange,
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
    })
    const input = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onPairIntervalThresholdChange).toHaveBeenCalledWith(0)
  })

  it('commits the threshold input on blur with the parsed integer', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    const onPairIntervalThresholdChange = vi.fn()
    renderChart({
      pairIntervalThresholdMs: 0,
      onPairIntervalThresholdChange,
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
    })
    const input = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.blur(input)
    expect(onPairIntervalThresholdChange).toHaveBeenCalledWith(150)
  })

  it('renders the threshold input in both fingerIki and slow quadrants', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-bigrams-finger-threshold-input')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
  })

  it('commits the threshold input on Enter without losing focus first', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    const onPairIntervalThresholdChange = vi.fn()
    renderChart({
      pairIntervalThresholdMs: 0,
      onPairIntervalThresholdChange,
    })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-slow-threshold-input')).toBeTruthy()
    })
    const input = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '300' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPairIntervalThresholdChange).toHaveBeenCalledWith(300)
  })

  it('mirrors a committed threshold to the sibling quadrant input', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: thresholdEntries, truncated: false })
    const { rerender } = render(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        appScopes={[]}
        typingTestScopes={[]}
        runIdScopes={[]}
        topLimit={10}
        slowLimit={10}
        fingerLimit={10}
        pairIntervalThresholdMs={0}
        gram={2}
        onTopLimitChange={noop}
        onSlowLimitChange={noop}
        onFingerLimitChange={noop}
        onPairIntervalThresholdChange={noop}
        onGramChange={noop}
        snapshot={null}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-finger-threshold-input')).toBeTruthy()
    })
    // Simulate the parent persisting a new value (e.g. the slow input
    // committed) — the fingerIki input must pick up the new value.
    rerender(
      <BigramsChart
        uid="0xAABB"
        range={range}
        deviceScopes={['own']}
        appScopes={[]}
        typingTestScopes={[]}
        runIdScopes={[]}
        topLimit={10}
        slowLimit={10}
        fingerLimit={10}
        pairIntervalThresholdMs={250}
        gram={2}
        onTopLimitChange={noop}
        onSlowLimitChange={noop}
        onFingerLimitChange={noop}
        onPairIntervalThresholdChange={noop}
        onGramChange={noop}
        snapshot={null}
      />,
    )
    const fingerInput = screen.getByTestId('analyze-bigrams-finger-threshold-input') as HTMLInputElement
    const slowInput = screen.getByTestId('analyze-bigrams-slow-threshold-input') as HTMLInputElement
    expect(fingerInput.value).toBe('250')
    expect(slowInput.value).toBe('250')
  })

  it('fires onGramChange when the 3-gram toggle button is clicked', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
    const onGramChange = vi.fn()
    renderChart({ onGramChange })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-gram-toggle-3')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('analyze-bigrams-gram-toggle-3'))
    expect(onGramChange).toHaveBeenCalledWith(3)
  })

  it('passes gram through to the fetch options', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
    renderChart({ gram: 3 })
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
    const options = fetchSpy.mock.calls[0]?.[5] as { gram?: number } | undefined
    expect(options?.gram).toBe(3)
  })

  it('re-fetches when gram changes', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: [], truncated: false })
    const { rerender } = render(<BigramsChartHarness gram={2} />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    rerender(<BigramsChartHarness gram={3} />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(fetchSpy.mock.calls[1]?.[5]).toMatchObject({ gram: 3 })
  })

  it('hides the Finger IKI quadrant and switches to a single-row grid for trigrams', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11_42', count: 10, hist: [1, 2, 3, 1, 1, 1, 1, 0], avgIki: 100, sd: 25 },
      ],
      truncated: false,
    })
    renderChart({ gram: 3 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByText('analyze.bigrams.quadrant.top')).toBeTruthy()
    expect(screen.getByText('analyze.bigrams.quadrant.slow')).toBeTruthy()
    expect(screen.queryByText('analyze.bigrams.quadrant.fingerIki')).toBeNull()
    expect(screen.getByTestId('analyze-bigrams-content').className).toContain('grid-rows-1')
  })

  it('shows the Finger IKI quadrant for bigrams', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11', count: 10, hist: [1, 2, 3, 1, 1, 1, 1, 0], avgIki: 100, sd: 25 },
      ],
      truncated: false,
    })
    renderChart({ gram: 2 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByText('analyze.bigrams.quadrant.fingerIki')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-content').className).toContain('grid-rows-2')
  })

  it('renders the SD column with a value and falls back to "—" for null', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11', count: 10, hist: [1, 2, 3, 1, 1, 1, 1, 0], avgIki: 100, sd: 25 },
        { ngramId: '7_22', count: 5, hist: [0, 0, 0, 0, 0, 5, 0, 0], avgIki: 400, sd: null },
      ],
      truncated: false,
    })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-top-ranking')).toBeTruthy()
    })
    const topTable = screen.getByTestId('analyze-bigrams-top-ranking')
    expect(topTable.textContent).toContain('25 ms')
    // The row with sd === null renders the "—" fallback rather than a
    // stray "null ms" or crashing.
    const cells = Array.from(topTable.querySelectorAll('td')).map((td) => td.textContent)
    expect(cells).toContain('—')
  })

  it('sorts the Top ranking by SD when the SD header is clicked', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: '4_11', count: 10, hist: [1, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 5 },
        { ngramId: '7_22', count: 5, hist: [0, 0, 0, 0, 0, 5, 0, 0], avgIki: 400, sd: 40 },
      ],
      truncated: false,
    })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-top-ranking')).toBeTruthy()
    })
    const topTable = screen.getByTestId('analyze-bigrams-top-ranking')
    const sdHeader = within(topTable).getByText('analyze.bigrams.column.sd')
    fireEvent.click(sdHeader)
    // Default click direction is descending — highest SD (40) first.
    let rows = topTable.querySelectorAll('tbody tr')
    expect(rows[0]?.textContent).toContain('40 ms')
    fireEvent.click(sdHeader)
    rows = topTable.querySelectorAll('tbody tr')
    expect(rows[0]?.textContent).toContain('5 ms')
  })

  it('shows the capped notice in Pair interval and Finger IKI when the server reports truncated', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: buildEntries(3), truncated: true })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-bigrams-slow-capped-notice')).toBeTruthy()
    expect(screen.getByTestId('analyze-bigrams-finger-capped-notice')).toBeTruthy()
  })

  it('hides the capped notice when the server reports truncated: false', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: buildEntries(3), truncated: false })
    renderChart()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-bigrams-slow-capped-notice')).toBeNull()
    expect(screen.queryByTestId('analyze-bigrams-finger-capped-notice')).toBeNull()
  })

  it('shows the capped notice in Slow but never renders it for Finger IKI when gram is 3', async () => {
    fetchSpy.mockResolvedValue({ view: 'top', entries: buildEntries(3), truncated: true })
    renderChart({ gram: 3 })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-bigrams-slow-capped-notice')).toBeTruthy()
    expect(screen.queryByTestId('analyze-bigrams-finger-capped-notice')).toBeNull()
    expect(screen.queryByText('analyze.bigrams.quadrant.fingerIki')).toBeNull()
  })

  describe('classes quadrant (alternation benefit)', () => {
    // Two single-key positions, "0,0" and "0,1", each explicitly
    // overridden to a finger so the test doesn't depend on the
    // geometry estimator. keyA/keyB resolve under whatever protocol
    // is active when the suite runs, matching how the component itself
    // resolves keycodes via `snapshot.vialProtocol`.
    const layout = parseKle([['0,0', '0,1']])
    const keyA = deserialize('KC_A')
    const keyB = deserialize('KC_B')

    function buildSnapshot(): TypingKeymapSnapshot {
      return {
        uid: '0x00',
        machineHash: 'h',
        productName: 'Test',
        savedAt: 0,
        layers: 1,
        matrix: { rows: 1, cols: 2 },
        keymap: [[['KC_A', 'KC_B']]],
        layout,
      }
    }

    const alternationOverrides: Record<string, FingerType> = {
      '0,0': 'left-index',
      '0,1': 'right-index',
    }
    // Two different keys sharing one finger — a same-finger bigram
    // (SFB), not a letter repeat, so it classifies as `left`.
    const sameFingerOverrides: Record<string, FingerType> = {
      '0,0': 'left-index',
      '0,1': 'left-index',
    }

    it('hides the classes quadrant for trigrams', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}_${keyA}`, count: 10, hist: [1, 2, 3, 1, 1, 1, 1, 0], avgIki: 100, sd: 25 }],
        truncated: false,
      })
      renderChart({ gram: 3, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-content')).toBeTruthy()
      })
      expect(screen.queryByText('analyze.bigrams.quadrant.classes')).toBeNull()
    })

    it('shows the no-snapshot message when there is no keymap snapshot', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: null })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-no-snapshot')).toBeTruthy()
      })
    })

    it('classifies an alternation pair and renders its avgIki + count', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-table')).toBeTruthy()
      })
      const table = screen.getByTestId('analyze-bigrams-classes-table')
      // Bucket center for index 2 is 125ms (see HIST_BUCKETS centers),
      // so the alternation row shows the folded-hist average, not the
      // raw entry.avgIki from the wire payload. Scoped to the row (not
      // the whole table) because the same pair also lands in the
      // word-position in-word bucket with matching numbers.
      const rows = table.querySelectorAll('tbody tr')
      const alternationRow = Array.from(rows).find((r) => r.textContent?.includes('classes.className.alternation'))
      expect(alternationRow?.textContent).toContain('125 ms')
      expect(alternationRow?.textContent).toContain('2,000')
    })

    it('is exclusive: two keys sharing one finger classify as left, not repetition', async () => {
      // keyA and keyB are different keycodes, so even though both are
      // pinned to the same finger this is a same-finger bigram (SFB) —
      // a same-hand pair — not a letter repeat.
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: sameFingerOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-table')).toBeTruthy()
      })
      const table = screen.getByTestId('analyze-bigrams-classes-table')
      const rows = table.querySelectorAll('tbody tr')
      const leftRow = Array.from(rows).find((r) => r.textContent?.includes('classes.className.left'))
      const repetitionRow = Array.from(rows).find((r) => r.textContent?.includes('classes.className.repetition'))
      expect(repetitionRow?.textContent).toContain('—')
      expect(leftRow?.textContent).toContain('125 ms')
      expect(leftRow?.textContent).toContain('2,000')
    })

    it('classifies a same-key repeat (letter repetition) as repetition', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyA}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: { '0,0': 'left-index', '0,1': 'left-index' } })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-table')).toBeTruthy()
      })
      const table = screen.getByTestId('analyze-bigrams-classes-table')
      const rows = table.querySelectorAll('tbody tr')
      const repetitionRow = Array.from(rows).find((r) => r.textContent?.includes('classes.className.repetition'))
      expect(repetitionRow?.textContent).toContain('125 ms')
      expect(repetitionRow?.textContent).toContain('2,000')
    })

    it('shows "—" for a class whose sample is below BIGRAM_MIN_COUNT', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}`, count: 5, hist: [0, 0, 5, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-table')).toBeTruthy()
      })
      const table = screen.getByTestId('analyze-bigrams-classes-table')
      const rows = table.querySelectorAll('tbody tr')
      const alternationRow = Array.from(rows).find((r) => r.textContent?.includes('classes.className.alternation'))
      expect(alternationRow?.textContent).toContain('—')
      expect(alternationRow?.textContent).toContain('5')
    })

    it('shows classification coverage and hides it when there is no snapshot', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-coverage')).toBeTruthy()
      })
    })

    it('renders the word-position section even without a snapshot', async () => {
      const keSpace = deserialize('KC_SPACE')
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keSpace}_${keyA}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: null })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-table')).toBeTruthy()
      })
      const table = screen.getByTestId('analyze-bigrams-classes-table')
      // No snapshot -> hand usage shows the no-snapshot row, but word
      // position needs no snapshot and still resolves the pair.
      expect(within(table).getByTestId('analyze-bigrams-classes-no-snapshot')).toBeTruthy()
      const rows = table.querySelectorAll('tbody tr')
      const initiationRow = Array.from(rows).find((r) => r.textContent?.includes('classes.className.initiation'))
      expect(initiationRow?.textContent).toContain('125 ms')
      expect(initiationRow?.textContent).toContain('2,000')
    })

    it('computes ΔInitiation from the initiation and in-word buckets', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [
          // space -> A: initiation, avgIki bucket center 400ms
          { ngramId: `${deserialize('KC_SPACE')}_${keyA}`, count: 2000, hist: [0, 0, 0, 0, 0, 2000, 0, 0], avgIki: 400, sd: 10 },
          // A -> B: in-word, avgIki bucket center 125ms
          { ngramId: `${keyA}_${keyB}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 },
        ],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-delta')).toBeTruthy()
      })
      const delta = screen.getByTestId('analyze-bigrams-classes-delta')
      expect(delta.textContent).toContain('+275 ms')
    })

    it('shows the excluded-pairs note only when a pair ends at a separator', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${deserialize('KC_SPACE')}`, count: 7, hist: [0, 0, 7, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-excluded-note')).toBeTruthy()
      })
    })

    it('hides the excluded-pairs note when no pair ends at a separator', async () => {
      fetchSpy.mockResolvedValue({
        view: 'top',
        entries: [{ ngramId: `${keyA}_${keyB}`, count: 2000, hist: [0, 0, 2000, 0, 0, 0, 0, 0], avgIki: 125, sd: 10 }],
        truncated: false,
      })
      renderChart({ gram: 2, snapshot: buildSnapshot(), fingerOverrides: alternationOverrides })
      await waitFor(() => {
        expect(screen.getByTestId('analyze-bigrams-classes-table')).toBeTruthy()
      })
      expect(screen.queryByTestId('analyze-bigrams-classes-excluded-note')).toBeNull()
    })
  })
})

/** Minimal wrapper so the "re-fetches when gram changes" test can
 * rerender with a new `gram` prop through React's normal update path
 * (a raw `renderChart` call can't be rerun with different overrides on
 * an existing render). */
function BigramsChartHarness({ gram }: { gram: 2 | 3 }): JSX.Element {
  return (
    <BigramsChart
      uid="0xAABB"
      range={range}
      deviceScopes={['own']}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      topLimit={10}
      slowLimit={10}
      fingerLimit={10}
      pairIntervalThresholdMs={0}
      gram={gram}
      onTopLimitChange={noop}
      onSlowLimitChange={noop}
      onFingerLimitChange={noop}
      onPairIntervalThresholdChange={noop}
      onGramChange={noop}
      snapshot={null}
    />
  )
}
