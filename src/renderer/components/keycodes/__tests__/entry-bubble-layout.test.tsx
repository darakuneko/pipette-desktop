// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  EntryHoverBubble, INITIAL_ENTRY_BUBBLE_LAYOUT, MAX_ENTRY_BUBBLE_COLUMNS, stepEntryBubbleLayout,
  type EntryBubbleLayout, type EntryBubbleMeasurement,
} from '../EntryHoverBubble'
import type { EntryHoverBubbleState } from '../use-entry-hover'
import type { MacroAction } from '../../../../preload/macro'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  findKeycode: (id: string) => ({ qmkId: id, label: id, masked: false, hidden: false }),
  codeToLabel: (code: number) => `code-${code}`,
}))

const VIEWPORT = { width: 1000, height: 800 }
// 14px heading + 6px padding top and bottom + 1px border top and bottom.
const CHROME = 28

/** A measurement of a bubble `width` x `height` whose list is `listHeight`
 *  tall, for a 40px key at (`x`, `y`). */
function measure(listHeight: number, width: number, height: number, x = 480, y = 380, tableRows: number | null = null): EntryBubbleMeasurement {
  return {
    anchor: new DOMRect(x, y, 40, 40),
    bubbleRect: new DOMRect(0, 0, width, height),
    listHeight,
    chrome: CHROME,
    viewport: VIEWPORT,
    tableRows,
  }
}

function layout(overrides: Partial<EntryBubbleLayout>): EntryBubbleLayout {
  return { ...INITIAL_ENTRY_BUBBLE_LAYOUT, ...overrides }
}

describe('stepEntryBubbleLayout', () => {
  it('grows the columns to the viewport height first', () => {
    // 800 - 16 margin - 28 chrome = 756 available.
    expect(stepEntryBubbleLayout(INITIAL_ENTRY_BUBBLE_LAYOUT, measure(2000, 250, 784))).toEqual(layout({ columns: 3, viewportColumns: 3 }))
  })

  it('places a bubble that fits beside the anchor at once', () => {
    const next = stepEntryBubbleLayout(INITIAL_ENTRY_BUBBLE_LAYOUT, measure(100, 200, 126))
    expect(next).toEqual(layout({ stage: 'done', pos: { top: 380 - 8 - 126, left: 400 } }))
  })

  it('keeps a finished layout as the same object', () => {
    const done = layout({ stage: 'done', pos: { top: 1, left: 2 } })
    expect(stepEntryBubbleLayout(done, measure(100, 200, 126))).toBe(done)
  })

  it('retries with more columns sized to the taller space beside the anchor', () => {
    // Too tall for above / below, too wide for the sides. Above and below
    // are both 364 (380 - 16, 800 - 420 - 16), minus 28 chrome = 336.
    const next = stepEntryBubbleLayout(layout({}), measure(700, 500, 726))
    expect(next).toEqual({ stage: 'beside', columns: 3, viewportColumns: 1, listHeight: 700, pos: null })
    const placed = stepEntryBubbleLayout(next, measure(234, 984, 260))
    expect(placed).toEqual({ ...next, stage: 'done', pos: { top: 380 - 8 - 260, left: 8 } })
  })

  it('keeps adding one column at a time while the list gets shorter', () => {
    const beside = layout({ stage: 'beside', columns: 3, viewportColumns: 1, listHeight: 700 })
    expect(stepEntryBubbleLayout(beside, measure(400, 984, 426))).toEqual({ ...beside, columns: 4, listHeight: 400 })
  })

  it('goes back to the viewport columns when more columns stop shortening the list', () => {
    const beside = layout({ stage: 'beside', columns: 3, viewportColumns: 1, listHeight: 500 })
    const back = stepEntryBubbleLayout(beside, measure(500, 984, 526))
    expect(back).toEqual({ ...beside, stage: 'fallback', columns: 1 })
    // Then the shared top-center placement, clamped over the anchor.
    expect(stepEntryBubbleLayout(back, measure(700, 500, 726))).toEqual({ ...back, stage: 'done', pos: { top: 8, left: 250 } })
  })

  it('stops at the column cap', () => {
    const beside = layout({ stage: 'beside', columns: MAX_ENTRY_BUBBLE_COLUMNS, viewportColumns: 2, listHeight: 900 })
    expect(stepEntryBubbleLayout(beside, measure(800, 984, 784))).toEqual({ ...beside, stage: 'fallback', columns: 2 })
  })

  it('stops when a table would keep the same split', () => {
    // 8 rows: 4 and 5 tables both hold 2 rows each.
    const beside = layout({ stage: 'beside', columns: 4, viewportColumns: 1, listHeight: 900 })
    expect(stepEntryBubbleLayout(beside, measure(800, 984, 784, 480, 380, 8)).stage).toBe('fallback')
    // 3 -> 4 tables changes 3 rows each to 2, so it goes on.
    const three = layout({ stage: 'beside', columns: 3, viewportColumns: 1, listHeight: 900 })
    expect(stepEntryBubbleLayout(three, measure(800, 984, 784, 480, 380, 8)).columns).toBe(4)
  })

  it('places top-center without a retry when the chrome leaves no space beside the anchor', () => {
    // A key as tall as the viewport minus margins: 0px above and below.
    const m = { ...measure(300, 984, 326), anchor: new DOMRect(480, 16, 40, 768) }
    expect(stepEntryBubbleLayout(INITIAL_ENTRY_BUBBLE_LAYOUT, m)).toEqual(layout({ stage: 'done', pos: { top: 8, left: 8 } }))
  })

  it('always finishes within a bounded number of measurements', () => {
    // Nothing ever fits, but the list keeps shrinking with more columns.
    let current = INITIAL_ENTRY_BUBBLE_LAYOUT
    let steps = 0
    while (current.stage !== 'done') {
      current = stepEntryBubbleLayout(current, measure(3000 / current.columns, 984, 784))
      steps += 1
      expect(steps).toBeLessThanOrEqual(2 * MAX_ENTRY_BUBBLE_COLUMNS + 2)
    }
    expect(current.columns).toBe(current.viewportColumns)
  })
})

