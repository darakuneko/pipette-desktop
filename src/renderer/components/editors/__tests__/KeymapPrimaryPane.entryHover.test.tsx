// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Macro hover bubble wired through the REAL KeyboardPane / KeyboardWidget
// tree: dwelling on a key or encoder direction whose raw keycode on the
// current layer is a macro shows every action of that macro.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { KeymapPrimaryPane, type KeymapPrimaryPaneProps } from '../KeymapPrimaryPane'
import { EntryHoverPreviewContext } from '../../keycodes/entry-hover-context'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { UseViewMatrixModeReturn } from '../useViewMatrixMode'
import type { KleKey } from '../../../../shared/kle/types'
import type { MacroAction } from '../../../../preload/macro'

const CODES: Record<number, string> = {
  1: 'MO(1)', 10: 'KC_A', 11: 'KC_1', 12: 'KC_2', 13: 'KC_3', 20: 'M0', 21: 'M1', 22: 'M2', 25: 'M5',
}

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => CODES[code] ?? 'KC_NO',
  keycodeLabel: (kc: string) => kc,
  codeToLabel: (code: number) => CODES[code] ?? 'KC_NO',
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
  isTapDanceKeycode: (code: number) => (code & 0xff00) === 0x5700,
  getTapDanceIndex: (code: number) => code & 0xff,
  getMacroIndex: (code: number) => {
    const m = /^M(\d+)$/.exec(CODES[code] ?? '')
    return m ? Number(m[1]) : -1
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'editor.keymap.layerPreview' ? `Preview - ${String(opts?.label ?? '')}` : key,
  }),
}))

vi.mock('../KeymapPackTabs', () => ({
  KeymapPackTabs: () => <div data-testid="pack-tabs" />,
  KeymapPackApplyButton: () => null,
}))

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeKey = (col: number): KleKey => ({ ...KEY_DEFAULTS, x: col, col })
const makeEncoder = (dir: number): KleKey => ({ ...KEY_DEFAULTS, x: 5 + dir, row: -1, col: -1, encoderIdx: 0, encoderDir: dir })

const viewMatrixMode: UseViewMatrixModeReturn = {
  active: false,
  enter: vi.fn(),
  exit: vi.fn(),
  toggle: vi.fn(),
  selectedKeys: new Set(),
  selectKey: vi.fn(),
  toggleKeySelection: vi.fn(),
  extendSelection: vi.fn(),
  clearSelection: vi.fn(),
}

// Layer 0: MO(1), M0, KC_A, M1 (empty), M5 (no such macro), M2.
// Layer 1: KC_1, KC_2, M2, …
const KEYMAP = new Map<string, number>([
  ['0,0,0', 1], ['0,0,1', 20], ['0,0,2', 10], ['0,0,3', 21], ['0,0,4', 25], ['0,0,5', 22],
  ['1,0,0', 11], ['1,0,1', 12], ['1,0,2', 22], ['1,0,3', 13], ['1,0,4', 13], ['1,0,5', 13],
])
// Encoder 0 on layer 0: CW = M0, CCW = M2. On layer 1: CW = KC_1.
const ENCODERS = new Map<string, number>([['0,0,0', 20], ['0,0,1', 22], ['1,0,0', 11], ['1,0,1', 12]])
const MACROS: MacroAction[][] = [
  [{ type: 'tap', keycodes: [10] }, { type: 'text', text: 'hello world' }],
  [],
  [{ type: 'delay', delay: 40 }],
]
const LABELS: [string, string][] = [
  ['0,0', 'MO(1)'], ['0,1', 'M0'], ['0,2', 'KC_A'], ['0,3', 'M1'], ['0,4', 'M5'], ['0,5', 'M2'],
]

