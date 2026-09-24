// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// The entry hover bubble inside a real TabbedKeycodes: one bubble per
// picker, rendered by the picker and gone with it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TabbedKeycodes } from '../TabbedKeycodes'
import { EntryHoverPreviewContext } from '../entry-hover-context'
import { useTileContentOverride } from '../../../hooks/useTileContentOverride'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { MacroAction } from '../../../../preload/macro'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { defaultBasicViewType: 'list', defaultSplitKeyMode: 'flat' }, loading: false, set: vi.fn() }),
}))

// The Macro tab keeps its (basic) keycode under maskOnly; Behavior's
// keycode is not basic, so maskOnly removes that tab.
vi.mock('../categories', () => ({
  KEYCODE_CATEGORIES: [
    { id: 'macro', labelKey: 'keycodes.macro', getKeycodes: () => [{ qmkId: 'M0', label: 'M0', hidden: false }] },
    { id: 'behavior', labelKey: 'keycodes.behavior', getKeycodes: () => [{ qmkId: 'QK_BOOT', label: 'Boot', hidden: false }] },
  ],
  groupByLayoutRow: () => [],
}))

vi.mock('../../../../shared/keycodes/keycodes', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../shared/keycodes/keycodes')>(),
  isBasic: (qmkId: string) => qmkId !== 'QK_BOOT',
  codeToLabel: (code: number) => `code-${code}`,
}))

const MACROS: MacroAction[][] = [[{ type: 'tap', keycodes: [4] }], [{ type: 'delay', delay: 30 }]]

function noop(): void {}

interface PickerProps {
  maskOnly?: boolean
  lmMode?: boolean
  macros?: MacroAction[][]
}

function PickerBody({ maskOnly = false, lmMode = false, macros = MACROS }: PickerProps) {
  const override = useTileContentOverride({ deserializedMacros: macros, onSelect: noop })
  return <TabbedKeycodes tabContentOverride={override} maskOnly={maskOnly} lmMode={lmMode} />
}

function Picker(props: PickerProps) {
  return <EntryHoverPreviewContext.Provider value><PickerBody {...props} /></EntryHoverPreviewContext.Provider>
}

function dwell(ms = SHARED_BUBBLE_OPEN_DELAY_MS): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function bubble(): HTMLElement | null {
  return screen.queryByTestId('entry-hover-bubble')
}

function hoverMacro(i: number): void {
  fireEvent.mouseEnter(screen.getByTestId(`macro-tile-${i}`))
}

describe('TabbedKeycodes — entry hover bubble', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows one bubble for the picker, portaled outside it', () => {
    const { container } = render(<Picker />)
    hoverMacro(0)
    dwell()
    hoverMacro(1)
    dwell()
    expect(screen.getAllByTestId('entry-hover-bubble')).toHaveLength(1)
    expect(bubble()?.firstElementChild?.textContent).toBe('M1')
    expect(container.contains(bubble())).toBe(false)
  })

  it('updates a shown bubble live when the hovered entry is edited', () => {
    const { rerender } = render(<Picker />)
    hoverMacro(1)
    dwell()
    rerender(<Picker macros={[MACROS[0], [{ type: 'delay', delay: 75 }]]} />)
    expect(bubble()).toHaveTextContent('75')
  })

  it('unmounting the picker drops a pending open and a shown bubble', () => {
    const first = render(<Picker />)
    hoverMacro(0)
    dwell()
    first.unmount()
    expect(bubble()).toBeNull()

    const second = render(<Picker />)
    hoverMacro(0)
    dwell(100)
    second.unmount()
    dwell()
    expect(bubble()).toBeNull()
  })
})
