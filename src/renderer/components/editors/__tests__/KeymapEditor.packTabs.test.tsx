// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Tab visibility (gated by the SINGLE `remapKind === 'simulated'`
// predicate), tab order, the Default (Base) tab shown first, the resets
// back to Default (uid change, keymap emptied), the switch to the pack tab
// on a user's footer layout pick (and not on a prefs restore), read-only
// enforcement on the simulation tab, full editability on Base, and the
// Apply button / confirm modal wiring.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import type { ReactNode } from 'react'
import { render, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'common.cancel': 'Cancel',
        'common.apply': 'Apply',
        'editor.keymap.layer': `Layer ${opts?.number ?? ''}`,
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.layerPreview': `Preview - ${String(opts?.label ?? '')}`,
        'editor.keymap.selectKey': 'Click a key to edit',
        'editor.viewMatrix.edit': 'Edit',
        'editor.viewMatrix.done': 'Done',
        'keyLabels.qwertyDefaultName': 'QWERTY (Default)',
        'keyLabels.qwertyDefaultShort': 'Default',
        'keyLabels.keymapApply.tabsLabel': 'Keymap view',
        'keyLabels.keymapApply.errorPartial': 'Some keys could not be rewritten.',
        'keyLabels.keymapApply.title': `Apply ${String(opts?.name ?? '')}?`,
        'keyLabels.keymapApply.saveRecommendation': 'Save first.',
        'keyLabels.keymapApply.confirmApply': 'Apply?',
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
// Renders `panelOverlay` so the View Matrix Edit/Done buttons are reachable.
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: Record<string, unknown>) => {
    capturedTabbedProps = props
    return <div data-testid="tabbed-keycodes">TabbedKeycodes{props.panelOverlay as ReactNode}</div>
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
import type { KeymapEditorHandle } from '../keymap-editor-types'
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

function selectFirstKey(): void {
  const onKeyClick = lastWidgetProps().onKeyClick as (key: KleKey, maskClicked: boolean) => void
  act(() => onKeyClick(makeKey(0, 0), false))
  expect(lastWidgetProps().selectedKey).toEqual({ row: 0, col: 0 })
}

beforeEach(() => {
  capturedWidgetProps = []
  capturedTabbedProps = {}
})

describe('KeymapEditor — pack tabs', () => {
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
      // Short form here (`qwertyDefaultShort`) — the ~28px vertical strip
      // doesn't fit the footer select's full "QWERTY (Default)" name.
      expect(getByTestId('keymap-pack-tab-base')).toHaveTextContent('Default')
    })

    it('puts Default on top and the pack name below, with Default selected', () => {
      const { getByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      const tabs = Array.from(getByTestId('keymap-pack-tabs').querySelectorAll('[role="tab"]'))
      expect(tabs.map((el) => el.getAttribute('data-testid'))).toEqual(['keymap-pack-tab-base', 'keymap-pack-tab-simulation'])
      expect(tabs.map((el) => el.getAttribute('aria-selected'))).toEqual(['true', 'false'])

      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'false')
      expect(getByTestId('keymap-pack-tab-simulation')).toHaveAttribute('aria-selected', 'true')
    })

    // `requestApply` already no-ops when the keymap isn't editable
    // (`keymapEditable` false) — tab/Apply-button VISIBILITY must fold in
    // the same condition, or the UI offers a tabs+Apply surface that
    // silently does nothing when clicked.
    it('renders no tabs and no Apply button when the keymap is empty (not editable), even though remapKind is "simulated"', () => {
      const onRequestKeymapApply = vi.fn()
      const { queryByTestId } = render(
        <KeymapEditor
          {...defaultProps({ keymap: new Map<string, number>() })}
          remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply}
        />,
      )
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()
      expect(queryByTestId('keymap-pack-apply-button')).toBeNull()
    })
  })

  describe('default tab + resets', () => {
    it('defaults to the Default (base) tab: raw labels, no simulation tint, no Apply, no preview label, pane editable', () => {
      const { container, getByTestId, queryByTestId } = render(
        <KeymapEditor
          {...defaultProps()}
          remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={vi.fn()}
          remapLabel={(id) => `${id}!`} isRemapped={() => true}
        />,
      )
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().remapLabel).toBeUndefined()
      expect((lastWidgetProps().remappedKeys as Set<string>).size).toBe(0)
      expect(container.querySelector('[data-testid="keymap-surface"]')).not.toHaveClass('remap-simulated')
      expect(queryByTestId('keymap-pack-apply-button')).toBeNull()
      expect(getByTestId('layer-label')).not.toHaveTextContent('Preview')
      expect(lastWidgetProps().readOnly).toBe(false)
      expect(lastWidgetProps().onKeyClick).toBeTypeOf('function')
    })

    it('selecting the pack tab shows the simulation: Apply button visible, remap-simulated applied, pane read-only', () => {
      const { container, getByTestId, queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={vi.fn()} />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      expect(queryByTestId('keymap-pack-apply-button')).toBeTruthy()
      expect(container.querySelector('[data-testid="keymap-surface"]')).toHaveClass('remap-simulated')
      expect(lastWidgetProps().readOnly).toBe(true)
      expect(lastWidgetProps().onKeyClick).toBeUndefined()
    })

    it('switching to the pack tab and then changing keyboardUid resets back to Default', () => {
      const onRequestKeymapApply = vi.fn()
      const { getByTestId, rerender, queryByTestId, container } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply} />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      expect(queryByTestId('keymap-pack-apply-button')).toBeTruthy()
      expect(lastWidgetProps().readOnly).toBe(true)

      // A different keyboardUid (reconnect to another keyboard) — the
      // editor does NOT remount, so this must be observed via the existing
      // uid-watching effect, same one that clears history / exits View
      // Matrix mode.
      rerender(
        <KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply} />,
      )
      expect(queryByTestId('keymap-pack-apply-button')).toBeNull()
      expect(container.querySelector('[data-testid="keymap-surface"]')).not.toHaveClass('remap-simulated')
      expect(lastWidgetProps().readOnly).toBe(false)
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
    })

    it('a uid change clears a selection made on Default', () => {
      const { rerender } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      selectFirstKey()
      rerender(<KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} remapKind="simulated" keymapPackName="Dvorak" />)
      expect(lastWidgetProps().selectedKey).toBeNull()
    })

    it('pack tab → keymap emptied → keymap refilled lands on Default', () => {
      const { getByTestId, queryByTestId, rerender } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      expect(lastWidgetProps().readOnly).toBe(true)

      rerender(<KeymapEditor {...defaultProps({ keymap: new Map<string, number>() })} remapKind="simulated" keymapPackName="Dvorak" />)
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()

      rerender(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />)
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(false)
      expect(lastWidgetProps().selectedKey).toBeNull()
    })
  })

  describe('layout change', () => {
    it('a footer layout pick (notifyUserLayoutChange, then keyboardLayout changes) switches to the pack tab and clears the selection', () => {
      const ref = createRef<KeymapEditorHandle>()
      const { getByTestId, rerender } = render(
        <KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      selectFirstKey()

      // Picking a different permutation pack from the footer's Keyboard
      // Layout select — this must switch to the pack tab so the newly
      // selected pack's simulated keymap is immediately visible.
      act(() => ref.current?.notifyUserLayoutChange('colemak'))
      rerender(
        <KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Colemak" keyboardLayout="colemak" />,
      )
      expect(getByTestId('keymap-pack-tab-simulation')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(true)

      // No selection left behind to reappear on Default.
      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      expect(lastWidgetProps().selectedKey).toBeNull()
    })

    it('a footer pick onto a pack from QWERTY (tabs hidden before) opens on the pack tab', () => {
      const ref = createRef<KeymapEditorHandle>()
      const { getByTestId, rerender } = render(
        <KeymapEditor ref={ref} {...defaultProps()} keyboardLayout="qwerty" />,
      )
      act(() => ref.current?.notifyUserLayoutChange('dvorak'))
      rerender(<KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />)
      expect(getByTestId('keymap-pack-tab-simulation')).toHaveAttribute('aria-selected', 'true')
    })

    it('re-picking the layout already shown while on Default opens the pack tab and clears the selection', () => {
      const ref = createRef<KeymapEditorHandle>()
      const { getByTestId } = render(
        <KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      selectFirstKey()
      act(() => ref.current?.notifyUserLayoutChange('dvorak'))
      expect(getByTestId('keymap-pack-tab-simulation')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(true)

      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      expect(lastWidgetProps().selectedKey).toBeNull()
    })

    it('re-picking the layout already shown leaves no mark: a following unmarked layout change stays on Default', () => {
      const ref = createRef<KeymapEditorHandle>()
      const { getByTestId, rerender } = render(
        <KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      act(() => ref.current?.notifyUserLayoutChange('dvorak'))
      fireEvent.click(getByTestId('keymap-pack-tab-base'))

      // e.g. a layout arriving through sync, not through the footer.
      rerender(<KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Colemak" keyboardLayout="colemak" />)
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(false)
    })

    it('re-picking QWERTY while the tabs are hidden keeps the selection and leaves no mark', () => {
      const ref = createRef<KeymapEditorHandle>()
      const { getByTestId, queryByTestId, rerender } = render(
        <KeymapEditor ref={ref} {...defaultProps()} keyboardLayout="qwerty" />,
      )
      selectFirstKey()
      act(() => ref.current?.notifyUserLayoutChange('qwerty'))
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()
      expect(lastWidgetProps().selectedKey).toEqual({ row: 0, col: 0 })
      expect(lastWidgetProps().readOnly).toBe(false)

      rerender(<KeymapEditor ref={ref} {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />)
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
    })

    it('a layout restored from prefs in the same render as the uid change stays on Default', () => {
      const { getByTestId, rerender } = render(
        <KeymapEditor {...defaultProps()} keyboardLayout="qwerty" />,
      )
      rerender(
        <KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(false)
    })

    it('a layout restored from prefs some renders after the uid change stays on Default', () => {
      const { getByTestId, rerender } = render(
        <KeymapEditor {...defaultProps()} keyboardLayout="qwerty" />,
      )
      rerender(<KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} keyboardLayout="qwerty" />)
      rerender(<KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} keyboardLayout="qwerty" currentLayer={0} />)
      rerender(
        <KeymapEditor {...defaultProps({ keyboardUid: 'uid-2' })} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(false)
    })

    it('a pending footer notice with no layout change is dropped by the uid reset, so a later restore stays on Default', () => {
      const ref = createRef<KeymapEditorHandle>()
      const { getByTestId, rerender } = render(
        <KeymapEditor ref={ref} {...defaultProps()} keyboardLayout="qwerty" />,
      )
      act(() => ref.current?.notifyUserLayoutChange('dvorak'))
      rerender(<KeymapEditor ref={ref} {...defaultProps({ keyboardUid: 'uid-2' })} keyboardLayout="qwerty" />)
      rerender(
        <KeymapEditor ref={ref} {...defaultProps({ keyboardUid: 'uid-2' })} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
    })

    it('a manual tab choice persists across a rerender with an unchanged layout', () => {
      const { getByTestId, rerender } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      expect(lastWidgetProps().readOnly).toBe(true)

      // Same `keyboardLayout` value on rerender (e.g. an unrelated prop
      // changed) — must NOT move the tab.
      rerender(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" currentLayer={0} />,
      )
      expect(lastWidgetProps().readOnly).toBe(true)

      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      rerender(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" keyboardLayout="dvorak" />,
      )
      expect(lastWidgetProps().readOnly).toBe(false)
    })
  })

  describe('read-only enforcement on the simulation tab', () => {
    function renderSimulated() {
      const result = render(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />)
      fireEvent.click(result.getByTestId('keymap-pack-tab-simulation'))
      return result
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

    it('a manual switch to the pack tab clears a selection made on Default', () => {
      const { getByTestId } = render(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />)
      selectFirstKey()
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      expect(lastWidgetProps().selectedKey).toBeNull()
    })
  })

  describe('Apply button + confirm modal', () => {
    it('the Apply button only renders on the simulation tab and calls onRequestKeymapApply', () => {
      const onRequestKeymapApply = vi.fn()
      const { getByTestId, queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onRequestKeymapApply={onRequestKeymapApply} />,
      )
      expect(queryByTestId('keymap-pack-apply-button')).toBeNull()
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
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
      // No Display Only button.
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
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
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

    it('the tabs come back after the typing test with the same tab selected', async () => {
      const onTypingTestModeChange = vi.fn()
      const { getByTestId, queryByTestId, rerender } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onTypingTestModeChange={onTypingTestModeChange} />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))

      rerender(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" typingTestMode onTypingTestModeChange={onTypingTestModeChange} />)
      await act(async () => {})
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()

      rerender(<KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" onTypingTestModeChange={onTypingTestModeChange} />)
      await act(async () => {})
      expect(getByTestId('keymap-pack-tab-simulation')).toHaveAttribute('aria-selected', 'true')
    })

    it('View Matrix mode hides the tabs, and leaving it shows them again on Default', () => {
      const { getByTestId, queryByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      fireEvent.click(getByTestId('overlay-view-matrix-edit-button'))
      expect(queryByTestId('keymap-pack-tabs')).toBeNull()

      fireEvent.click(getByTestId('view-matrix-mode-toggle'))
      expect(getByTestId('keymap-pack-tab-base')).toHaveAttribute('aria-selected', 'true')
      expect(lastWidgetProps().readOnly).toBe(false)
    })
  })

  describe('simulation-tab layer label gets the "Preview - " prefix', () => {
    it('prefixes the layer label on the simulation (pack) tab — the keymap shown is the pack\'s simulated arrangement, not the real keymap', () => {
      const { getByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      expect(getByTestId('layer-label')).toHaveTextContent('Preview - Layer 0')
    })

    it('shows the plain label on the QWERTY (Default) tab — this pane is the real, editable keymap', () => {
      const { getByTestId } = render(
        <KeymapEditor {...defaultProps()} remapKind="simulated" keymapPackName="Dvorak" />,
      )
      fireEvent.click(getByTestId('keymap-pack-tab-simulation'))
      fireEvent.click(getByTestId('keymap-pack-tab-base'))
      expect(getByTestId('layer-label')).toHaveTextContent('Layer 0')
      expect(getByTestId('layer-label')).not.toHaveTextContent('Preview')
    })

    it('shows the plain label in the no-tabs case (remapKind omitted)', () => {
      const { getByTestId } = render(<KeymapEditor {...defaultProps()} />)
      expect(getByTestId('layer-label')).toHaveTextContent('Layer 0')
      expect(getByTestId('layer-label')).not.toHaveTextContent('Preview')
    })
  })
})
