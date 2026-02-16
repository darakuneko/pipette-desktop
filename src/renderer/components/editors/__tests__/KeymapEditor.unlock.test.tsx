// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layer': `Layer ${opts?.number ?? ''}`,
        'editor.keymap.selectKey': 'Click a key to edit',
        'editor.tapDance.editTitle': `TD(${opts?.index ?? ''})`,
        'common.save': 'Save',
        'common.close': 'Close',
      }
      return map[key] ?? key
    },
  }),
}))

let capturedOnKeyClick: ((key: { row: number; col: number }) => void) | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    onKeyClick?: (key: { row: number; col: number }) => void
  }) => {
    capturedOnKeyClick = props.onKeyClick
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

const QK_BOOT = 0x7c00
const MACRO_0 = 0x7700 // M0 keycode value

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: {
    onKeycodeSelect?: (kc: { qmkId: string }) => void
  }) => (
    <div data-testid="tabbed-keycodes">
      <button
        data-testid="kc-boot"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'QK_BOOT' })}
      >
        QK_BOOT
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

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => {
    if (code === QK_BOOT) return 'QK_BOOT'
    if (code === MACRO_0) return 'M0'
    return `KC_${code}`
  },
  deserialize: (val: string) => {
    if (val === 'QK_BOOT') return QK_BOOT
    if (val === 'KC_A') return 4
    if (val === 'M0') return MACRO_0
    return 0
  },
  isMask: () => false,
  isResetKeycode: (code: number) => code === QK_BOOT,
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
  isMacroKeycode: (code: number) => code === MACRO_0,
  getMacroIndex: (code: number) => (code === MACRO_0 ? 0 : -1),
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

vi.mock('../TapDanceModal', () => ({
  TapDanceModal: () => null,
}))

vi.mock('../MacroModal', () => ({
  MacroModal: () => <div data-testid="macro-modal">MacroModal</div>,
}))

import { KeymapEditor } from '../KeymapEditor'

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
    { x: 1, y: 0, w: 1, h: 1, row: 0, col: 1, encoderIdx: -1, decal: false, labels: [] },
  ],
})

describe('KeymapEditor — QK_BOOT unlock check', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)
  const onUnlock = vi.fn()

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
    onSetEncoder,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
  })

  it('calls onUnlock when assigning QK_BOOT while locked', () => {
    render(
      <KeymapEditor
        {...defaultProps}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('kc-boot'))

    expect(onUnlock).toHaveBeenCalledTimes(1)
    expect(onSetKey).not.toHaveBeenCalled()
  })

  it('does NOT call onUnlock when assigning non-boot keycode while locked', () => {
    render(
      <KeymapEditor
        {...defaultProps}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    fireEvent.click(screen.getByTestId('kc-a'))

    expect(onUnlock).not.toHaveBeenCalled()
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 4)
  })

  it('assigns QK_BOOT without unlock when already unlocked', () => {
    render(
      <KeymapEditor
        {...defaultProps}
        unlocked={true}
        onUnlock={onUnlock}
      />,
    )

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    fireEvent.click(screen.getByTestId('kc-boot'))

    expect(onUnlock).not.toHaveBeenCalled()
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, QK_BOOT)
  })

  it('executes pending action after unlock completes', () => {
    const { rerender } = render(
      <KeymapEditor
        {...defaultProps}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )

    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    fireEvent.click(screen.getByTestId('kc-boot'))

    expect(onSetKey).not.toHaveBeenCalled()

    // Simulate unlock completing by re-rendering with unlocked=true
    rerender(
      <KeymapEditor
        {...defaultProps}
        unlocked={true}
        onUnlock={onUnlock}
      />,
    )

    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, QK_BOOT)
  })

  it('does NOT call onUnlock when no key is selected (no-op)', () => {
    render(
      <KeymapEditor
        {...defaultProps}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )

    // No key selected — clicking QK_BOOT should be a no-op (not TD/macro)
    fireEvent.click(screen.getByTestId('kc-boot'))

    expect(onUnlock).not.toHaveBeenCalled()
    expect(onSetKey).not.toHaveBeenCalled()
  })
})

describe('KeymapEditor — macro unlock gate', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)
  const onUnlock = vi.fn()
  const onSaveMacros = vi.fn().mockResolvedValue(undefined)

  const macroProps = {
    layout: makeLayout(),
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map([['0,0,0', 4], ['0,0,1', 5]]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetEncoder,
    macroCount: 4,
    macroBufferSize: 256,
    macroBuffer: [0],
    vialProtocol: 9,
    onSaveMacros,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
  })

  it('calls onUnlock with macroWarning when clicking macro key while locked', () => {
    render(
      <KeymapEditor
        {...macroProps}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )

    // No key selected — clicking M0 triggers openMacroModal path
    fireEvent.click(screen.getByTestId('kc-m0'))

    expect(onUnlock).toHaveBeenCalledWith({ macroWarning: true })
    expect(screen.queryByTestId('macro-modal')).not.toBeInTheDocument()
  })

  it('opens macro modal when clicking macro key while unlocked', () => {
    render(
      <KeymapEditor
        {...macroProps}
        unlocked={true}
        onUnlock={onUnlock}
      />,
    )

    // No key selected — clicking M0 opens macro modal
    fireEvent.click(screen.getByTestId('kc-m0'))

    expect(onUnlock).not.toHaveBeenCalled()
    expect(screen.getByTestId('macro-modal')).toBeInTheDocument()
  })

  it('does not open macro modal when unlocked is undefined (backwards compat)', () => {
    render(
      <KeymapEditor
        {...macroProps}
        onUnlock={onUnlock}
      />,
    )

    // unlocked is undefined — should NOT gate (backwards compat)
    fireEvent.click(screen.getByTestId('kc-m0'))

    expect(onUnlock).not.toHaveBeenCalled()
    expect(screen.getByTestId('macro-modal')).toBeInTheDocument()
  })
})
