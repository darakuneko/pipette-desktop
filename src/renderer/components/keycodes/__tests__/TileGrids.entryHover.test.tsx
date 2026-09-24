// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Hover bubble on the Tap Dance / Combo / Key Override / Alt Repeat Key
// picker tiles. Macro tiles are covered in EntryHoverBubble.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Profiler } from 'react'
import { EntryHoverPreviewContext } from '../entry-hover-context'
import { useTileContentOverride } from '../../../hooks/useTileContentOverride'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k}(${Object.values(opts).join(',')})` : k),
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  findKeycode: (id: string) => ({ qmkId: id, label: id, masked: false, hidden: false }),
  codeToLabel: (code: number) => `code-${code}`,
}))

const TD: TapDanceEntry[] = [
  { onTap: 4, onHold: 5, onDoubleTap: 0, onTapHold: 0, tappingTerm: 180 },
  { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 },
]
const COMBO: ComboEntry[] = [
  { key1: 4, key2: 5, key3: 6, key4: 0, output: 7 },
  { key1: 0, key2: 0, key3: 4, key4: 0, output: 5 },
]
const KO: KeyOverrideEntry[] = [
  { triggerKey: 4, replacementKey: 5, layers: 3, triggerMods: 2, negativeMods: 0, suppressedMods: 0, options: 1, enabled: false },
  { triggerKey: 0, replacementKey: 0, layers: 0xffff, triggerMods: 0, negativeMods: 0, suppressedMods: 0, options: 0, enabled: false },
]
const ARK: AltRepeatKeyEntry[] = [
  { lastKey: 4, altKey: 5, allowedMods: 0, options: 2, enabled: true },
  { lastKey: 0, altKey: 0, allowedMods: 1, options: 0, enabled: false },
]

function dwell(ms = SHARED_BUBBLE_OPEN_DELAY_MS): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function bubble(): HTMLElement | null {
  return screen.queryByTestId('entry-hover-bubble')
}

function values(): string[] {
  return screen.getAllByTestId('entry-hover-line').map((el) => el.lastElementChild?.textContent ?? '')
}

interface PickerProps {
  td?: TapDanceEntry[]
  combo?: ComboEntry[]
  ko?: KeyOverrideEntry[]
  ark?: AltRepeatKeyEntry[]
  onOpen?: (index: number) => void
  hoverPreview?: boolean
}

// The tile tabs as a picker shows them: the requested grids plus the
// picker's single shared bubble, with the hover setting from the context.
function Picker({ hoverPreview = false, ...rest }: PickerProps) {
  return (
    <EntryHoverPreviewContext.Provider value={hoverPreview}>
      <PickerBody {...rest} />
    </EntryHoverPreviewContext.Provider>
  )
}

function noop(): void {}

function PickerBody({ td, combo, ko, ark, onOpen = noop }: Omit<PickerProps, 'hoverPreview'>) {
  const override = useTileContentOverride({
    tapDanceEntries: td,
    onSelect: noop,
    settings: {
      comboEntries: combo, onOpenCombo: onOpen,
      keyOverrideEntries: ko, onOpenKeyOverride: onOpen,
      altRepeatKeyEntries: ark, onOpenAltRepeatKey: onOpen,
    },
  })
  const tabs = override?.tabs
  return <div>{tabs?.tapDance}{tabs?.combo}{tabs?.keyOverride}{tabs?.altRepeatKey}{override?.bubble}</div>
}

describe('picker tile hover bubble — Tap Dance / Combo / Key Override / Alt Repeat Key', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('Tap Dance: shows every field of a configured tile, nothing for N/C', () => {
    render(<Picker td={TD} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('td-tile-0'))
    dwell()
    expect(bubble()?.firstElementChild?.textContent).toBe('editor.tapDance.editTitle(0)')
    expect(values()).toEqual(['code-4', 'code-5', 'editor.hoverDetails.none', 'editor.hoverDetails.none', '180'])
    fireEvent.mouseLeave(screen.getByTestId('td-tile-0'))
    fireEvent.mouseEnter(screen.getByTestId('td-tile-1'))
    dwell()
    expect(bubble()).toBeNull()
  })

  it('Combo: shows all keys and the output; a tile with only key 3 is N/C', () => {
    render(<Picker combo={COMBO} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('combo-tile-0'))
    dwell()
    expect(values()).toEqual(['code-4', 'code-5', 'code-6', 'editor.hoverDetails.none', 'code-7'])
    fireEvent.mouseLeave(screen.getByTestId('combo-tile-0'))
    fireEvent.mouseEnter(screen.getByTestId('combo-tile-1'))
    dwell()
    expect(bubble()).toBeNull()
  })

  it('Key Override: a disabled but configured entry shows its fields and Off', () => {
    render(<Picker ko={KO} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('ko-tile-0'))
    dwell()
    expect(values()).toEqual([
      'editor.hoverDetails.off', 'code-4', 'code-5', '0, 1', 'LShift',
      'editor.hoverDetails.none', 'editor.hoverDetails.none', 'ActivationTriggerDown',
    ])
    fireEvent.mouseLeave(screen.getByTestId('ko-tile-0'))
    fireEvent.mouseEnter(screen.getByTestId('ko-tile-1'))
    dwell()
    expect(bubble()).toBeNull()
  })

  it('Alt Repeat Key: shows every field; an entry with only modifiers is N/C', () => {
    render(<Picker ark={ARK} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('arep-tile-0'))
    dwell()
    expect(values()).toEqual(['editor.hoverDetails.on', 'code-4', 'code-5', 'editor.hoverDetails.none', 'Bidirectional'])
    fireEvent.mouseLeave(screen.getByTestId('arep-tile-0'))
    fireEvent.mouseEnter(screen.getByTestId('arep-tile-1'))
    dwell()
    expect(bubble()).toBeNull()
  })

  it('does nothing with the hover preview off', () => {
    render(
      <Picker td={TD} combo={COMBO} ko={KO} ark={ARK} />,
    )
    for (const id of ['td-tile-0', 'combo-tile-0', 'ko-tile-0', 'arep-tile-0']) {
      fireEvent.mouseEnter(screen.getByTestId(id))
      dwell()
      fireEvent.mouseLeave(screen.getByTestId(id))
    }
    expect(bubble()).toBeNull()
  })

  it('moving from one kind to another before the dwell shows only the last one', () => {
    render(
      <Picker td={TD} ko={KO} hoverPreview />,
    )
    fireEvent.mouseEnter(screen.getByTestId('td-tile-0'))
    dwell(200)
    fireEvent.mouseLeave(screen.getByTestId('td-tile-0'))
    fireEvent.mouseEnter(screen.getByTestId('ko-tile-0'))
    dwell()
    expect(screen.getAllByTestId('entry-hover-bubble')).toHaveLength(1)
    expect(bubble()?.firstElementChild?.textContent).toBe('editor.keyOverride.editTitle(0)')
  })

  it('turning it off while pending never opens, and unmount clears a pending open', () => {
    const { rerender, unmount } = render(<Picker combo={COMBO} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('combo-tile-0'))
    dwell(100)
    rerender(<Picker combo={COMBO} hoverPreview={false} />)
    rerender(<Picker combo={COMBO} hoverPreview />)
    dwell()
    expect(bubble()).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('combo-tile-0'))
    unmount()
    dwell()
    expect(bubble()).toBeNull()
  })

  it('follows an edit to the shown entry and closes when it is cleared', () => {
    const { rerender } = render(<Picker ko={KO} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('ko-tile-0'))
    dwell()
    const edited = [{ ...KO[0], enabled: true, replacementKey: 9 }, KO[1]]
    rerender(<Picker ko={edited} hoverPreview />)
    expect(values().slice(0, 3)).toEqual(['editor.hoverDetails.on', 'code-4', 'code-9'])
    rerender(<Picker ko={[KO[1], KO[1]]} hoverPreview />)
    expect(bubble()).toBeNull()
  })

  it('keeps tile clicks working', () => {
    const onOpen = vi.fn()
    render(<Picker ark={ARK} onOpen={onOpen} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('arep-tile-0'))
    dwell()
    fireEvent.click(screen.getByTestId('arep-tile-0'))
    expect(onOpen).toHaveBeenCalledWith(0)
  })
})

function OverrideHost() {
  const override = useTileContentOverride({
    tapDanceEntries: TD,
    onSelect: vi.fn(),
    settings: {
      comboEntries: COMBO, onOpenCombo: vi.fn(),
      keyOverrideEntries: KO, onOpenKeyOverride: vi.fn(),
      altRepeatKeyEntries: ARK, onOpenAltRepeatKey: vi.fn(),
    },
  })
  const tabs = override?.tabs
  return <div>{tabs?.tapDance}{tabs?.combo}{tabs?.keyOverride}{tabs?.altRepeatKey}{override?.bubble}</div>
}

describe('useTileContentOverride — Fav Hover Details setting for every tile kind', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it.each(['td-tile-0', 'combo-tile-0', 'ko-tile-0', 'arep-tile-0'])('%s shows a bubble with the setting on', (id) => {
    render(<EntryHoverPreviewContext.Provider value><OverrideHost /></EntryHoverPreviewContext.Provider>)
    fireEvent.mouseEnter(screen.getByTestId(id))
    dwell()
    expect(bubble()).not.toBeNull()
  })

  it.each(['td-tile-0', 'combo-tile-0', 'ko-tile-0', 'arep-tile-0'])('%s shows nothing with the setting off or no provider', (id) => {
    const { unmount } = render(<EntryHoverPreviewContext.Provider value={false}><OverrideHost /></EntryHoverPreviewContext.Provider>)
    fireEvent.mouseEnter(screen.getByTestId(id))
    dwell()
    expect(bubble()).toBeNull()
    unmount()
    render(<OverrideHost />)
    fireEvent.mouseEnter(screen.getByTestId(id))
    dwell()
    expect(bubble()).toBeNull()
  })
})

describe('one entry hover bubble per picker', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('moving onto a tile of another kind while a bubble is shown keeps a single bubble', () => {
    render(<Picker td={TD} combo={COMBO} ko={KO} ark={ARK} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('td-tile-0'))
    dwell()
    expect(bubble()?.firstElementChild?.textContent).toBe('editor.tapDance.editTitle(0)')
    // No mouseleave on the Tap Dance tile: every grid shares one bubble,
    // so the next kind replaces it instead of opening a second one.
    for (const [id, title] of [
      ['combo-tile-0', 'editor.combo.editTitle(0)'],
      ['ko-tile-0', 'editor.keyOverride.editTitle(0)'],
      ['arep-tile-0', 'editor.altRepeatKey.editTitle(0)'],
    ]) {
      fireEvent.mouseEnter(screen.getByTestId(id))
      dwell()
      expect(screen.getAllByTestId('entry-hover-bubble')).toHaveLength(1)
      expect(bubble()?.firstElementChild?.textContent).toBe(title)
    }
  })

  it('leaving a tile of one kind closes the bubble opened from another kind', () => {
    render(<Picker td={TD} ko={KO} hoverPreview />)
    fireEvent.mouseEnter(screen.getByTestId('ko-tile-0'))
    dwell()
    fireEvent.mouseLeave(screen.getByTestId('td-tile-0'))
    expect(bubble()).toBeNull()
  })

  it('opening and closing the bubble re-renders neither the grids nor the caller', () => {
    let hostRenders = 0
    const gridCommits = vi.fn()
    function Host() {
      hostRenders++
      const override = useTileContentOverride({
        tapDanceEntries: TD,
        onSelect: noop,
        settings: { comboEntries: COMBO, onOpenCombo: noop, keyOverrideEntries: KO, onOpenKeyOverride: noop },
      })
      const tabs = override?.tabs
      return (
        <div>
          <Profiler id="grids" onRender={gridCommits}>{tabs?.tapDance}{tabs?.combo}{tabs?.keyOverride}</Profiler>
          {override?.bubble}
        </div>
      )
    }
    render(<EntryHoverPreviewContext.Provider value><Host /></EntryHoverPreviewContext.Provider>)
    // The probe sees the mount commit, so a silent one below is meaningful.
    expect(gridCommits).toHaveBeenCalled()
    const rendersBefore = hostRenders
    gridCommits.mockClear()
    fireEvent.mouseEnter(screen.getByTestId('td-tile-0'))
    dwell()
    expect(bubble()).not.toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('ko-tile-0'))
    dwell()
    fireEvent.mouseLeave(screen.getByTestId('ko-tile-0'))
    expect(bubble()).toBeNull()
    expect(hostRenders).toBe(rendersBefore)
    expect(gridCommits).not.toHaveBeenCalled()
  })
})
