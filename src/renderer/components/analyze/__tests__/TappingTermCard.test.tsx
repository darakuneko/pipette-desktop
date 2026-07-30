// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for TappingTermCard: the three connection states (matched +
// reported / matched + not reported / guidance), the hidden-entirely
// gates (no snapshot, snapshot loading, zero tap-hold keys), and the
// absence of any write/apply affordance.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TappingTermCard } from '../TappingTermCard'
import type { ConnectedTappingTerm } from '../analyze-types'
import type { TypingDurationCell, TypingKeymapSnapshot, TypingMatrixCellRow } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    i18n: { language: 'en' },
  }),
}))

const range = { fromMs: 0, toMs: 60_000 }

const durationFetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingDurationCell[]>>()
const matrixFetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingMatrixCellRow[]>>()

function setVialAPI(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsListDurationCells: (...args: unknown[]) => durationFetchSpy(...args),
      typingAnalyticsListMatrixCellsLocal: (...args: unknown[]) => matrixFetchSpy(...args),
    },
    writable: true,
    configurable: true,
  })
}

function tapHoldSnapshot(): TypingKeymapSnapshot {
  return {
    uid: '0xAABB',
    machineHash: 'hash-1',
    productName: 'Test Keyboard',
    savedAt: 0,
    layers: 1,
    matrix: { rows: 1, cols: 2 },
    keymap: [[['KC_A', 'LT(1,KC_SPC)']]],
    layout: null,
  }
}

function plainSnapshot(): TypingKeymapSnapshot {
  return {
    uid: '0xAABB',
    machineHash: 'hash-1',
    productName: 'Test Keyboard',
    savedAt: 0,
    layers: 1,
    matrix: { rows: 1, cols: 2 },
    keymap: [[['KC_A', 'KC_B']]],
    layout: null,
  }
}

// currentMs=200 with this hist yields verdict 'canLower', suggestedMs=80
// (see analyze-tapping-term.test.ts's identical fixture).
const canLowerDurationCells: TypingDurationCell[] = [
  { layer: 0, row: 0, col: 1, durationSamples: 300, hist: [285, 0, 0, 0, 0, 0, 0, 15], sum: 15_000, sumSq: 900_000 },
]
const contextMatrixCells: TypingMatrixCellRow[] = [
  { layer: 0, row: 0, col: 1, count: 16, tap: 10, hold: 6 },
]

function reportedTerm(): ConnectedTappingTerm {
  return { uid: '0xAABB', termMs: 200, reported: true }
}
function unreportedTerm(): ConnectedTappingTerm {
  return { uid: '0xAABB', termMs: 200, reported: false }
}

function renderCard(overrides: Partial<Parameters<typeof TappingTermCard>[0]> = {}) {
  return render(
    <TappingTermCard
      uid="0xAABB"
      range={range}
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      snapshot={tapHoldSnapshot()}
      snapshotLoading={false}
      connectedTappingTerm={reportedTerm()}
      {...overrides}
    />,
  )
}

