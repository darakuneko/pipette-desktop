// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MacroTileGrid } from '../TileGrids'
import {
  MACRO_BUBBLE_CLASS, MAX_MACRO_BUBBLE_COLUMNS, MacroHoverBubble, nextMacroBubbleColumns,
} from '../MacroHoverBubble'
import { MacroHoverPreviewContext } from '../macro-hover-context'
import { useTileContentOverride } from '../../../hooks/useTileContentOverride'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { MacroAction } from '../../../../preload/macro'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  findKeycode: (id: string) => ({ qmkId: id, label: id, masked: false, hidden: false }),
  codeToLabel: (code: number) => `code-${code}`,
}))

const LONG_TEXT = 'a long text action that goes well past what a tile can show,  with double  spaces\nand a newline'

// M0: more actions than a tile shows, including a long text action.
// M1: empty. M2: a single tap.
const MACROS: MacroAction[][] = [
  [
    { type: 'tap', keycodes: [4, 5] },
    { type: 'down', keycodes: [6] },
    { type: 'up', keycodes: [6] },
    { type: 'delay', delay: 250 },
    { type: 'text', text: LONG_TEXT },
    { type: 'tap', keycodes: [7] },
    { type: 'tap', keycodes: [8] },
    { type: 'tap', keycodes: [9] },
  ],
  [],
  [{ type: 'tap', keycodes: [10] }],
]

function dwell(ms = SHARED_BUBBLE_OPEN_DELAY_MS): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function tile(i: number): HTMLElement {
  return screen.getByTestId(`macro-tile-${i}`)
}

function bubbleLines(): string[] {
  return screen.getAllByTestId('macro-hover-line').map((el) => el.textContent ?? '')
}

