// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Layer hover preview wired through the REAL KeyboardPane / KeyboardWidget
// tree: dwelling on a layer key redraws the board with the target layer and
// the footer reads "Preview - <layer>"; clicks act on the real layer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import { KeymapPrimaryPane, type KeymapPrimaryPaneProps } from '../KeymapPrimaryPane'
import { KeyboardPane } from '../KeyboardPane'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { UseViewMatrixModeReturn } from '../useViewMatrixMode'
import type { KleKey } from '../../../../shared/kle/types'

const CODES: Record<number, string> = { 1: 'MO(1)', 2: 'LT1(KC_B)', 10: 'KC_A', 11: 'KC_1', 12: 'KC_2', 13: 'KC_3' }

// LT keys render masked: the outer (hold) part on top, an inner rect for
// the tap keycode.
vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => CODES[code] ?? 'KC_NO',
  keycodeLabel: (kc: string) => kc,
  isMask: (kc: string) => /^LT\d+\(/.test(kc),
  findOuterKeycode: () => undefined,
  findInnerKeycode: (kc: string) => {
    const m = /\((.+)\)$/.exec(kc)
    return m ? { qmkId: m[1] } : undefined
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

function makeKey(col: number): KleKey {
  return {
    x: col, y: 0, width: 1, height: 1, row: 0, col,
    encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
    decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
    rotation: 0, rotationX: 0, rotationY: 0, color: '',
    textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
  }
}

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

// Layer 0: MO(1), KC_A, LT1(KC_B). Layer 1: KC_1, KC_2, KC_3.
const KEYMAP = new Map<string, number>([
  ['0,0,0', 1], ['0,0,1', 10], ['0,0,2', 2],
  ['1,0,0', 11], ['1,0,1', 12], ['1,0,2', 13],
])
const LAYER0_LABELS: [string, string][] = [['0,0', 'MO(1)'], ['0,1', 'KC_A'], ['0,2', 'LT1(KC_B)']]

function baseProps(overrides: Partial<KeymapPrimaryPaneProps> = {}): KeymapPrimaryPaneProps {
  return {
    showPackTabs: false,
    packTab: 'pack',
    keys: [makeKey(0), makeKey(1), makeKey(2)],
    layerKeycodes: new Map(LAYER0_LABELS),
    layerEncoderKeycodes: new Map(),
    remappedKeys: new Set(),
    layerEncoderRemapped: new Set(),
    matrixMode: false,
    pressedKeys: new Set(),
    everPressedKeys: new Set(),
    layoutOptions: new Map(),
    scale: 1,
    currentLayerLabel: 'Layer 0',
    primaryKeycodes: new Map(LAYER0_LABELS),
    primaryEncoderKeycodes: new Map(),
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
      layers: 2, currentLayer: 0, keymap: KEYMAP, encoderLayout: new Map(), encoderCount: 0,
      layerLabel: (n: number) => (n === 1 ? 'Nav' : `Layer ${n}`), deviceKey: 'uid', blocked: false,
    },
    ...overrides,
  }
}

function keyGroup(container: HTMLElement, col: number): Element {
  const g = container.querySelector(`[data-key-pos="0,${col}"]`)
  if (!g) throw new Error(`key 0,${col} not rendered`)
  return g
}

function outerRect(container: HTMLElement, col: number): Element {
  const rect = keyGroup(container, col).querySelector('rect:not([data-testid])')
  if (!rect) throw new Error(`outer rect of 0,${col} not rendered`)
  return rect
}

function innerRect(container: HTMLElement, col: number): Element | null {
  return keyGroup(container, col).querySelector('[data-testid="mask-inner-rect"]')
}

/** Moves the pointer from `from` to `to` the way the browser reports it:
 *  a mouseout on `from` whose relatedTarget is `to`, from which React
 *  derives the mouseleave / mouseenter events. */
function move(from: Element, to: Element): void {
  fireEvent.mouseOut(from, { relatedTarget: to })
}

function dwell(): void {
  act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
}

function footer(): string | null {
  return screen.getByTestId('layer-label').textContent
}

function hoverAndDwell(container: HTMLElement, col: number): void {
  fireEvent.mouseEnter(keyGroup(container, col))
  act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
}

describe('KeymapPrimaryPane — layer hover preview', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('renders the target layer and the Preview footer after the dwell, and restores on leave', () => {
    const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
    expect(screen.getByTestId('layer-label').textContent).toBe('Layer 0')

    hoverAndDwell(container, 0)
    // The hovered key itself keeps its real-layer content.
    expect(keyGroup(container, 0).textContent).toContain('MO(1)')
    expect(keyGroup(container, 1).textContent).toContain('KC_2')
    expect(keyGroup(container, 2).textContent).toContain('KC_3')
    expect(screen.getByTestId('layer-label').textContent).toBe('Preview - Nav')

    fireEvent.mouseLeave(keyGroup(container, 0))
    expect(keyGroup(container, 1).textContent).toContain('KC_A')
    expect(screen.getByTestId('layer-label').textContent).toBe('Layer 0')
  })

  it('clicking during a preview cancels it and acts on the real layer', () => {
    const handleKeyClick = vi.fn()
    const { container } = render(<KeymapPrimaryPane {...baseProps({ handleKeyClick })} />)
    hoverAndDwell(container, 0)
    expect(screen.getByTestId('layer-label').textContent).toBe('Preview - Nav')

    fireEvent.click(keyGroup(container, 1))
    expect(handleKeyClick).toHaveBeenCalledTimes(1)
    expect(handleKeyClick.mock.calls[0][0]).toMatchObject({ row: 0, col: 1 })
    expect(screen.getByTestId('layer-label').textContent).toBe('Layer 0')
    expect(keyGroup(container, 1).textContent).toContain('KC_A')
  })

  it('double-clicking during a preview cancels it and acts on the real layer', () => {
    const handleKeyDoubleClick = vi.fn()
    const { container } = render(<KeymapPrimaryPane {...baseProps({ handleKeyDoubleClick })} />)
    hoverAndDwell(container, 0)
    expect(screen.getByTestId('layer-label').textContent).toBe('Preview - Nav')

    fireEvent.doubleClick(keyGroup(container, 1))
    expect(handleKeyDoubleClick).toHaveBeenCalledTimes(1)
    expect(handleKeyDoubleClick.mock.calls[0][0]).toMatchObject({ row: 0, col: 1 })
    expect(screen.getByTestId('layer-label').textContent).toBe('Layer 0')
    expect(keyGroup(container, 1).textContent).toContain('KC_A')
  })

  it.each([
    ['View Matrix mode', { viewMatrixMode: { ...viewMatrixMode, active: true } }],
    ['a multi-selection', { multiSelectedKeys: new Set(['0,1']) }],
    ['the popover or a picker selection', {
      layerHoverPreview: { ...baseProps().layerHoverPreview!, blocked: true },
    }],
  ] as const)('does not preview during %s', (_label, overrides) => {
    const { container } = render(<KeymapPrimaryPane {...baseProps(overrides as Partial<KeymapPrimaryPaneProps>)} />)
    hoverAndDwell(container, 0)
    expect(keyGroup(container, 1).textContent).toContain('KC_A')
    expect(container.textContent).not.toContain('Preview - ')
  })

  it('does not preview without preview input', () => {
    const { container } = render(<KeymapPrimaryPane {...baseProps({ layerHoverPreview: undefined })} />)
    hoverAndDwell(container, 0)
    expect(keyGroup(container, 1).textContent).toContain('KC_A')
  })

  describe('masked (LT) keys start the preview only from the outer part', () => {
    it('entering straight into the inner rect never starts a preview', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
      move(screen.getByTestId('primary-pane'), innerRect(container, 2)!)
      dwell()
      expect(footer()).toBe('Layer 0')
    })

    it('moving from the outer part to the inner rect cancels a pending dwell', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
      move(screen.getByTestId('primary-pane'), outerRect(container, 2))
      act(() => { vi.advanceTimersByTime(100) })
      move(outerRect(container, 2), innerRect(container, 2)!)
      dwell()
      expect(footer()).toBe('Layer 0')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('moving from the outer part to the inner rect hides a visible preview', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
      move(screen.getByTestId('primary-pane'), outerRect(container, 2))
      dwell()
      expect(footer()).toBe('Preview - Nav')
      // The hovered key still shows its real (masked) content, so its
      // inner rect is there to move onto.
      expect(keyGroup(container, 2).textContent).toContain('KC_B')
      move(outerRect(container, 2), innerRect(container, 2)!)
      expect(footer()).toBe('Layer 0')
      expect(keyGroup(container, 1).textContent).toContain('KC_A')
    })

    it('moving from the inner rect back to the outer part restarts the dwell', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
      move(screen.getByTestId('primary-pane'), innerRect(container, 2)!)
      move(innerRect(container, 2)!, outerRect(container, 2))
      act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS - 1) })
      expect(footer()).toBe('Layer 0')
      act(() => { vi.advanceTimersByTime(1) })
      expect(footer()).toBe('Preview - Nav')
    })

    it('leaving through the inner rect, to outside or to another key, leaves no pending dwell', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
      const pane = screen.getByTestId('primary-pane')
      move(pane, outerRect(container, 2))
      move(outerRect(container, 2), innerRect(container, 2)!)
      move(innerRect(container, 2)!, pane)
      expect(vi.getTimerCount()).toBe(0)

      move(pane, outerRect(container, 2))
      move(outerRect(container, 2), innerRect(container, 2)!)
      move(innerRect(container, 2)!, outerRect(container, 1))
      dwell()
      expect(footer()).toBe('Layer 0')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('inner click and double-click during a preview reach the handlers with maskClicked=true', () => {
      const handleKeyClick = vi.fn()
      const handleKeyDoubleClick = vi.fn()
      const { container } = render(<KeymapPrimaryPane {...baseProps({ handleKeyClick, handleKeyDoubleClick })} />)
      move(screen.getByTestId('primary-pane'), outerRect(container, 2))
      dwell()
      expect(footer()).toBe('Preview - Nav')
      const inner = innerRect(container, 2)
      expect(inner).not.toBeNull()

      fireEvent.click(inner!)
      expect(handleKeyClick).toHaveBeenCalledTimes(1)
      expect(handleKeyClick.mock.calls[0][0]).toMatchObject({ row: 0, col: 2 })
      expect(handleKeyClick.mock.calls[0][1]).toBe(true)
      expect(footer()).toBe('Layer 0')

      fireEvent.doubleClick(innerRect(container, 2)!)
      expect(handleKeyDoubleClick).toHaveBeenCalledTimes(1)
      expect(handleKeyDoubleClick.mock.calls[0][0]).toMatchObject({ row: 0, col: 2 })
      expect(handleKeyDoubleClick.mock.calls[0][2]).toBe(true)
    })

    it('works on the selected key too', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps({
        selectedKey: { row: 0, col: 2 }, selectedKeycode: 'LT1(KC_B)',
      })} />)
      const pane = screen.getByTestId('primary-pane')
      move(pane, innerRect(container, 2)!)
      dwell()
      expect(footer()).toBe('Layer 0')
      move(innerRect(container, 2)!, outerRect(container, 2))
      dwell()
      expect(footer()).toBe('Preview - Nav')
      move(outerRect(container, 2), innerRect(container, 2)!)
      expect(footer()).toBe('Layer 0')
    })

    it('keeps the right source key when moving between two keys targeting the same layer', () => {
      const { container } = render(<KeymapPrimaryPane {...baseProps()} />)
      move(screen.getByTestId('primary-pane'), outerRect(container, 0))
      dwell()
      expect(keyGroup(container, 0).textContent).toContain('MO(1)')
      expect(keyGroup(container, 2).textContent).toContain('KC_3')

      move(outerRect(container, 0), outerRect(container, 2))
      dwell()
      expect(footer()).toBe('Preview - Nav')
      expect(keyGroup(container, 0).textContent).toContain('KC_1')
      expect(keyGroup(container, 2).textContent).toContain('LT1(KC_B)')
      expect(innerRect(container, 2)).not.toBeNull()
    })
  })
})

describe('KeyboardPane without hoverOuterPartOnly', () => {
  it('reports hover for the whole masked key, inner rect included', () => {
    const onKeyHover = vi.fn()
    const onKeyHoverEnd = vi.fn()
    const { container } = render(
      <KeyboardPane
        paneId="primary" isActive keys={[makeKey(0)]}
        keycodes={new Map([['0,0', 'LT1(KC_B)']])} encoderKeycodes={new Map()}
        selectedKey={null} selectedEncoder={null} selectedMaskPart={false} selectedKeycode={null}
        remappedKeys={new Set()} layoutOptions={new Map()} scale={1} layerLabelTestId="layer-label"
        onKeyClick={vi.fn()} onKeyHover={onKeyHover} onKeyHoverEnd={onKeyHoverEnd}
      />,
    )
    const pane = screen.getByTestId('primary-pane')
    move(pane, innerRect(container, 0)!)
    expect(onKeyHover).toHaveBeenCalledTimes(1)
    move(innerRect(container, 0)!, outerRect(container, 0))
    expect(onKeyHover).toHaveBeenCalledTimes(1)
    expect(onKeyHoverEnd).not.toHaveBeenCalled()
  })
})
