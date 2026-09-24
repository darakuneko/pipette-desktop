// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Layer hover preview from encoder directions, wired through the REAL
// KeyboardPane / KeyboardWidget / EncoderWidget tree, and its coexistence
// with the entry hover bubble.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { KeymapPrimaryPane, type KeymapPrimaryPaneProps } from '../KeymapPrimaryPane'
import { KeyboardPane } from '../KeyboardPane'
import { EntryHoverPreviewContext } from '../../keycodes/entry-hover-context'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { UseViewMatrixModeReturn } from '../useViewMatrixMode'
import type { KleKey } from '../../../../shared/kle/types'
import type { MacroAction } from '../../../../preload/macro'

const CODES: Record<number, string> = {
  1: 'MO(1)', 2: 'LT1(KC_B)', 10: 'KC_A', 11: 'KC_1', 12: 'KC_2', 13: 'KC_3', 20: 'M0',
}

// LT keycodes render masked: the outer (hold) part on top, an inner rect
// for the tap keycode.
vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => CODES[code] ?? 'KC_NO',
  keycodeLabel: (kc: string) => kc,
  codeToLabel: (code: number) => CODES[code] ?? 'KC_NO',
  isMask: (kc: string) => /^LT\d+\(/.test(kc),
  findOuterKeycode: () => undefined,
  findInnerKeycode: (kc: string) => {
    const m = /\((.+)\)$/.exec(kc)
    return m ? { qmkId: m[1] } : undefined
  },
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
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

const makeEncoder = (idx: number, dir: number): KleKey => ({
  ...KEY_DEFAULTS, x: 1 + idx * 2 + dir, row: -1, col: -1, encoderIdx: idx, encoderDir: dir,
})

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

// Key (0,0): KC_A on layer 0, KC_2 on layer 1.
// Encoder 0: CW = MO(1), CCW = LT1(KC_B) on layer 0; KC_1 / KC_2 on layer 1.
// Encoder 1: CW = M0, CCW = KC_A on layer 0; KC_3 / KC_3 on layer 1.
const KEYMAP = new Map<string, number>([['0,0,0', 10], ['1,0,0', 12]])
const ENCODERS = new Map<string, number>([
  ['0,0,0', 1], ['0,0,1', 2], ['0,1,0', 20], ['0,1,1', 10],
  ['1,0,0', 11], ['1,0,1', 12], ['1,1,0', 13], ['1,1,1', 13],
])
const REAL_ENCODERS = (): Map<string, [string, string]> => new Map([['0', ['MO(1)', 'LT1(KC_B)']], ['1', ['M0', 'KC_A']]])
const MACROS: MacroAction[][] = [[{ type: 'tap', keycodes: [10] }]]

function baseProps(overrides: Partial<KeymapPrimaryPaneProps> = {}): KeymapPrimaryPaneProps {
  return {
    showPackTabs: false,
    packTab: 'pack',
    keys: [KEY_DEFAULTS, makeEncoder(0, 0), makeEncoder(0, 1), makeEncoder(1, 0), makeEncoder(1, 1)],
    layerKeycodes: new Map([['0,0', 'KC_A']]),
    layerEncoderKeycodes: REAL_ENCODERS(),
    remappedKeys: new Set(),
    layerEncoderRemapped: new Set(),
    matrixMode: false,
    pressedKeys: new Set(),
    everPressedKeys: new Set(),
    layoutOptions: new Map(),
    scale: 1,
    currentLayerLabel: 'Layer 0',
    primaryKeycodes: new Map([['0,0', 'KC_A']]),
    primaryEncoderKeycodes: REAL_ENCODERS(),
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
      layers: 2, currentLayer: 0, keymap: KEYMAP, encoderLayout: ENCODERS, encoderCount: 2,
      layerLabel: (n: number) => (n === 1 ? 'Nav' : `Layer ${n}`), deviceKey: 'uid', blocked: false,
    },
    hoverMacros: MACROS,
    ...overrides,
  }
}

