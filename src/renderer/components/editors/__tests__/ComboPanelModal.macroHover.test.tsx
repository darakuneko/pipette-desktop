// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// The small key picker inside a modal renders the real Macro tab tiles
// (`useTileContentOverride` → `MacroTileGrid`), so hovering a tile there
// shows the macro hover bubble when the setting is on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ComboPanelModal } from '../ComboPanelModal'
import { MacroHoverPreviewContext } from '../../keycodes/macro-hover-context'
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

// Shows the Macro tab override the modal hands the picker.
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: ({ tabContentOverride }: { tabContentOverride?: Record<string, ReactNode> }) => (
    <div data-testid="tabbed-keycodes">{tabContentOverride?.macro}</div>
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

describe('ComboPanelModal — macro hover bubble in the picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.vialAPI = {
      ...window.vialAPI,
      favoriteStoreList: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.vialAPI
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows the full macro above the modal when the setting is on', () => {
    render(<MacroHoverPreviewContext.Provider value>{modal()}</MacroHoverPreviewContext.Provider>)
    openPickerAndHoverMacro()
    const bubble = screen.getByTestId('macro-hover-bubble')
    expect(bubble).toHaveTextContent('M0')
    expect(screen.getAllByTestId('macro-hover-line').map((el) => el.textContent)).toEqual(['TKC_4', 'Txhi there'])
    expect(bubble.parentElement).toBe(document.body)
    expect(bubble.className.split(' ')).toContain('z-70')
  })

  it('shows nothing with the setting off', () => {
    render(<MacroHoverPreviewContext.Provider value={false}>{modal()}</MacroHoverPreviewContext.Provider>)
    openPickerAndHoverMacro()
    expect(screen.queryByTestId('macro-hover-bubble')).not.toBeInTheDocument()
  })

  it('shows nothing without a provider', () => {
    render(modal())
    openPickerAndHoverMacro()
    expect(screen.queryByTestId('macro-hover-bubble')).not.toBeInTheDocument()
  })
})
