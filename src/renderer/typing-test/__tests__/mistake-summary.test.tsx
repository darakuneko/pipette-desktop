// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// FLAG (coordinator-requested layout changes, cumulative history):
//  1. MissedCharsList's original chip+tooltip presentation was replaced
//     by a column TABLE (MissedTable) for KeystrokeTimelinePanel's use.
//     MissedCharsList itself was reverted to its original plain-chip
//     shape (no `details` prop) since TypingTestStatsRow, its only
//     remaining caller, never had detail data to show in the first
//     place.
//  2. The table gained internal scrolling + a sticky header (no more
//     top-N truncation).
//  3. THIS REWRITE: the column-table presentation (headers, a separate
//     Moved-on column) was replaced by the approved bar-graph mockup —
//     Word / "→ typed chars" / stacked red-gray bar / Cnt, no header row
//     at all. Every table-era test below (header assertions, the
//     separate `-movedon` cell, `formatTypedInstead`-with-counts in the
//     row itself) was rewritten to the bar-graph's own shape; none were
//     silently dropped.

import { describe, it, expect } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { MissedCharsList, MissedTable } from '../mistake-summary'
import type { MissedCharDetail } from '../missed-details'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

/** Hovers a row's bar and returns the tooltip element it opens —
 *  `fireEvent.mouseEnter` (not `.hover()`, which is a user-event/
 *  Playwright-only API) is enough to flip `Tooltip`'s own `open` state
 *  synchronously in a jsdom render. */
function hoverBar(key: string): HTMLElement {
  const bar = screen.getByTestId(`missed-table-row-${key}-bar`)
  fireEvent.mouseEnter(bar)
  const describedBy = bar.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  return document.getElementById(describedBy!)!
}