function baseProps(overrides: Partial<KeymapPrimaryPaneProps> = {}): KeymapPrimaryPaneProps {
  return {
    showPackTabs: false,
    packTab: 'pack',
    keys: [0, 1, 2, 3, 4, 5].map(makeKey).concat([makeEncoder(0), makeEncoder(1)]),
    layerKeycodes: new Map(LABELS),
    layerEncoderKeycodes: new Map([['0', ['M0', 'M2']]]),
    remappedKeys: new Set(),
    layerEncoderRemapped: new Set(),
    matrixMode: false,
    pressedKeys: new Set(),
    everPressedKeys: new Set(),
    layoutOptions: new Map(),
    scale: 1,
    currentLayerLabel: 'Layer 0',
    primaryKeycodes: new Map(LABELS),
    primaryEncoderKeycodes: new Map([['0', ['M0', 'M2']]]),
    selectedKey: null,
    selectedEncoder: null,
    selectedMaskPart: false,
    selectedKeycode: null,
    primaryRemappedKeys: new Set(),
    primaryRemappedEncoders: new Set(),
    viewMatrixMode,
    multiSelectedKeys: new Set(),
    handleViewMatrixKeyClick: vi.fn(),
    handleKeyClick: vi.fn(),
    handleKeyDoubleClick: vi.fn(),
    handleEncoderClick: vi.fn(),
    handleEncoderDoubleClick: vi.fn(),
    handleDeselect: vi.fn(),
    handlePackTabChange: vi.fn(),
    layerHoverPreview: {
      layers: 2, currentLayer: 0, keymap: KEYMAP, encoderLayout: ENCODERS, encoderCount: 1,
      layerLabel: (n: number) => (n === 1 ? 'Nav' : `Layer ${n}`), deviceKey: 'uid', blocked: false,
    },
    hoverMacros: MACROS,
    ...overrides,
  }
}

function withSetting(node: ReactNode, enabled = true): JSX.Element {
  return <EntryHoverPreviewContext.Provider value={enabled}>{node}</EntryHoverPreviewContext.Provider>
}

function renderPane(overrides: Partial<KeymapPrimaryPaneProps> = {}, enabled = true) {
  return render(withSetting(<KeymapPrimaryPane {...baseProps(overrides)} />, enabled))
}

function keyGroup(container: HTMLElement, col: number): Element {
  const g = container.querySelector(`[data-key-pos="0,${col}"]`)
  if (!g) throw new Error(`key 0,${col} not rendered`)
  return g
}

function encoderGroup(container: HTMLElement, dir: number): Element {
  const g = container.querySelector(`[data-encoder-pos="0,${dir}"]`)
  if (!g) throw new Error(`encoder 0,${dir} not rendered`)
  return g
}

function dwell(ms = SHARED_BUBBLE_OPEN_DELAY_MS): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function bubbleHeading(): string | null {
  return screen.queryByRole('tooltip')?.firstElementChild?.textContent ?? null
}

