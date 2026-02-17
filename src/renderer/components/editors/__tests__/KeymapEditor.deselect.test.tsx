// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layer': `Layer ${opts?.number ?? ''}`,
        'editor.keymap.selectKey': 'Click a key to edit',
        'editor.tapDance.editTitle': `TD(${opts?.index ?? ''})`,
        'editor.tapDance.onTap': 'On Tap',
        'editor.tapDance.onHold': 'On Hold',
        'editor.tapDance.onDoubleTap': 'On Double Tap',
        'editor.tapDance.onTapHold': 'On Tap Hold',
        'editor.tapDance.tappingTerm': 'Tapping Term (ms)',
        'editor.macro.editTitle': `M${opts?.index ?? ''}`,
        'common.save': 'Save',
        'common.cancel': 'Cancel',
      }
      return map[key] ?? key
    },
  }),
}))

// Track the captured callbacks from KeyboardWidget
let capturedOnKeyClick: ((key: { row: number; col: number }) => void) | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    onKeyClick?: (key: { row: number; col: number }) => void
  }) => {
    capturedOnKeyClick = props.onKeyClick
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: {
    onKeycodeSelect?: (kc: { qmkId: string }) => void
    onBackgroundClick?: () => void
  }) => (
    <div data-testid="tabbed-keycodes" onClick={(e) => { if (e.target === e.currentTarget) props.onBackgroundClick?.() }}>
      <button
        data-testid="kc-td0"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'TD(0)' })}
      >
        TD(0)
      </button>
      <button
        data-testid="kc-a"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'KC_A' })}
      >
        A
      </button>
      <button
        data-testid="kc-m0"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'M0' })}
      >
        M0
      </button>
    </div>
  ),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => {
  const serializeFn = (code: number) => {
    if (code === 0x5700) return 'TD(0)'
    if (code === 0x5701) return 'TD(1)'
    if (code === 0x7700) return 'M0'
    if (code === 0x7701) return 'M1'
    return `KC_${code}`
  }
  return {
    serialize: serializeFn,
    deserialize: (val: string) => {
      if (val === 'TD(0)') return 0x5700
      if (val === 'TD(1)') return 0x5701
      if (val === 'M0') return 0x7700
      if (val === 'M1') return 0x7701
      if (val === 'KC_A') return 4
      return 0
    },
    isMask: () => false,
    isTapDanceKeycode: (code: number) => (code & 0xff00) === 0x5700,
    getTapDanceIndex: (code: number) => code & 0xff,
    isMacroKeycode: (code: number) => /^M\d+$/.test(serializeFn(code)),
    getMacroIndex: (code: number) => {
      const match = /^M(\d+)$/.exec(serializeFn(code))
      return match ? Number(match[1]) : -1
    },
    keycodeLabel: (qmkId: string) => qmkId,
    keycodeTooltip: (qmkId: string) => qmkId,
    isResetKeycode: () => false,
  }
})

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

vi.mock('../TapDanceModal', () => ({
  TapDanceModal: (props: { index: number; onClose: () => void }) => (
    <div data-testid="td-modal">
      <span>TD({props.index})</span>
      <button data-testid="td-modal-close" onClick={props.onClose}>
        Close
      </button>
    </div>
  ),
}))

vi.mock('../MacroModal', () => ({
  MacroModal: (props: { index: number; onClose: () => void }) => (
    <div data-testid="macro-modal">
      <span>M{props.index}</span>
      <button data-testid="macro-modal-close" onClick={props.onClose}>
        Close
      </button>
    </div>
  ),
}))

import { KeymapEditor } from '../KeymapEditor'
import type { TapDanceEntry } from '../../../../shared/types/protocol'

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
    { x: 1, y: 0, w: 1, h: 1, row: 0, col: 1, encoderIdx: -1, decal: false, labels: [] },
  ],
})

const makeTdEntry = (overrides?: Partial<TapDanceEntry>): TapDanceEntry => ({
  onTap: 0,
  onHold: 0,
  onDoubleTap: 0,
  onTapHold: 0,
  tappingTerm: 200,
  ...overrides,
})

describe('KeymapEditor — click-outside deselect', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)

  const defaultProps = {
    layout: makeLayout(),
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map([
      ['0,0,0', 4], // KC_A
      ['0,0,1', 5], // KC_B
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
  })

  it('deselects key when clicking on the keyboard container background', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Select a key via the captured callback
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))

    // The coordinate display should appear (selected state)
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Click on the scrollable container area (outside the keyboard frame)
    // keyboard-widget -> flex-center wrapper -> inner frame -> outer container
    const container = screen.getByTestId('keyboard-widget').parentElement!.parentElement!.parentElement!
    fireEvent.click(container)

    // Should be deselected — coordinate display disappears
    expect(screen.queryByText('[0,0]')).not.toBeInTheDocument()
  })

  it('deselects key when clicking on the keycode picker background', () => {
    render(<KeymapEditor {...defaultProps} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Click directly on the tabbed-keycodes container (background area)
    fireEvent.click(screen.getByTestId('tabbed-keycodes'))

    expect(screen.queryByText('[0,0]')).not.toBeInTheDocument()
  })

  it('deselects when clicking the keyboard frame background', () => {
    render(<KeymapEditor {...defaultProps} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Click on the keyboard pane background (empty area around keys)
    const frame = screen.getByTestId('keyboard-widget').parentElement!.parentElement!
    fireEvent.click(frame)

    // Should deselect
    expect(screen.queryByText('[0,0]')).not.toBeInTheDocument()
  })
})