describe('MacroTileGrid hover bubble', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens after the shared dwell and closes at once on leave', () => {
    render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(2))
    dwell(SHARED_BUBBLE_OPEN_DELAY_MS - 1)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    dwell(1)
    expect(screen.getByRole('tooltip')).toHaveTextContent('M2')
    fireEvent.mouseLeave(tile(2))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the heading and every action in full, with the tile prefixes', () => {
    render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(0))
    dwell()
    const bubble = screen.getByRole('tooltip')
    expect(bubble.firstElementChild?.textContent).toBe('M0')
    expect(bubbleLines()).toEqual([
      'Tcode-4 code-5', 'Dcode-6', 'Ucode-6', 'W250ms', `Tx${LONG_TEXT}`, 'Tcode-7', 'Tcode-8', 'Tcode-9',
    ])
    // Nothing is cut: no "+N more" line and no truncation on any label.
    expect(bubble.textContent).not.toContain('keycodes.macroMoreActions')
    const textLabel = screen.getAllByTestId('macro-hover-line')[4].lastElementChild!
    expect(textLabel.className).toContain('whitespace-pre-wrap')
    expect(textLabel.className).toContain('break-words')
    expect(textLabel.className).not.toContain('truncate')
  })

  it('renders the bubble in document.body, outside the grid', () => {
    const { container } = render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(0))
    dwell()
    const bubble = screen.getByRole('tooltip')
    expect(bubble.parentElement).toBe(document.body)
    expect(container.contains(bubble)).toBe(false)
  })

  it('shows nothing for an empty macro, and hovering one cancels a pending open', () => {
    render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(1))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(tile(0))
    dwell(100)
    fireEvent.mouseLeave(tile(0))
    fireEvent.mouseEnter(tile(1))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps a single bubble for the last tile when moving quickly between tiles', () => {
    render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(0))
    dwell(200)
    fireEvent.mouseLeave(tile(0))
    fireEvent.mouseEnter(tile(2))
    dwell(200)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    dwell(100)
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(screen.getByRole('tooltip').firstElementChild?.textContent).toBe('M2')
  })

  it('does nothing when the hover preview is off', () => {
    render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} />)
    fireEvent.mouseEnter(tile(0))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('turning it off closes a shown bubble and drops a pending one', () => {
    const { rerender } = render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(0))
    dwell()
    rerender(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview={false} />)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    rerender(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(2))
    dwell(100)
    rerender(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview={false} />)
    rerender(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('follows edits to the hovered macro and closes when it becomes empty', () => {
    const { rerender } = render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(2))
    dwell()
    const edited = [MACROS[0], MACROS[1], [{ type: 'delay', delay: 30 } as MacroAction]]
    rerender(<MacroTileGrid macros={edited} onSelect={vi.fn()} hoverPreview />)
    expect(bubbleLines()).toEqual(['W30ms'])
    rerender(<MacroTileGrid macros={[MACROS[0], MACROS[1], []]} onSelect={vi.fn()} hoverPreview />)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps click and double-click selection working on hovered tiles', () => {
    const onSelect = vi.fn()
    const onDoubleClick = vi.fn()
    render(<MacroTileGrid macros={MACROS} onSelect={onSelect} onDoubleClick={onDoubleClick} hoverPreview />)
    fireEvent.mouseEnter(tile(0))
    dwell()
    fireEvent.click(tile(0))
    fireEvent.doubleClick(tile(0))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'M0' }))
    expect(onDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'M0' }))
  })

  it('clears a pending open on unmount', () => {
    const { unmount } = render(<MacroTileGrid macros={MACROS} onSelect={vi.fn()} hoverPreview />)
    fireEvent.mouseEnter(tile(0))
    unmount()
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

function OverrideHost({ macros }: { macros: MacroAction[][] }) {
  const override = useTileContentOverride({ deserializedMacros: macros, onSelect: vi.fn() })
  return <div>{override?.macro}</div>
}

describe('useTileContentOverride — macro hover setting', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('turns the bubble on from MacroHoverPreviewContext', () => {
    render(
      <MacroHoverPreviewContext.Provider value>
        <OverrideHost macros={MACROS} />
      </MacroHoverPreviewContext.Provider>,
    )
    fireEvent.mouseEnter(tile(2))
    dwell()
    expect(screen.getByRole('tooltip')).toHaveTextContent('M2')
  })

  it.each([
    ['without a provider', (node: JSX.Element) => node],
    ['with the setting off', (node: JSX.Element) => (
      <MacroHoverPreviewContext.Provider value={false}>{node}</MacroHoverPreviewContext.Provider>
    )],
  ])('shows nothing %s', (_label, wrap) => {
    render(wrap(<OverrideHost macros={MACROS} />))
    fireEvent.mouseEnter(tile(2))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('MacroHoverBubble', () => {
  it('uses the shared bubble skin above every modal tier and caps its size at the viewport', () => {
    const classes = MACRO_BUBBLE_CLASS.split(' ')
    expect(classes).toContain('z-70')
    expect(classes).not.toContain('z-50')
    expect(classes).toContain('max-w-tooltip-viewport')
    expect(classes).toContain('max-h-tooltip-viewport')
    expect(classes).not.toContain('max-w-sm')
    expect(classes).toContain('pointer-events-none')
    expect(classes).toContain('fixed')
  })

  it('renders nothing without a bubble', () => {
    render(<MacroHoverBubble bubble={null} />)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  describe('columns for a list taller than the viewport', () => {
    let restore: (() => void) | undefined
    afterEach(() => { restore?.(); restore = undefined })

    // jsdom has no layout: the list is 2000px tall in one column and
    // splits evenly across columns; the heading and padding add 20px.
    function mockHeights(listHeight: number): void {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
          const bubble = this.closest('[data-testid="macro-hover-bubble"]') as HTMLElement | null
          if (!bubble) return 0
          const columns = Number(bubble.dataset.columns ?? '1')
          const list = listHeight / columns
          if (this === bubble) return list + 20
          return this.parentElement === bubble && this !== bubble.firstElementChild ? list : 0
        },
      })
      restore = () => {
        if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
      }
    }

    it('flows into as many columns as it takes to fit', () => {
      mockHeights(2000)
      const actions = Array.from({ length: 120 }, (_, i): MacroAction => ({ type: 'tap', keycodes: [i] }))
      render(<MacroHoverBubble bubble={{ index: 3, actions, rect: new DOMRect(10, 10, 20, 20) }} />)
      const bubble = screen.getByRole('tooltip')
      // jsdom's viewport is 768px tall: 768 - 16 margin - 20 chrome = 732.
      expect(bubble.dataset.columns).toBe('3')
      expect(bubble.children[1].className).toContain('columns-3')
      expect(screen.getAllByTestId('macro-hover-line')).toHaveLength(120)
    })

    it('stays in one column when it fits', () => {
      mockHeights(300)
      render(<MacroHoverBubble bubble={{ index: 0, actions: MACROS[0], rect: new DOMRect(10, 10, 20, 20) }} />)
      expect(screen.getByRole('tooltip').dataset.columns).toBe('1')
    })
  })
})

describe('nextMacroBubbleColumns', () => {
  it('keeps the count when the list fits', () => {
    expect(nextMacroBubbleColumns(1, 500, 700)).toBe(1)
    expect(nextMacroBubbleColumns(3, 700, 700)).toBe(3)
  })

  it('jumps from one column to the height ratio, at least two', () => {
    expect(nextMacroBubbleColumns(1, 2000, 700)).toBe(3)
    expect(nextMacroBubbleColumns(1, 710, 700)).toBe(2)
  })

  it('adds one column at a time once split', () => {
    expect(nextMacroBubbleColumns(3, 800, 700)).toBe(4)
  })

  it('stops at the cap and with no room at all', () => {
    expect(nextMacroBubbleColumns(1, 100000, 700)).toBe(MAX_MACRO_BUBBLE_COLUMNS)
    expect(nextMacroBubbleColumns(MAX_MACRO_BUBBLE_COLUMNS, 100000, 700)).toBe(MAX_MACRO_BUBBLE_COLUMNS)
    expect(nextMacroBubbleColumns(1, 500, 0)).toBe(1)
  })
})