// jsdom has no layout. Modeled like the real bubble, in fractional px: the
// list is `listAt(columns)` tall and `widthAt(columns)` wide, the heading
// is 14px, padding and border add the rest of `CHROME`, and the bubble is
// capped at the viewport minus 16px each way. jsdom's viewport is 1024 x 768.
function mockLayout(listAt: (columns: number) => number, widthAt: (columns: number) => number): () => void {
  const realRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const bubble = this.closest<HTMLElement>('[data-testid="entry-hover-bubble"]')
    if (!bubble) return realRect.call(this)
    const columns = Number(bubble.dataset.columns ?? '1')
    if (this === bubble) {
      return new DOMRect(0, 0, Math.min(widthAt(columns), 1024 - 16), Math.min(listAt(columns) + CHROME, 768 - 16))
    }
    if (this === bubble.firstElementChild) return new DOMRect(0, 0, 0, 14)
    return new DOMRect(0, 0, 0, this.parentElement === bubble ? listAt(columns) : 0)
  }
  const realStyle = window.getComputedStyle.bind(window)
  const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = realStyle(el, pseudo)
    if (!(el instanceof HTMLElement) || el.dataset.testid !== 'entry-hover-bubble') return style
    return { ...style, paddingTop: '6px', paddingBottom: '6px', borderTopWidth: '1px', borderBottomWidth: '1px' } as CSSStyleDeclaration
  })
  return () => {
    HTMLElement.prototype.getBoundingClientRect = realRect
    styleSpy.mockRestore()
  }
}

const TAPS = (n: number): MacroAction[] => Array.from({ length: n }, (_, i): MacroAction => ({ type: 'tap', keycodes: [i] }))

function macroBubble(rect: DOMRect, actions = TAPS(20)): EntryHoverBubbleState {
  return { index: 0, entry: { kind: 'macro', value: actions }, rect }
}

function shown(): { columns: string | undefined; top: number; left: number } {
  const el = screen.getByTestId('entry-hover-bubble')
  return { columns: el.dataset.columns, top: parseFloat(el.style.top), left: parseFloat(el.style.left) }
}

