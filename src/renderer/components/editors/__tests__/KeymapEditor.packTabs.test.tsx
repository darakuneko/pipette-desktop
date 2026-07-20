// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Plan-qwerty-select-no-rewrite v7 — シミュレーションタブ方式: tab visibility
// (gated by the SINGLE `remapKind === 'simulated'` predicate), default tab,
// UID-change reset, read-only enforcement on the simulation tab, full
// editability on Base, and the Apply button / confirm modal wiring.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'common.cancel': 'Cancel',
        'editor.keymap.layer': `Layer ${opts?.number ?? ''}`,
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.selectKey': 'Click a key to edit',
        'keyLabels.keymapApply.applyButton': 'Apply',
        'keyLabels.keymapApply.baseTab': 'Base',
        'keyLabels.keymapApply.tabsLabel': 'Keymap view',
        'keyLabels.keymapApply.errorPartial': 'Some keys could not be rewritten.',
        'keyLabels.keymapApply.title': `Apply ${String(opts?.name ?? '')}?`,
        'keyLabels.keymapApply.saveRecommendation': 'Save first.',
        'keyLabels.keymapApply.apply': 'Rewrite Keymap',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

let capturedWidgetProps: Array<Record<string, unknown>> = []
vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: Record<string, unknown>) => {
    capturedWidgetProps.push(props)
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

let capturedTabbedProps: Record<string, unknown> = {}
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: Record<string, unknown>) => {
    capturedTabbedProps = props
    return <div data-testid="tabbed-keycodes">TabbedKeycodes</div>
  },
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: () => <div data-testid="key-popover">KeyPopover</div>,
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: () => 0,
  isMask: () => false,
  isLMKeycode: () => false,
  resolve: () => 0,
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
  isMacroKeycode: () => false,
  getMacroIndex: () => -1,
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
  findInnerKeycode: () => undefined,
}))