describe('MissedCharsList (plain chip line — TypingTestStatsRow\'s no-log fallback)', () => {
  it('renders nothing when mistakes is empty', () => {
    const { container } = renderWithI18n(<MissedCharsList mistakes={{}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a chip per mistake key, sorted by count', () => {
    renderWithI18n(<MissedCharsList mistakes={{ h: 2, e: 3 }} />)
    const list = screen.getByTestId('typing-test-mistakes')
    const chips = within(list).getAllByText(/^[a-z]:\d$/)
    expect(chips.map((c) => c.textContent)).toEqual(['e:3', 'h:2'])
  })
})

describe('MissedTable (bar-graph rows: Word / typed chars / stacked bar / Cnt)', () => {
  it('renders nothing when mistakes is empty', () => {
    const { container } = renderWithI18n(<MissedTable mistakes={{}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the "Missed" section heading', () => {
    renderWithI18n(<MissedTable mistakes={{ h: 1 }} />)
    expect(screen.getByText('Missed')).toBeInTheDocument()
  })

  // FLAG: replaces the old "renders a 4-column header row" test — the
  // mockup has no header row at all.
  it('renders no header row', () => {
    renderWithI18n(<MissedTable mistakes={{ h: 1 }} />)
    expect(screen.queryByTestId('missed-table-header')).toBeNull()
  })

  it('every row shares the same grid column tracks', () => {
    renderWithI18n(<MissedTable mistakes={{ h: 1, e: 2 }} />)
    const rowH = screen.getByTestId('missed-table-row-h')
    const rowE = screen.getByTestId('missed-table-row-e')
    expect(rowH.style.gridTemplateColumns.length).toBeGreaterThan(0)
    expect(rowE.style.gridTemplateColumns).toBe(rowH.style.gridTemplateColumns)
  })

  it('renders Word and Cnt from `mistakes`, and the typed-chars cell as "→ chars" (no counts inline)', () => {
    const details = new Map<string, MissedCharDetail>([
      ['e', { typedCounts: { n: 2, m: 1 }, movedOnCount: 0 }],
    ])
    renderWithI18n(<MissedTable mistakes={{ e: 3 }} details={details} />)
    const row = screen.getByTestId('missed-table-row-e')
    expect(within(row).getByTestId('missed-table-row-e-word').textContent).toBe('e')
    expect(within(row).getByTestId('missed-table-row-e-count').textContent).toBe('3')
    // Sorted DESC by count, chars only — counts live in the tooltip, not here.
    expect(within(row).getByTestId('missed-table-row-e-typed').textContent).toBe('→ n, m')
  })

  it('renders EMPTY_STAT_VALUE ("—", no arrow) for the typed-chars cell when the key has no detail entry (legacy log)', () => {
    renderWithI18n(<MissedTable mistakes={{ h: 1 }} details={new Map()} />)
    expect(screen.getByTestId('missed-table-row-h-typed').textContent).toBe('—')
  })

  it('renders EMPTY_STAT_VALUE ("—") for the typed-chars cell when `details` is omitted entirely', () => {
    renderWithI18n(<MissedTable mistakes={{ h: 1, e: 2 }} />)
    expect(screen.getByTestId('missed-table-row-h-typed').textContent).toBe('—')
    expect(screen.getByTestId('missed-table-row-e-typed').textContent).toBe('—')
  })

  it('renders one row per sorted mistake key', () => {
    renderWithI18n(<MissedTable mistakes={{ h: 1, e: 3, a: 2 }} />)
    for (const key of ['e', 'a', 'h']) {
      expect(screen.getByTestId(`missed-table-row-${key}`)).toBeInTheDocument()
    }
  })

  it('renders EVERY entry — no truncation, however many distinct mistake keys there are', () => {
    const mistakes: Record<string, number> = {}
    for (let i = 0; i < 30; i++) mistakes[`k${String(i).padStart(2, '0')}`] = 30 - i
    renderWithI18n(<MissedTable mistakes={mistakes} />)
    for (let i = 0; i < 30; i++) {
      expect(screen.getByTestId(`missed-table-row-k${String(i).padStart(2, '0')}`)).toBeInTheDocument()
    }
  })

  describe('bar width normalization (total fill vs the list\'s own max Cnt)', () => {
    it('the highest-count row\'s bar fills 100% of its track', () => {
      renderWithI18n(<MissedTable mistakes={{ e: 10, a: 5 }} />)
      const barE = screen.getByTestId('missed-table-row-e-bar').firstElementChild as HTMLElement
      expect(barE.style.width).toBe('100%')
    })

    it('a lower-count row\'s bar fill is proportional to count/maxCount', () => {
      renderWithI18n(<MissedTable mistakes={{ e: 10, a: 5 }} />)
      const barA = screen.getByTestId('missed-table-row-a-bar').firstElementChild as HTMLElement
      expect(barA.style.width).toBe('50%')
    })

    it('a single-row list (count === maxCount) always fills 100%', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 3 }} />)
      const bar = screen.getByTestId('missed-table-row-h-bar').firstElementChild as HTMLElement
      expect(bar.style.width).toBe('100%')
    })
  })

  describe('red (moved-on) / gray (corrected) segment split', () => {
    it('splits the fill proportionally: red = movedOnCount/count, gray = the remainder', () => {
      const details = new Map<string, MissedCharDetail>([['h', { typedCounts: { x: 4 }, movedOnCount: 1 }]])
      renderWithI18n(<MissedTable mistakes={{ h: 4 }} details={details} />)
      const movedOn = screen.getByTestId('missed-table-row-h-bar-movedon')
      const corrected = screen.getByTestId('missed-table-row-h-bar-corrected')
      expect(movedOn.style.width).toBe('25%')
      expect(corrected.style.width).toBe('75%')
      expect(movedOn.className).toContain('bg-danger')
      expect(corrected.className).toContain('bg-content-muted')
    })

    it('movedOnCount === count -> the bar is entirely red', () => {
      const details = new Map<string, MissedCharDetail>([['h', { typedCounts: { x: 2 }, movedOnCount: 2 }]])
      renderWithI18n(<MissedTable mistakes={{ h: 2 }} details={details} />)
      expect(screen.getByTestId('missed-table-row-h-bar-movedon').style.width).toBe('100%')
      expect(screen.getByTestId('missed-table-row-h-bar-corrected').style.width).toBe('0%')
    })

    it('movedOnCount === 0 -> the bar is entirely gray (corrected)', () => {
      const details = new Map<string, MissedCharDetail>([['h', { typedCounts: { x: 2 }, movedOnCount: 0 }]])
      renderWithI18n(<MissedTable mistakes={{ h: 2 }} details={details} />)
      expect(screen.getByTestId('missed-table-row-h-bar-movedon').style.width).toBe('0%')
      expect(screen.getByTestId('missed-table-row-h-bar-corrected').style.width).toBe('100%')
    })

    it('clamps a movedOnCount that (via a different code path) exceeds count, rather than overflowing past 100%', () => {
      const details = new Map<string, MissedCharDetail>([['h', { typedCounts: { x: 1 }, movedOnCount: 99 }]])
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} details={details} />)
      expect(screen.getByTestId('missed-table-row-h-bar-movedon').style.width).toBe('100%')
      expect(screen.getByTestId('missed-table-row-h-bar-corrected').style.width).toBe('0%')
    })

    // FLAGGED CHOICE (unknown-split rendering): a row with no detail data
    // at all renders IDENTICALLY to a genuinely all-corrected row (100%
    // gray) — there's no third "unknown" visual state. The tooltip is
    // what actually distinguishes the two cases (see the tooltip
    // describe block below).
    it('a legacy/no-detail row renders its bar entirely gray — identical to a confirmed all-corrected row', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} details={new Map()} />)
      expect(screen.getByTestId('missed-table-row-h-bar-movedon').style.width).toBe('0%')
      expect(screen.getByTestId('missed-table-row-h-bar-corrected').style.width).toBe('100%')
    })

    it('a row with `details` omitted entirely also renders its bar entirely gray', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} />)
      expect(screen.getByTestId('missed-table-row-h-bar-movedon').style.width).toBe('0%')
      expect(screen.getByTestId('missed-table-row-h-bar-corrected').style.width).toBe('100%')
    })
  })

  describe('bar hover tooltip', () => {
    it('shows Typed instead (with counts) / Corrected with Backspace / Moved on uncorrected, no native title', () => {
      const details = new Map<string, MissedCharDetail>([['h', { typedCounts: { m: 2, b: 1 }, movedOnCount: 1 }]])
      renderWithI18n(<MissedTable mistakes={{ h: 3 }} details={details} />)
      const bar = screen.getByTestId('missed-table-row-h-bar')
      expect(bar.getAttribute('title')).toBeNull()
      const tooltip = hoverBar('h')
      expect(tooltip.textContent).toBe(
        'Typed instead: m: 2, b: 1\n'
        + 'Corrected with Backspace: 2\n'
        + 'Moved on uncorrected: 1',
      )
    })

    it('omits the "Typed instead" line when typedCounts is empty, but still shows Corrected/Moved on', () => {
      const details = new Map<string, MissedCharDetail>([['i', { typedCounts: {}, movedOnCount: 3 }]])
      renderWithI18n(<MissedTable mistakes={{ i: 3 }} details={details} />)
      const tooltip = hoverBar('i')
      expect(tooltip.textContent).not.toContain('Typed instead')
      expect(tooltip.textContent).toContain('Corrected with Backspace: 0')
      expect(tooltip.textContent).toContain('Moved on uncorrected: 3')
    })

    // FLAGGED CHOICE, continued: the tooltip is where a legacy/no-detail
    // row's bar becomes distinguishable from a confirmed all-corrected
    // one, even though the bar itself renders identically for both.
    it('a legacy/no-detail row shows a single distinct sentence instead of the normal 3-line breakdown', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} details={new Map()} />)
      const tooltip = hoverBar('h')
      expect(tooltip.textContent).toBe('No per-keystroke detail available for this run')
    })

    it('no element in the table carries a native title attribute (lint forbids it)', () => {
      const details = new Map<string, MissedCharDetail>([['h', { typedCounts: { m: 1 }, movedOnCount: 0 }]])
      const { container } = renderWithI18n(<MissedTable mistakes={{ h: 1 }} details={details} />)
      expect(container.querySelectorAll('[title]').length).toBe(0)
    })
  })

  describe('internal scroll (bounded height, retained from the earlier table version)', () => {
    it('the scroll container carries the bounded max-height, overflow-y-auto, and the scrollbar-gutter class', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} />)
      const scrollport = screen.getByTestId('missed-table-scrollport')
      expect(scrollport.className).toContain('max-h-56')
      expect(scrollport.className).toContain('overflow-y-auto')
      // `.missed-table-scrollport` (style.css) is what actually declares
      // `scrollbar-gutter: stable` — jsdom doesn't compute real CSS, so
      // this only proves the class is applied, same limitation the
      // existing `.keystroke-timeline-scrollport` tests accept.
      expect(scrollport.className).toContain('missed-table-scrollport')
    })

    it('every row lives inside the scroll container', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1, e: 2 }} />)
      const scrollport = screen.getByTestId('missed-table-scrollport')
      expect(within(scrollport).getByTestId('missed-table-row-h')).toBeInTheDocument()
      expect(within(scrollport).getByTestId('missed-table-row-e')).toBeInTheDocument()
    })
  })

  // `bordered`/`maxHeightClass` (timeline-panel polish items 2 & 3):
  // KeystrokeTimelinePanel passes `maxHeightClass="max-h-40"
  // bordered={false}` for its own bounded-modal instance (see
  // KeystrokeTimelinePanel.test.tsx) — this describe block covers the
  // props themselves, on `MissedTable` directly, independent of that
  // caller.
  describe('bordered / maxHeightClass (scrollport framing + height cap, caller-overridable)', () => {
    it('defaults to bordered=true (rounded-md border border-edge) and max-h-56, matching History\'s unboxed "Most missed" usage', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} />)
      const scrollport = screen.getByTestId('missed-table-scrollport')
      expect(scrollport.className).toContain('rounded-md')
      expect(scrollport.className).toContain('border')
      expect(scrollport.className).toContain('border-edge')
      expect(scrollport.className).toContain('max-h-56')
    })

    it('bordered={false} drops the rounded/border classes but keeps scroll/padding', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} bordered={false} />)
      const scrollport = screen.getByTestId('missed-table-scrollport')
      expect(scrollport.className).not.toContain('border')
      expect(scrollport.className).not.toContain('rounded-md')
      expect(scrollport.className).toContain('overflow-y-auto')
      expect(scrollport.className).toContain('p-2')
    })

    it('maxHeightClass overrides the default max-h-56 cap', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} maxHeightClass="max-h-40" />)
      const scrollport = screen.getByTestId('missed-table-scrollport')
      expect(scrollport.className).toContain('max-h-40')
      expect(scrollport.className).not.toContain('max-h-56')
    })
  })

  // Shared-component reuse (MistakeRankingSection, History's Analysis tab)
  // — proves the same row list renders correctly under the cross-run
  // caller's own titleKey/testId, not just the single-run defaults
  // exercised above.
  describe('parameterization (reused by MistakeRankingSection)', () => {
    it('titleKey overrides the section heading', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} titleKey="editor.typingTest.history.mistakeRankingTitle" />)
      expect(screen.getByText('Most missed')).toBeInTheDocument()
      expect(screen.queryByText('Missed')).toBeNull()
    })

    it('testId overrides the root element testid, without changing the inner row testids', () => {
      renderWithI18n(<MissedTable mistakes={{ h: 1 }} testId="typing-test-mistake-ranking" />)
      expect(screen.getByTestId('typing-test-mistake-ranking')).toBeInTheDocument()
      expect(screen.queryByTestId('typing-test-missed-table')).toBeNull()
      expect(screen.getByTestId('missed-table-row-h')).toBeInTheDocument()
    })
  })
})