function withSetting(node: ReactNode, enabled: boolean): JSX.Element {
  return <EntryHoverPreviewContext.Provider value={enabled}>{node}</EntryHoverPreviewContext.Provider>
}

function renderPane(overrides: Partial<KeymapPrimaryPaneProps> = {}, favHoverDetails = false) {
  return render(withSetting(<KeymapPrimaryPane {...baseProps(overrides)} />, favHoverDetails))
}

function encoder(container: HTMLElement, idx: number, dir: number): Element {
  const g = container.querySelector(`[data-encoder-pos="${idx},${dir}"]`)
  if (!g) throw new Error(`encoder ${idx},${dir} not rendered`)
  return g
}

function outerCircle(container: HTMLElement, idx: number, dir: number): Element {
  const circle = encoder(container, idx, dir).querySelector(':scope > circle')
  if (!circle) throw new Error(`outer circle of ${idx},${dir} not rendered`)
  return circle
}

function innerRect(container: HTMLElement, idx: number, dir: number): Element {
  const rect = encoder(container, idx, dir).querySelector(':scope > rect')
  if (!rect) throw new Error(`inner rect of ${idx},${dir} not rendered`)
  return rect
}

/** Moves the pointer from `from` to `to` (null = out of the window) the
 *  way the browser reports it: a mouseout on `from` whose relatedTarget is
 *  `to`, from which React derives the mouseleave / mouseenter events. */
function move(from: Element, to: Element | null): void {
  fireEvent.mouseOut(from, { relatedTarget: to })
}

function dwell(ms = SHARED_BUBBLE_OPEN_DELAY_MS): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function footer(): string | null {
  return screen.getByTestId('layer-label').textContent
}

function hoverAndDwell(container: HTMLElement, idx: number, dir: number): void {
  move(screen.getByTestId('primary-pane'), outerCircle(container, idx, dir))
  dwell()
}