vi.mock('../../keycodes/ModifierCheckboxStrip', () => ({
  ModifierCheckboxStrip: () => null,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

vi.mock('../TapDanceModal', () => ({ TapDanceModal: () => null }))
vi.mock('../MacroModal', () => ({ MacroModal: () => null }))
vi.mock('../TypingTestPane', () => ({
  TypingTestPane: () => <div data-testid="typing-test-pane">TypingTestPane</div>,
}))

import { KeymapEditor } from '../KeymapEditor'
import type { KleKey } from '../../../../shared/kle/types'

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeKey = (x: number, col: number): KleKey => ({ ...KEY_DEFAULTS, x, col })
const makeLayout = () => ({ keys: [makeKey(0, 0), makeKey(1, 1), makeKey(2, 2)] })

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    keyboardUid: 'uid-1',
    layout: makeLayout(),
    layers: 1,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map<string, number>([
      ['0,0,0', 4],
      ['0,0,1', 5],
      ['0,0,2', 6],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function lastWidgetProps(): Record<string, unknown> {
  return capturedWidgetProps[capturedWidgetProps.length - 1]
}

beforeEach(() => {
  capturedWidgetProps = []
  capturedTabbedProps = {}
})

describe('KeymapEditor — pack tabs (Plan-qwerty-select-no-rewrite v7)', () => {
  describe('tab visibility (SINGLE PREDICATE: remapKind)', () => {
    it('renders no tabs when remapKind is omitted (defaults to actual)', () => {
      const { queryByTestId } = render(<KeymapEditor {...defaultProps()} />)
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()
    })

    it('renders no tabs when remapKind is "actual" (JIS-type deviation pack — unaffected by this feature)', () => {
      const { queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="actual" remapLabel={(id) => `${id}!`} isRemapped={() => true} />,
      )
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()
      // Actual-tint display still works unaffected — remapLabel is still
      // threaded straight through to the single (non-tabbed) pane.
      expect(lastWidgetProps().remapLabel).toBeTypeOf('function')
    })

    it('renders the tabs when remapKind is "simulated"', () => {
      const { getByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      expect(getByTestId('keymap-pack-tabs')).toBeTruthy()
      expect(getByTestId('keymap-pack-tab-simulation')).toHaveTextContent('Dvorak')
      expect(getByTestId('keymap-pack-tab-base')).toHaveTextContent('Base')
    })
  })

  describe('default tab + UID reset', () => {
    it('defaults to the simulation (pack) tab: Apply button visible, remap-simulated applied, pane read-only', () => {
      const { container, queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={vi.fn()} />,
      )
      expect(queryByTestId('keymap-pack-apply-button')).toBeTruthy()
      expect(container.querySelector('[data-testid="keymap-surface"]')).toHaveClass('remap-simulated')
      expect(lastWidgetProps().readOnly).toBe(true)
      expect(lastWidgetProps().onKeyClick).toBeUndefined()
    })

    it('switching to Base and then changing keyboardUid resets back to the simulation tab', () => {
      const onRequestKeymapApply = vi.fn()
      const { getByTestId, rerender, queryByTestId, container } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply} />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      expect(queryByTestId('keymap-pack-apply-button')).toBeNull()
      expect(lastWidgetProps().readOnly).toBe(false)

      // A different keyboardUid (reconnect to another keyboard) — the
      // editor does NOT remount, so this must be observed via the existing
      // uid-watching effect (KeymapEditor ~line 172), same one that clears
      // history / exits View Matrix mode.
      rerender(
        <KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply} />,
      )
      expect(queryByTestId('keymap-pack-apply-button')).toBeTruthy()
      expect(container.querySelector('[data-testid="keymap-surface"]')).toHaveClass('remap-simulated')
      expect(lastWidgetProps().readOnly).toBe(true)
    })
  })

  describe('read-only enforcement on the simulation tab', () => {
    function renderSimulated() {
      return render(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />)
    }

    it('blocks key click/double-click and encoder click/double-click handlers from reaching KeyboardWidget', () => {
      renderSimulated()
      const props = lastWidgetProps()
      expect(props.onKeyClick).toBeUndefined()
      expect(props.onKeyDoubleClick).toBeUndefined()
      expect(props.onEncoderClick).toBeUndefined()
      expect(props.onEncoderDoubleClick).toBeUndefined()
      expect(props.readOnly).toBe(true)
    })

    it('blocks multi-select — no selection state or multiSelectedKeys reach the pane', () => {
      renderSimulated()
      const props = lastWidgetProps()
      expect(props.selectedKey).toBeNull()
      expect(props.selectedEncoder).toBeNull()
      expect(props.multiSelectedKeys).toBeUndefined()
    })

    it('blocks picker click-to-paste and picker multi-select', () => {
      renderSimulated()
      expect(capturedTabbedProps.onKeycodeSelect).toBeUndefined()
      expect(capturedTabbedProps.onKeycodeMultiSelect).toBeUndefined()
      expect(capturedTabbedProps.pickerMultiSelectEnabled).toBe(false)
    })

    it('the Base tab is fully editable: click handlers, multi-select, and picker paste are all wired', () => {
      const { getByTestId } = renderSimulated()
      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      const props = lastWidgetProps()
      expect(props.onKeyClick).toBeTypeOf('function')
      expect(props.onKeyDoubleClick).toBeTypeOf('function')
      expect(props.readOnly).toBe(false)
      expect(capturedTabbedProps.onKeycodeSelect).toBeTypeOf('function')
      expect(capturedTabbedProps.onKeycodeMultiSelect).toBeTypeOf('function')
    })
  })

  describe('Apply button + confirm modal', () => {
    it('the Apply button only renders on the simulation tab and calls onRequestKeymapApply', () => {
      const onRequestKeymapApply = vi.fn()
      const { getByTestId, queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply} />,
      )
      fireEvent.click(getByTestId('keymap-pack-apply-button'))
      expect(onRequestKeymapApply).toHaveBeenCalledTimes(1)

      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      expect(queryByTestId('keymap-pack-apply-button')).toBeNull()
    })

    it('renders the confirm modal when keymapApplyOpen is true and wires Confirm/Cancel', () => {
      const onKeymapApplyConfirm = vi.fn()
      const onKeymapApplyCancel = vi.fn()
      const { getByTestId } = render(
        <KeymapEditor
          {...defaultProps()}
          remapKind="simulated" keymapPackName="Dvorak"
          keymapApplyOpen keymapApplyLabelName="Dvorak"
          onKeymapApplyConfirm={onKeymapApplyConfirm} onKeymapApplyCancel={onKeymapApplyCancel}
        />,
      )
      expect(getByTestId('keymap-apply-confirm-modal')).toBeTruthy()
      // No Display Only button (Plan-qwerty-select-no-rewrite v7).
      expect(document.querySelector('[data-testid="keymap-apply-confirm-display-only"]')).toBeNull()

      fireEvent.click(getByTestId('keymap-apply-confirm-apply'))
      expect(onKeymapApplyConfirm).toHaveBeenCalledTimes(1)
      fireEvent.click(getByTestId('keymap-apply-confirm-cancel'))
      expect(onKeymapApplyCancel).toHaveBeenCalledTimes(1)
    })

    it('shows the partial-failure error text near the Apply button', () => {
      const { getByTestId } = render(
        <KeymapEditor
          {...defaultProps()}
          remapKind="simulated" keymapPackName="Dvorak"
          onRequestKeymapApply={vi.fn()} keymapApplyError="device write failed"
        />,
      )
      expect(getByTestId('keymap-apply-error')).toBeTruthy()
    })

    it('does not render the confirm modal when keymapApplyOpen is false/omitted', () => {
      const { queryByTestId } = render(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />)
      expect(queryByTestId('keymap-apply-confirm-modal')).toBeNull()
    })
  })

  describe('typing test / View Matrix mode suppress the tabs regardless of remapKind', () => {
    it('typingTestMode hides the tabs even when remapKind is "simulated"', async () => {
      const { queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" typingTestMode onTypingTestModeChange={vi.fn()} />,
      )
      await act(async () => {})
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()
    })
  })
})
