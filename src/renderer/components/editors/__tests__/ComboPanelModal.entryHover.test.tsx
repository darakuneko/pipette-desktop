// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// The small key picker inside a modal renders the real Macro tab tiles
// (`useTileContentOverride` → `MacroTileGrid`), so hovering a tile there
// shows the macro hover bubble when the setting is on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ComboPanelModal } from '../ComboPanelModal'
import { EntryHoverPreviewContext } from '../../keycodes/entry-hover-context'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { ComboEntry } from '../../../../shared/types/protocol'
import type { MacroAction } from '../../../../preload/macro'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.index !== undefined ? `${key} ${String(opts.index)}` : key) }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => Number(val.replace('KC_', '')),
  keycodeLabel: (qmkId: string) => qmkId,
  codeToLabel: (code: number) => `KC_${code}`,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

// Shows the Macro tab override the modal hands the picker, the picker's
// shared entry hover bubble and its close button.
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: ({ tabContentOverride, onClose }: {
    tabContentOverride?: { tabs: Record<string, ReactNode>; bubble: ReactNode }
    onClose?: () => void
  }) => (
    <div data-testid="tabbed-keycodes">
      {tabContentOverride?.tabs.macro}{tabContentOverride?.bubble}
      <button type="button" data-testid="picker-close" onClick={onClose} />
    </div>
  ),
}))

vi.mock('../FavoriteStoreContent', () => ({
  FavoriteStoreContent: () => <div data-testid="favorite-store-content" />,
}))

const ENTRY: ComboEntry = { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }
const MACROS: MacroAction[][] = [[{ type: 'tap', keycodes: [4] }, { type: 'text', text: 'hi there' }]]

function modal(): JSX.Element {
  return (
    <ComboPanelModal
      entries={[ENTRY]} initialIndex={0} onSetEntry={vi.fn()} onClose={vi.fn()} vialProtocol={9}
      deserializedMacros={MACROS}
    />
  )
}

function openPickerAndHoverMacro(): void {
  fireEvent.click(screen.getAllByTestId('keycode-field')[0])
  act(() => { vi.advanceTimersByTime(300) })
  fireEvent.mouseEnter(screen.getByTestId('macro-tile-0'))
  act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
}

describe('ComboPanelModal — entry hover bubble in the picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.vialAPI = {
      ...window.vialAPI,
      favoriteStoreList: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.vialAPI
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows the full macro above the modal when the setting is on', () => {
    render(<EntryHoverPreviewContext.Provider value>{modal()}</EntryHoverPreviewContext.Provider>)
    openPickerAndHoverMacro()
    const bubble = screen.getByTestId('entry-hover-bubble')
    expect(bubble).toHaveTextContent('M0')
    expect(screen.getAllByTestId('entry-hover-line').map((el) => el.textContent)).toEqual(['TKC_4', 'Txhi there'])
    expect(bubble.parentElement).toBe(document.body)
    expect(bubble.className.split(' ')).toContain('z-70')
  })

  it('shows nothing with the setting off', () => {
    render(<EntryHoverPreviewContext.Provider value={false}>{modal()}</EntryHoverPreviewContext.Provider>)
    openPickerAndHoverMacro()
    expect(screen.queryByTestId('entry-hover-bubble')).not.toBeInTheDocument()
  })

  it('shows nothing without a provider', () => {
    render(modal())
    openPickerAndHoverMacro()
    expect(screen.queryByTestId('entry-hover-bubble')).not.toBeInTheDocument()
  })

  it('closing the picker drops a pending open and a shown bubble, and reopening shows none until the next hover', () => {
    render(<EntryHoverPreviewContext.Provider value>{modal()}</EntryHoverPreviewContext.Provider>)
    openPickerAndHoverMacro()
    expect(screen.getByTestId('entry-hover-bubble')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('picker-close'))
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('entry-hover-bubble')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.mouseEnter(screen.getByTestId('macro-tile-0'))
    act(() => { vi.advanceTimersByTime(100) })
    fireEvent.click(screen.getByTestId('picker-close'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
    expect(screen.queryByTestId('entry-hover-bubble')).not.toBeInTheDocument()
  })
})