describe('KeymapEditor — TD/Macro single-click modal', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)
  const onSetTapDanceEntry = vi.fn().mockResolvedValue(undefined)

  const tdEntries = [makeTdEntry(), makeTdEntry()]

  const propsWithTd = {
    layout: makeLayout(),
    layers: 2,
    keymap: new Map([
      ['0,0,0', 0x5700], // TD(0)
      ['0,0,1', 4], // KC_A
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    tapDanceEntries: tdEntries,
    onSetTapDanceEntry,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
  })

  it('opens TD modal when clicking TD(0) in keycode picker with no key selected', () => {
    render(<KeymapEditor {...propsWithTd} />)

    fireEvent.click(screen.getByTestId('kc-td0'))

    const tdModal = screen.getByTestId('td-modal')
    expect(tdModal).toBeInTheDocument()
    expect(within(tdModal).getByText('TD(0)')).toBeInTheDocument()
  })

  it('does NOT open TD modal when a key is selected (assigns keycode instead)', () => {
    render(<KeymapEditor {...propsWithTd} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 1 }))
    expect(screen.getByText('[0,1]')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('kc-td0'))

    expect(screen.queryByTestId('td-modal')).not.toBeInTheDocument()
  })

  it('does NOT open TD modal for non-TD keycodes', () => {
    render(<KeymapEditor {...propsWithTd} />)

    fireEvent.click(screen.getByTestId('kc-a'))

    expect(screen.queryByTestId('td-modal')).not.toBeInTheDocument()
  })

  it('does NOT open TD modal when tapDanceEntries is not provided', () => {
    const { tapDanceEntries: _, onSetTapDanceEntry: __, ...propsWithoutTd } = propsWithTd
    render(<KeymapEditor {...propsWithoutTd} />)

    fireEvent.click(screen.getByTestId('kc-td0'))
    expect(screen.queryByTestId('td-modal')).not.toBeInTheDocument()
  })

  it('does NOT open TD modal when clicking a TD key on the keymap', () => {
    render(<KeymapEditor {...propsWithTd} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))

    expect(screen.queryByTestId('td-modal')).not.toBeInTheDocument()
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
  })
})

describe('KeymapEditor — Macro single-click modal', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)
  const onSaveMacros = vi.fn().mockResolvedValue(undefined)

  const propsWithMacro = {
    layout: makeLayout(),
    layers: 2,
    keymap: new Map([
      ['0,0,0', 0x7700], // M0
      ['0,0,1', 4], // KC_A
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    macroCount: 16,
    macroBufferSize: 512,
    macroBuffer: [0],
    vialProtocol: 9,
    onSaveMacros,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
  })

  it('opens Macro modal when clicking M0 in keycode picker with no key selected', () => {
    render(<KeymapEditor {...propsWithMacro} />)

    fireEvent.click(screen.getByTestId('kc-m0'))

    const macroModal = screen.getByTestId('macro-modal')
    expect(macroModal).toBeInTheDocument()
    expect(within(macroModal).getByText('M0')).toBeInTheDocument()
  })

  it('does NOT open Macro modal when a key is selected (assigns keycode instead)', () => {
    render(<KeymapEditor {...propsWithMacro} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 1 }))
    expect(screen.getByText('[0,1]')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('kc-m0'))

    expect(screen.queryByTestId('macro-modal')).not.toBeInTheDocument()
  })

  it('does NOT open Macro modal for non-macro keycodes', () => {
    render(<KeymapEditor {...propsWithMacro} />)

    fireEvent.click(screen.getByTestId('kc-a'))

    expect(screen.queryByTestId('macro-modal')).not.toBeInTheDocument()
  })

  it('does NOT open Macro modal when macroCount is not provided', () => {
    const { macroCount: _, onSaveMacros: __, ...propsWithoutMacro } = propsWithMacro
    render(<KeymapEditor {...propsWithoutMacro} />)

    fireEvent.click(screen.getByTestId('kc-m0'))
    expect(screen.queryByTestId('macro-modal')).not.toBeInTheDocument()
  })

  it('does NOT open Macro modal when clicking a Macro key on the keymap', () => {
    render(<KeymapEditor {...propsWithMacro} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))

    expect(screen.queryByTestId('macro-modal')).not.toBeInTheDocument()
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
  })

  it('closes Macro modal via close button', () => {
    render(<KeymapEditor {...propsWithMacro} />)

    fireEvent.click(screen.getByTestId('kc-m0'))
    expect(screen.getByTestId('macro-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('macro-modal-close'))
    expect(screen.queryByTestId('macro-modal')).not.toBeInTheDocument()
  })
})
