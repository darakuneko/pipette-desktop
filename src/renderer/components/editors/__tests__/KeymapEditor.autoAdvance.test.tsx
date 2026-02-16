// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layer': `Layer ${opts?.number ?? ''}`,
        'editor.keymap.selectKey': 'Click a key to edit',
      }
      return map[key] ?? key
    },
  }),
}))

let capturedOnKeyClick: ((key: { row: number; col: number }, maskClicked?: boolean) => void) | undefined
let capturedOnKeyDoubleClick: ((key: { row: number; col: number }, rect: DOMRect, maskClicked?: boolean) => void) | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    onKeyClick?: (key: { row: number; col: number }, maskClicked?: boolean) => void
    onKeyDoubleClick?: (key: { row: number; col: number }, rect: DOMRect, maskClicked?: boolean) => void
  }) => {
    capturedOnKeyClick = props.onKeyClick
    capturedOnKeyDoubleClick = props.onKeyDoubleClick
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: {
    onKeycodeSelect?: (kc: { qmkId: string }) => void
    maskOnly?: boolean
  }) => (
    <div data-testid="tabbed-keycodes" data-mask-only={props.maskOnly ? 'true' : 'false'}>
      <button
        data-testid="kc-a"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'KC_A' })}
      >
        A
      </button>
      <button
        data-testid="kc-lt"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'LT(kc)' })}
      >
        LT
      </button>
    </div>
  ),
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: (props: {
    onKeycodeSelect?: (kc: { qmkId: string }) => void
    onRawKeycodeSelect?: (code: number) => void
    onClose?: () => void
  }) => {
    return (
      <div data-testid="key-popover">
        <button
          data-testid="popover-kc-a"
          onClick={() => props.onKeycodeSelect?.({ qmkId: 'KC_A' })}
        >
          Popover A
        </button>
        <button
          data-testid="popover-raw-5"
          onClick={() => props.onRawKeycodeSelect?.(5)}
        >
          Popover Raw 5
        </button>
      </div>
    )
  },
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => {
    if (code === 0x4200) return 'LT(2,KC_NO)'
    return `KC_${code}`
  },
  deserialize: (val: string) => {
    if (val === 'KC_A') return 4
    if (val === 'LT(kc)') return 0x4200
    return 0
  },
  isMask: (qmkId: string) => qmkId.startsWith('LT('),
  isLMKeycode: () => false,
  resolve: () => 0,
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
  isMacroKeycode: () => false,
  getMacroIndex: () => -1,
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

vi.mock('../TapDanceModal', () => ({ TapDanceModal: () => null }))
vi.mock('../MacroModal', () => ({ MacroModal: () => null }))

import { KeymapEditor } from '../KeymapEditor'

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
    { x: 1, y: 0, w: 1, h: 1, row: 0, col: 1, encoderIdx: -1, decal: false, labels: [] },
    { x: 2, y: 0, w: 1, h: 1, row: 0, col: 2, encoderIdx: -1, decal: false, labels: [] },
  ],
})

describe('KeymapEditor — auto advance', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)

  const mockRect = {
    top: 100, left: 200, bottom: 140, right: 260,
    width: 60, height: 40, x: 200, y: 100, toJSON: () => ({}),
  } as DOMRect

  const defaultProps = {
    layout: makeLayout(),
    layers: 1,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map([
      ['0,0,0', 4],
      ['0,0,1', 5],
      ['0,0,2', 6],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetEncoder,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
    capturedOnKeyDoubleClick = undefined
  })

  it('advances to next key after keycode selection when autoAdvance is true', async () => {
    render(<KeymapEditor {...defaultProps} autoAdvance={true} />)

    // Select first key
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Assign a keycode
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-a'))
    })

    // Should advance to next key [0,1]
    expect(screen.getByText('[0,1]')).toBeInTheDocument()
  })

  it('does NOT advance to next key when autoAdvance is false', async () => {
    render(<KeymapEditor {...defaultProps} autoAdvance={false} />)

    // Select first key
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Assign a keycode
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-a'))
    })

    // Should stay on the same key [0,0]
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
    expect(screen.queryByText('[0,1]')).not.toBeInTheDocument()
  })

  it('advances by default when autoAdvance prop is omitted', async () => {
    render(<KeymapEditor {...defaultProps} />)

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-a'))
    })

    // Default behavior should advance
    expect(screen.getByText('[0,1]')).toBeInTheDocument()
  })

  it('does NOT advance when keycode is selected via popover (onKeycodeSelect)', async () => {
    render(<KeymapEditor {...defaultProps} autoAdvance={true} />)

    // Double-click to open popover
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
    expect(screen.getByTestId('key-popover')).toBeInTheDocument()

    // Select keycode via popover
    await act(async () => {
      fireEvent.click(screen.getByTestId('popover-kc-a'))
    })

    // Should NOT advance — popover is an intentional edit mode
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
  })

  it('does NOT advance when raw keycode is selected via popover (onRawKeycodeSelect)', async () => {
    render(<KeymapEditor {...defaultProps} autoAdvance={true} />)

    // Double-click to open popover
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Select raw keycode via popover
    await act(async () => {
      fireEvent.click(screen.getByTestId('popover-raw-5'))
    })

    // Should NOT advance
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
  })

  it('does NOT advance to next key when masked keycode is assigned with autoAdvance', async () => {
    render(<KeymapEditor {...defaultProps} autoAdvance={true} />)

    // Select first key
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Assign a masked keycode (LT)
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-lt'))
    })

    // Should stay on the same key [0,0] (not advance to [0,1])
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
    expect(screen.queryByText('[0,1]')).not.toBeInTheDocument()
  })

  it('switches to mask mode after masked keycode is assigned with autoAdvance', async () => {
    // Use a stateful wrapper so keymap updates on setKey
    const Wrapper = () => {
      const [km, setKm] = useState(new Map(defaultProps.keymap))
      return (
        <KeymapEditor
          {...defaultProps}
          keymap={km}
          onSetKey={async (l, r, c, code) => setKm((prev) => new Map(prev).set(`${l},${r},${c}`, code))}
          autoAdvance={true}
        />
      )
    }
    render(<Wrapper />)

    // Select first key
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Assign a masked keycode (LT)
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-lt'))
    })

    // Should stay on [0,0] and switch to mask editing mode
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
    expect(screen.getByTestId('tabbed-keycodes').dataset.maskOnly).toBe('true')
  })

  it('advances to next key after setting inner byte of masked keycode', async () => {
    render(
      <KeymapEditor
        {...defaultProps}
        keymap={new Map([
          ['0,0,0', 0x4200], // LT(2,KC_NO) — a masked keycode
          ['0,0,1', 5],
          ['0,0,2', 6],
        ])}
        autoAdvance={true}
      />,
    )

    // Select first key
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }, true))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Assign a basic keycode to the inner byte
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-a'))
    })

    // Should advance to next key [0,1]
    expect(screen.getByText('[0,1]')).toBeInTheDocument()
  })

  it('calls onSetKey when raw keycode is applied via popover Code tab', async () => {
    render(<KeymapEditor {...defaultProps} autoAdvance={true} />)

    // Double-click to open popover
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))

    // Apply raw keycode via popover
    await act(async () => {
      fireEvent.click(screen.getByTestId('popover-raw-5'))
    })

    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 5)
  })
})