describe('KeymapPrimaryPane — layer hover preview from encoders', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('previews from a CW layer key, keeping only that direction on the real layer, and restores on leave', () => {
    const { container } = renderPane()
    hoverAndDwell(container, 0, 0)
    expect(footer()).toBe('Preview - Nav')
    expect(encoder(container, 0, 0).textContent).toBe('MO(1)')
    expect(encoder(container, 0, 1).textContent).toBe('KC_2')
    expect(encoder(container, 1, 0).textContent).toBe('KC_3')
    expect(container.querySelector('[data-key-pos="0,0"]')?.textContent).toContain('KC_2')

    move(outerCircle(container, 0, 0), screen.getByTestId('primary-pane'))
    expect(footer()).toBe('Layer 0')
    expect(encoder(container, 0, 1).textContent).toContain('LT1(KC_B)')
    expect(encoder(container, 1, 0).textContent).toBe('M0')
  })

  it('previews from a masked CCW layer key from its outer part, keeping it real', () => {
    const { container } = renderPane()
    hoverAndDwell(container, 0, 1)
    expect(footer()).toBe('Preview - Nav')
    expect(encoder(container, 0, 1).textContent).toContain('KC_B')
    expect(encoder(container, 0, 0).textContent).toBe('KC_1')
  })

  it('a click on an encoder during a preview cancels it and acts on the real layer', () => {
    const handleEncoderClick = vi.fn()
    const { container } = renderPane({ handleEncoderClick })
    hoverAndDwell(container, 0, 0)
    fireEvent.click(encoder(container, 1, 0))
    expect(handleEncoderClick).toHaveBeenCalledTimes(1)
    expect(handleEncoderClick.mock.calls[0][1]).toBe(0)
    expect(footer()).toBe('Layer 0')
  })

  it.each([
    ['View Matrix mode', { viewMatrixMode: { ...viewMatrixMode, active: true } }],
    ['a multi-selection', { multiSelectedKeys: new Set(['0,0']) }],
    ['the popover or a picker selection', { layerHoverPreview: { ...baseProps().layerHoverPreview!, blocked: true } }],
    ['Auto Layer Preview off', { layerHoverPreview: { ...baseProps().layerHoverPreview!, enabled: false } }],
    ['the simulation tab', { showPackTabs: true, packTab: 'pack' as const }],
  ] as const)('does not preview during %s', (_label, overrides) => {
    const { container } = renderPane(overrides as Partial<KeymapPrimaryPaneProps>)
    fireEvent.mouseEnter(encoder(container, 0, 0))
    dwell()
    expect(container.textContent).not.toContain('Preview - Nav')
    expect(encoder(container, 0, 1).textContent).toContain('LT1(KC_B)')
  })

  describe('masked (LT) encoder directions start the preview only from the outer part', () => {
    it('entering straight into the inner rect never starts a preview and leaves no timer', () => {
      const { container } = renderPane()
      move(screen.getByTestId('primary-pane'), innerRect(container, 0, 1))
      expect(vi.getTimerCount()).toBe(0)
      dwell()
      expect(footer()).toBe('Layer 0')
    })

    it('moving from the outer part to the inner rect cancels a pending dwell and hides a visible preview', () => {
      const { container } = renderPane()
      move(screen.getByTestId('primary-pane'), outerCircle(container, 0, 1))
      dwell(100)
      move(outerCircle(container, 0, 1), innerRect(container, 0, 1))
      dwell()
      expect(footer()).toBe('Layer 0')
      expect(vi.getTimerCount()).toBe(0)

      move(innerRect(container, 0, 1), outerCircle(container, 0, 1))
      dwell()
      expect(footer()).toBe('Preview - Nav')
      move(outerCircle(container, 0, 1), innerRect(container, 0, 1))
      expect(footer()).toBe('Layer 0')
    })

    it('moving from the inner rect back to the outer part restarts the dwell', () => {
      const { container } = renderPane()
      move(screen.getByTestId('primary-pane'), innerRect(container, 0, 1))
      move(innerRect(container, 0, 1), outerCircle(container, 0, 1))
      dwell(SHARED_BUBBLE_OPEN_DELAY_MS - 1)
      expect(footer()).toBe('Layer 0')
      dwell(1)
      expect(footer()).toBe('Preview - Nav')
    })

    it('leaving through the inner rect, out of the window or onto another encoder, leaves no pending dwell', () => {
      const { container } = renderPane()
      move(screen.getByTestId('primary-pane'), outerCircle(container, 0, 1))
      move(outerCircle(container, 0, 1), innerRect(container, 0, 1))
      move(innerRect(container, 0, 1), null)
      expect(vi.getTimerCount()).toBe(0)

      move(screen.getByTestId('primary-pane'), outerCircle(container, 0, 1))
      move(outerCircle(container, 0, 1), innerRect(container, 0, 1))
      move(innerRect(container, 0, 1), outerCircle(container, 1, 1))
      dwell()
      expect(footer()).toBe('Layer 0')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('inner click and double-click during a preview reach the handlers with maskClicked=true', () => {
      const handleEncoderClick = vi.fn()
      const handleEncoderDoubleClick = vi.fn()
      const { container } = renderPane({ handleEncoderClick, handleEncoderDoubleClick })
      hoverAndDwell(container, 0, 1)
      expect(footer()).toBe('Preview - Nav')
      fireEvent.click(innerRect(container, 0, 1))
      expect(handleEncoderClick).toHaveBeenCalledTimes(1)
      expect(handleEncoderClick.mock.calls[0][1]).toBe(1)
      expect(handleEncoderClick.mock.calls[0][2]).toBe(true)
      expect(footer()).toBe('Layer 0')
      fireEvent.doubleClick(innerRect(container, 0, 1))
      expect(handleEncoderDoubleClick).toHaveBeenCalledTimes(1)
      expect(handleEncoderDoubleClick.mock.calls[0][3]).toBe(true)
    })

    it('works on the selected encoder direction too', () => {
      const { container } = renderPane({ selectedEncoder: { idx: 0, dir: 1 }, selectedKeycode: 'LT1(KC_B)' })
      move(screen.getByTestId('primary-pane'), innerRect(container, 0, 1))
      dwell()
      expect(footer()).toBe('Layer 0')
      move(innerRect(container, 0, 1), outerCircle(container, 0, 1))
      dwell()
      expect(footer()).toBe('Preview - Nav')
      move(outerCircle(container, 0, 1), innerRect(container, 0, 1))
      expect(footer()).toBe('Layer 0')
    })
  })

  describe('with the entry hover bubble', () => {
    it.each([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ])('Auto Layer Preview %s / Fav Hover Details %s work independently', (layerPreview, favHoverDetails) => {
      const { container } = renderPane(
        { layerHoverPreview: { ...baseProps().layerHoverPreview!, enabled: layerPreview } },
        favHoverDetails,
      )
      hoverAndDwell(container, 0, 0)
      expect(footer()).toBe(layerPreview ? 'Preview - Nav' : 'Layer 0')
      expect(screen.queryByTestId('entry-hover-bubble')).toBeNull()
      move(outerCircle(container, 0, 0), outerCircle(container, 1, 0))
      dwell()
      expect(footer()).toBe('Layer 0')
      expect(screen.queryByTestId('entry-hover-bubble') !== null).toBe(favHoverDetails)
    })

    it('shows the real-layer macro when moving on from a preview whose target layer draws something else there', () => {
      const { container } = renderPane({}, true)
      hoverAndDwell(container, 0, 0)
      // The preview draws layer 1's KC_3 on encoder 1 CW.
      expect(encoder(container, 1, 0).textContent).toBe('KC_3')
      move(outerCircle(container, 0, 0), outerCircle(container, 1, 0))
      dwell()
      expect(screen.getByTestId('entry-hover-bubble').firstElementChild?.textContent).toBe('M0')
      move(outerCircle(container, 1, 0), null)
      expect(screen.queryByTestId('entry-hover-bubble')).toBeNull()
    })

    it('an encoder edit cancels a visible encoder preview', () => {
      const { container, rerender } = renderPane()
      hoverAndDwell(container, 0, 0)
      expect(footer()).toBe('Preview - Nav')
      const encoderLayout = new Map(ENCODERS)
      rerender(withSetting(<KeymapPrimaryPane {...baseProps({
        layerHoverPreview: { ...baseProps().layerHoverPreview!, encoderLayout },
      })} />, false))
      expect(footer()).toBe('Layer 0')
    })
  })
})

describe('KeyboardPane without hoverOuterPartOnly (encoders)', () => {
  it('reports hover for the whole masked encoder direction, inner rect included', () => {
    const onEncoderHover = vi.fn()
    const onEncoderHoverEnd = vi.fn()
    const { container } = render(
      <KeyboardPane
        paneId="primary" isActive keys={[makeEncoder(0, 1)]}
        keycodes={new Map()} encoderKeycodes={new Map([['0', ['KC_A', 'LT1(KC_B)']]])}
        selectedKey={null} selectedEncoder={null} selectedMaskPart={false} selectedKeycode={null}
        remappedKeys={new Set()} layoutOptions={new Map()} scale={1} layerLabelTestId="layer-label"
        onEncoderClick={vi.fn()} onEncoderHover={onEncoderHover} onEncoderHoverEnd={onEncoderHoverEnd}
      />,
    )
    move(screen.getByTestId('primary-pane'), innerRect(container, 0, 1))
    expect(onEncoderHover).toHaveBeenCalledTimes(1)
    move(innerRect(container, 0, 1), outerCircle(container, 0, 1))
    expect(onEncoderHover).toHaveBeenCalledTimes(1)
    expect(onEncoderHoverEnd).not.toHaveBeenCalled()
  })
})