describe('EntryHoverBubble placement', () => {
  let restore: (() => void) | undefined
  afterEach(() => { restore?.(); restore = undefined })

  it.each([
    ['a key mid-keymap', new DOMRect(480, 380, 40, 40), 'top'],
    ['a key at the left edge', new DOMRect(0, 380, 40, 40), 'top'],
    ['a rotated key (its bounding box)', new DOMRect(470, 370, 60, 60), 'top'],
    ['an encoder direction', new DOMRect(900, 300, 20, 20), 'top'],
    ['a tile in the top row', new DOMRect(300, 40, 60, 40), 'bottom'],
    ['a tile in the bottom row', new DOMRect(300, 700, 60, 40), 'top'],
  ])('puts a small bubble 8px beside %s without covering it', (_label, rect, side) => {
    restore = mockLayout(() => 150, () => 250)
    render(<EntryHoverBubble bubble={macroBubble(rect)} />)
    const { top, left } = shown()
    const height = 150 + CHROME
    if (side === 'top') expect(top + height).toBe(rect.top - 8)
    else expect(top).toBe(rect.bottom + 8)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + 250).toBeLessThanOrEqual(1024 - 8)
  })

  it('adds columns so a long macro fits beside its key', () => {
    // One column fits the viewport (700 <= 726) but not above, below or
    // beside a key in the middle; three columns fit above.
    restore = mockLayout((c) => 700 / c, (c) => 500 * c)
    const rect = new DOMRect(480, 360, 40, 40)
    render(<EntryHoverBubble bubble={macroBubble(rect)} />)
    const { columns, top } = shown()
    expect(columns).toBe('3')
    expect(top + 700 / 3 + CHROME).toBeCloseTo(rect.top - 8)
  })

  it('falls back to the viewport columns and top-center when nothing fits', () => {
    // A 500px line that no column count splits.
    restore = mockLayout((c) => Math.max(700 / c, 500), (c) => 500 * c)
    render(<EntryHoverBubble bubble={macroBubble(new DOMRect(480, 360, 40, 40))} />)
    expect(shown()).toEqual({ columns: '1', top: 8, left: 250 })
  })

  it('starts over for a new bubble', () => {
    restore = mockLayout((c) => 700 / c, (c) => 500 * c)
    const { rerender } = render(<EntryHoverBubble bubble={macroBubble(new DOMRect(480, 360, 40, 40))} />)
    expect(shown().columns).toBe('3')
    // Near the top the space below takes two columns, measured afresh.
    rerender(<EntryHoverBubble bubble={macroBubble(new DOMRect(480, 10, 40, 40))} />)
    expect(shown()).toMatchObject({ columns: '2', top: 58 })
  })

  it('goes right of a key at the left edge, sliding only vertically', () => {
    // Too tall for above / below a key mid-height, narrow enough for a side.
    restore = mockLayout(() => 600, () => 300)
    render(<EntryHoverBubble bubble={macroBubble(new DOMRect(0, 360, 40, 40))} />)
    expect(shown()).toEqual({ columns: '1', top: 380 - (600 + CHROME) / 2, left: 48 })
  })

  it('goes left of a key at the right edge', () => {
    restore = mockLayout(() => 600, () => 300)
    render(<EntryHoverBubble bubble={macroBubble(new DOMRect(984, 360, 40, 40))} />)
    expect(shown()).toEqual({ columns: '1', top: 380 - (600 + CHROME) / 2, left: 984 - 8 - 300 })
  })

  it('adds one more column for a list a fraction of a pixel too tall', () => {
    // Below is the taller space: 768 - 400 - 16 = 352, minus 28 chrome = 324.
    // Two columns leave the list 0.4px over it, so a third is tried, which
    // then fits above.
    restore = mockLayout((c) => (c === 1 ? 640 : c === 2 ? 324.4 : 640 / c), (c) => 500 * c)
    render(<EntryHoverBubble bubble={macroBubble(new DOMRect(480, 360, 40, 40))} />)
    const { columns, top } = shown()
    expect(columns).toBe('3')
    expect(top).toBeCloseTo(360 - 8 - (640 / 3 + CHROME))
  })

  it('splits a field table so it fits beside its key', () => {
    // 8 rows of 90px: one table of 720 fits the viewport but no side; three
    // tables of 3 rows (270px) fit above.
    restore = mockLayout((c) => Math.ceil(8 / c) * 90, (c) => 500 * c)
    const value = {
      triggerKey: 4, replacementKey: 5, layers: 3, triggerMods: 1, negativeMods: 0, suppressedMods: 0, options: 0, enabled: true,
    }
    render(<EntryHoverBubble bubble={{ index: 1, entry: { kind: 'keyOverride', value }, rect: new DOMRect(480, 360, 40, 40) }} />)
    expect(shown()).toMatchObject({ columns: '3', top: 360 - 8 - (270 + CHROME) })
    expect(screen.getAllByTestId('entry-hover-table')).toHaveLength(3)
  })

  it('closes on a window resize and opens again for the next hover', () => {
    restore = mockLayout(() => 150, () => 250)
    const rect = new DOMRect(480, 380, 40, 40)
    const { rerender } = render(<EntryHoverBubble bubble={macroBubble(rect)} />)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    rerender(<EntryHoverBubble bubble={macroBubble(rect)} />)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })
})