/** Deferred promise so a test controls exactly when the underlying
 * fetch resolves, keeping the "props changed but the new fetch hasn't
 * settled yet" window open long enough to inspect. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('TappingTermCard', () => {
  beforeEach(() => {
    setVialAPI()
    durationFetchSpy.mockReset()
    matrixFetchSpy.mockReset()
    durationFetchSpy.mockResolvedValue(canLowerDurationCells)
    matrixFetchSpy.mockResolvedValue(contextMatrixCells)
  })

  it('renders nothing while the snapshot is still loading', () => {
    const { container } = renderCard({ snapshotLoading: true })
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when there is no snapshot', () => {
    const { container } = renderCard({ snapshot: null })
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the snapshot has zero tap-hold keys', () => {
    const { container } = renderCard({ snapshot: plainSnapshot() })
    expect(container.firstChild).toBeNull()
    expect(durationFetchSpy).not.toHaveBeenCalled()
  })

  it('shows the guidance state (no diagnosis) when no keyboard is connected/matched', async () => {
    renderCard({ connectedTappingTerm: null })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-guidance')).toBeTruthy()
    })
    expect(screen.queryByTestId('analyze-tapping-term-summary')).toBeNull()
    expect(durationFetchSpy).not.toHaveBeenCalled()
  })

  // This card only ever renders under AnalyzePane's "Section" filter-row
  // select, which already labels it visually (shared `sectionTitle`
  // key) — no in-body <h3> here. `aria-label` on the section keeps the
  // name available to assistive tech even without a visible heading.
  it('has no visible section title, but exposes the same name via aria-label', async () => {
    renderCard()
    const section = await waitFor(() => screen.getByTestId('analyze-tapping-term-section'))
    expect(screen.queryByText('analyze.tappingTerm.sectionTitle')).toBeNull()
    expect(section.getAttribute('aria-label')).toBe('analyze.tappingTerm.sectionTitle')
  })

  it('shows the current term and a pointer to the editor when the term is reported', async () => {
    renderCard({ connectedTappingTerm: reportedTerm() })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    const summary = screen.getByTestId('analyze-tapping-term-summary').textContent ?? ''
    expect(summary).toContain('analyze.tappingTerm.stat.current')
    expect(summary).not.toContain('analyze.tappingTerm.stat.assumed')
    expect(summary).toContain('200 ms')
    // canLower fixture: tap p95 bucket is [0,50].
    expect(summary).toContain('0–50 ms')
    const verdict = screen.getByTestId('analyze-tapping-term-verdict').textContent ?? ''
    expect(verdict).toContain('analyze.tappingTerm.verdict.canLower')
    expect(verdict).toContain('"value":80')
    expect(screen.getByTestId('analyze-tapping-term-reported-hint')).toBeTruthy()
    expect(screen.queryByTestId('analyze-tapping-term-unreported-notice')).toBeNull()
  })

  // Regression guard: "Observed tap p95" used to render as a bare
  // millisecond range with no explanation of what the percentile means
  // (same "bare statistical term" complaint pattern as DurationSection's
  // SD stat). It now carries a `descriptionKey`, rendered into a hover
  // tooltip bubble that's always portaled to `document.body` (opacity-
  // hidden until hover — see ui/Tooltip.tsx), so the assertion searches
  // the whole document rather than the stat-grid container.
  it('describes the tap p95 stat in a hover tooltip', async () => {
    renderCard({ connectedTappingTerm: reportedTerm() })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toContain('analyze.tappingTerm.stat.tapP95Desc')
    })
  })

  it('shows the assumed-default notice when the firmware does not report the term', async () => {
    renderCard({ connectedTappingTerm: unreportedTerm() })
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    const summary = screen.getByTestId('analyze-tapping-term-summary').textContent ?? ''
    expect(summary).toContain('analyze.tappingTerm.stat.assumed')
    const notice = screen.getByTestId('analyze-tapping-term-unreported-notice').textContent ?? ''
    expect(notice).toContain('analyze.tappingTerm.unreportedNotice')
    expect(notice).toContain('"default":200')
    expect(screen.queryByTestId('analyze-tapping-term-reported-hint')).toBeNull()
  })

  it('shows recorded tap/hold press counts as context', async () => {
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    const summary = screen.getByTestId('analyze-tapping-term-summary').textContent ?? ''
    expect(summary).toContain('10 / 6')
  })

  it('only aggregates duration/matrix cells sitting on tap-hold positions', async () => {
    durationFetchSpy.mockResolvedValue([
      ...canLowerDurationCells,
      { layer: 0, row: 0, col: 0, durationSamples: 999, hist: [0, 0, 0, 0, 0, 0, 0, 999], sum: 999_000, sumSq: 1 },
    ])
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    const summary = screen.getByTestId('analyze-tapping-term-summary').textContent ?? ''
    // Samples must stay 300 (only the LT cell), not 1299 — the plain
    // KC_A cell at (0,0) must be excluded even though the fetch
    // returned it.
    expect(summary).toContain('300')
  })

  it('renders no button anywhere — no apply/write affordance exists', async () => {
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('always uses the own device scope for both fetches (no Device filter prop to vary it)', async () => {
    renderCard()
    await waitFor(() => expect(durationFetchSpy).toHaveBeenCalledTimes(1))
    // fetchDurationCellsForRange's 2nd arg is the scope itself.
    expect(durationFetchSpy.mock.calls[0][1]).toBe('own')
    // listMatrixCellsForScope's 'own' branch calls the …Local IPC
    // variant (no scope argument — the variant IS the scope), so this
    // just confirms the matrix-cell fetch also ran.
    expect(matrixFetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not show a stale diagnosis frame right after a range change (before the new fetch resolves)', async () => {
    const { rerender } = renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-summary')).toBeTruthy()
    })
    expect(screen.getByTestId('analyze-tapping-term-verdict').textContent).toContain('canLower')

    // The next range's fetch is held open deliberately so the render
    // right after the props change can be inspected before any new
    // data lands.
    const { promise } = deferred<TypingDurationCell[]>()
    durationFetchSpy.mockReturnValue(promise)
    matrixFetchSpy.mockReturnValue(new Promise(() => {}))

    rerender(
      <TappingTermCard
        uid="0xAABB"
        range={{ fromMs: 60_000, toMs: 120_000 }}
        appScopes={[]}
        typingTestScopes={[]}
        runIdScopes={[]}
        snapshot={tapHoldSnapshot()}
        snapshotLoading={false}
        connectedTappingTerm={reportedTerm()}
      />,
    )

    // Never the old (or any) diagnosis while the new range's fetch is
    // still in flight — only the loading state is a valid frame here.
    expect(screen.queryByTestId('analyze-tapping-term-summary')).toBeNull()
    expect(screen.getByTestId('analyze-tapping-term-loading')).toBeTruthy()
  })

  it('shows the reason-specific copy for an unknown verdict', async () => {
    // Below TAPPING_TERM_MIN_SAMPLES -> unknownReason: 'insufficientSamples'.
    durationFetchSpy.mockResolvedValue([
      { layer: 0, row: 0, col: 1, durationSamples: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0], sum: 100, sumSq: 2_000 },
    ])
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('analyze-tapping-term-verdict')).toBeTruthy()
    })
    const verdict = screen.getByTestId('analyze-tapping-term-verdict').textContent ?? ''
    expect(verdict).toContain('analyze.tappingTerm.verdict.unknown.insufficientSamples')
  })
})