describe('KeymapPrimaryPane — entry hover bubble (macros)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows every action of a macro key after the dwell and closes on leave', () => {
    const { container } = renderPane()
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell(SHARED_BUBBLE_OPEN_DELAY_MS - 1)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    dwell(1)
    expect(bubbleHeading()).toBe('M0')
    expect(screen.getAllByTestId('entry-hover-line').map((el) => el.textContent)).toEqual(['TKC_A', 'Txhello world'])
    fireEvent.mouseLeave(keyGroup(container, 1))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it.each([
    ['a non-macro key', 2],
    ['an empty macro', 3],
    ['a macro the keyboard does not have', 4],
  ])('shows nothing for %s', (_label, col) => {
    const { container } = renderPane()
    fireEvent.mouseEnter(keyGroup(container, col))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('reads the raw keycode, not the displayed (remapped) legend', () => {
    const labels = new Map(LABELS)
    labels.set('0,1', 'Remapped')
    labels.set('0,2', 'M2')
    const { container } = renderPane({ primaryKeycodes: labels, layerKeycodes: labels })
    fireEvent.mouseEnter(keyGroup(container, 2))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseLeave(keyGroup(container, 2))
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(bubbleHeading()).toBe('M0')
  })

  it('shows the macro assigned to each encoder direction', () => {
    const { container } = renderPane()
    fireEvent.mouseEnter(encoderGroup(container, 0))
    dwell()
    expect(bubbleHeading()).toBe('M0')
    fireEvent.mouseLeave(encoderGroup(container, 0))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(encoderGroup(container, 1))
    dwell()
    expect(bubbleHeading()).toBe('M2')
    expect(screen.getAllByTestId('entry-hover-line').map((el) => el.textContent)).toEqual(['W40ms'])
  })

  it('uses the current layer for keys and encoders', () => {
    const { container } = renderPane({
      layerHoverPreview: { ...baseProps().layerHoverPreview!, currentLayer: 1 },
    })
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseLeave(keyGroup(container, 1))
    fireEvent.mouseEnter(encoderGroup(container, 0))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseLeave(encoderGroup(container, 0))
    fireEvent.mouseEnter(keyGroup(container, 2))
    dwell()
    expect(bubbleHeading()).toBe('M2')
  })

  it('a layer key on an encoder starts the layer hover preview, not the bubble', () => {
    const encoderLayout = new Map(ENCODERS)
    encoderLayout.set('0,0,0', 1)
    const { container } = renderPane({
      layerHoverPreview: { ...baseProps().layerHoverPreview!, encoderLayout },
    })
    fireEvent.mouseEnter(encoderGroup(container, 0))
    dwell()
    expect(screen.getByTestId('layer-label').textContent).toBe('Preview - Nav')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('works with the layer hover preview turned off, and leaves layer keys to the preview', () => {
    const { container, rerender } = renderPane({
      layerHoverPreview: { ...baseProps().layerHoverPreview!, enabled: false },
    })
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(bubbleHeading()).toBe('M0')
    fireEvent.mouseLeave(keyGroup(container, 1))

    // Preview on: a layer key previews and shows no bubble; a macro key
    // afterwards drops the preview and shows the bubble.
    rerender(withSetting(<KeymapPrimaryPane {...baseProps()} />))
    fireEvent.mouseEnter(keyGroup(container, 0))
    dwell()
    expect(screen.getByTestId('layer-label').textContent).toBe('Preview - Nav')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseLeave(keyGroup(container, 0))
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(screen.getByTestId('layer-label').textContent).toBe('Layer 0')
    expect(bubbleHeading()).toBe('M0')
  })

  it('the layer preview toggle alone turns off only the layer preview', () => {
    const { container } = renderPane({
      layerHoverPreview: { ...baseProps().layerHoverPreview!, enabled: false },
    })
    fireEvent.mouseEnter(keyGroup(container, 0))
    dwell()
    expect(screen.getByTestId('layer-label').textContent).toBe('Layer 0')
  })

  it.each([
    ['View Matrix mode', { viewMatrixMode: { ...viewMatrixMode, active: true } }],
    ['a multi-selection', { multiSelectedKeys: new Set(['0,2']) }],
    ['the popover or a picker selection', {
      layerHoverPreview: { ...baseProps().layerHoverPreview!, blocked: true },
    }],
    ['the simulation tab', { showPackTabs: true, packTab: 'pack' }],
    ['a pane without hover input', { layerHoverPreview: undefined }],
  ] as const)('shows nothing during %s', (_label, overrides) => {
    const { container } = renderPane(overrides as Partial<KeymapPrimaryPaneProps>)
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('works on the Base tab', () => {
    const { container } = renderPane({ showPackTabs: true, packTab: 'base' })
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(bubbleHeading()).toBe('M0')
  })

  it('shows nothing with the setting off or without a provider', () => {
    const { container, unmount } = renderPane({}, false)
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    unmount()

    const second = render(<KeymapPrimaryPane {...baseProps()} />)
    fireEvent.mouseEnter(keyGroup(second.container, 1))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('turning the setting off closes a shown bubble and drops a pending one', () => {
    const { container, rerender } = renderPane()
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    rerender(withSetting(<KeymapPrimaryPane {...baseProps()} />, false))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    rerender(withSetting(<KeymapPrimaryPane {...baseProps()} />))
    fireEvent.mouseLeave(keyGroup(container, 1))
    fireEvent.mouseEnter(keyGroup(container, 5))
    dwell(100)
    rerender(withSetting(<KeymapPrimaryPane {...baseProps()} />, false))
    rerender(withSetting(<KeymapPrimaryPane {...baseProps()} />))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('a layer switch or keymap edit closes the bubble', () => {
    const { container, rerender } = renderPane()
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    rerender(withSetting(<KeymapPrimaryPane {...baseProps({
      layerHoverPreview: { ...baseProps().layerHoverPreview!, currentLayer: 1 },
    })} />))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    rerender(withSetting(<KeymapPrimaryPane {...baseProps()} />))
    fireEvent.mouseLeave(keyGroup(container, 1))
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    expect(bubbleHeading()).toBe('M0')
    rerender(withSetting(<KeymapPrimaryPane {...baseProps({
      layerHoverPreview: { ...baseProps().layerHoverPreview!, keymap: new Map(KEYMAP) },
    })} />))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('moving quickly between macro keys shows one bubble for the last one', () => {
    const { container } = renderPane()
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell(200)
    fireEvent.mouseLeave(keyGroup(container, 1))
    fireEvent.mouseEnter(keyGroup(container, 5))
    dwell(200)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    dwell(100)
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(bubbleHeading()).toBe('M2')
  })

  it('keeps clicks and double-clicks on macro keys working', () => {
    const handleKeyClick = vi.fn()
    const handleKeyDoubleClick = vi.fn()
    const { container } = renderPane({ handleKeyClick, handleKeyDoubleClick })
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell()
    fireEvent.click(keyGroup(container, 1))
    fireEvent.doubleClick(keyGroup(container, 1))
    expect(handleKeyClick.mock.calls[0][0]).toMatchObject({ row: 0, col: 1 })
    expect(handleKeyDoubleClick.mock.calls[0][0]).toMatchObject({ row: 0, col: 1 })
  })
})

describe('KeymapPrimaryPane — entry hover bubble (Tap Dance keys)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // Layer 0: col 2 = TD(0), col 3 = TD(1) (not configured), col 4 = TD(5)
  // (no such entry). Encoder 0: CW = TD(0), CCW = M0.
  const TD_KEYMAP = new Map(KEYMAP)
  TD_KEYMAP.set('0,0,2', 0x5700)
  TD_KEYMAP.set('0,0,3', 0x5701)
  TD_KEYMAP.set('0,0,4', 0x5705)
  const TD_ENCODERS = new Map(ENCODERS)
  TD_ENCODERS.set('0,0,0', 0x5700)
  TD_ENCODERS.set('0,0,1', 20)
  const TAP_DANCE = [
    { onTap: 10, onHold: 11, onDoubleTap: 0, onTapHold: 0, tappingTerm: 190 },
    { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 },
  ]

  function tdProps(overrides: Partial<KeymapPrimaryPaneProps> = {}): Partial<KeymapPrimaryPaneProps> {
    return {
      layerHoverPreview: { ...baseProps().layerHoverPreview!, keymap: TD_KEYMAP, encoderLayout: TD_ENCODERS },
      hoverTapDance: TAP_DANCE,
      ...overrides,
    }
  }

  function lineValues(): string[] {
    return screen.getAllByTestId('entry-hover-line').map((el) => el.lastElementChild?.textContent ?? '')
  }

  it('shows a Tap Dance key in full, read from the raw keycode', () => {
    // The displayed legend says something else entirely.
    const labels = new Map(LABELS)
    labels.set('0,2', 'Remapped')
    const { container } = renderPane(tdProps({ primaryKeycodes: labels, layerKeycodes: labels }))
    fireEvent.mouseEnter(keyGroup(container, 2))
    dwell()
    expect(bubbleHeading()).toBe('editor.tapDance.editTitle')
    expect(lineValues()).toEqual(['KC_A', 'KC_1', 'editor.hoverDetails.none', 'editor.hoverDetails.none', '190'])
  })

  it.each([
    ['an unconfigured Tap Dance', 3],
    ['a Tap Dance the keyboard does not have', 4],
  ])('shows nothing for %s', (_label, col) => {
    const { container } = renderPane(tdProps())
    fireEvent.mouseEnter(keyGroup(container, col))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the Tap Dance and the macro on the two encoder directions', () => {
    const { container } = renderPane(tdProps())
    fireEvent.mouseEnter(encoderGroup(container, 0))
    dwell()
    expect(bubbleHeading()).toBe('editor.tapDance.editTitle')
    fireEvent.mouseLeave(encoderGroup(container, 0))
    fireEvent.mouseEnter(encoderGroup(container, 1))
    dwell()
    expect(bubbleHeading()).toBe('M0')
  })

  it.each([
    ['View Matrix mode', { viewMatrixMode: { ...viewMatrixMode, active: true } }],
    ['a multi-selection', { multiSelectedKeys: new Set(['0,0']) }],
    ['the popover or a picker selection', { blocked: true }],
  ] as const)('shows nothing during %s', (_label, overrides) => {
    const props = tdProps()
    const merged = 'blocked' in overrides
      ? { ...props, layerHoverPreview: { ...props.layerHoverPreview!, blocked: true } }
      : { ...props, ...overrides }
    const { container } = renderPane(merged as Partial<KeymapPrimaryPaneProps>)
    fireEvent.mouseEnter(keyGroup(container, 2))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows nothing with the setting off', () => {
    const { container } = renderPane(tdProps(), false)
    fireEvent.mouseEnter(keyGroup(container, 2))
    dwell()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('moving from a macro key to a Tap Dance key shows only the Tap Dance', () => {
    const { container } = renderPane(tdProps())
    fireEvent.mouseEnter(keyGroup(container, 1))
    dwell(200)
    fireEvent.mouseLeave(keyGroup(container, 1))
    fireEvent.mouseEnter(keyGroup(container, 2))
    dwell()
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(bubbleHeading()).toBe('editor.tapDance.editTitle')
  })
})
