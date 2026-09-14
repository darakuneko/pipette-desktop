// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.selectKey': 'Click a key to edit',
        'editor.viewMatrix.label': 'View Matrix',
        'editor.viewMatrix.edit': 'Edit',
        'editor.viewMatrix.done': 'Done',
        'keyLabels.qwertyDefaultName': 'QWERTY (Default)',
        'keyLabels.qwertyDefaultShort': 'Default',
      }
      if (key === 'editor.keymap.layer' && opts) return `Layer ${opts.number ?? ''}`
      if (key === 'editor.keymap.layerN' && opts) return `Layer ${opts.n ?? ''}`
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

// A shallow stand-in for the real KeyboardWidget: it doesn't draw the SVG
// overlay itself, but mirrors the one observable contract this suite cares
// about — a `matrixWires` prop (Map | undefined) reaching the widget shows
// up as a `data-testid="matrix-wires"` child, exactly like the real
// component's `MatrixWiresOverlay` group does when `matrixWires` is set.
vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: { matrixWires?: ReadonlyMap<string, unknown> }) => (
    <div data-testid="keyboard-widget">
      {props.matrixWires && <div data-testid="matrix-wires" />}
    </div>
  ),
}))

// Renders the real overlay (panelOverlay) so the View Matrix Edit/Done
// button is reachable, same as `KeymapEditor.viewMatrix.test.tsx`.
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: { panelOverlay?: ReactNode }) => (
    <div data-testid="tabbed-keycodes">{props.panelOverlay}</div>
  ),
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: () => <div data-testid="key-popover" />,
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => (val === 'KC_A' ? 4 : 0),
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
    layout: makeLayout(),
    layers: 2,
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
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    rows: 3,
    cols: 3,
    ...overrides,
  }
}

describe('KeymapEditor — View Matrix wiring overlay toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is absent from the primary pane when viewMatrixWires is undefined', () => {
    render(<KeymapEditor {...defaultProps()} />)

    expect(screen.getByTestId('keyboard-widget')).toBeInTheDocument()
    expect(screen.queryByTestId('matrix-wires')).not.toBeInTheDocument()
  })

  it('is absent from the primary pane when viewMatrixWires is false', () => {
    render(<KeymapEditor {...defaultProps({ viewMatrixWires: false })} />)

    expect(screen.queryByTestId('matrix-wires')).not.toBeInTheDocument()
  })

  it('shows on the primary pane when viewMatrixWires is true', () => {
    render(<KeymapEditor {...defaultProps({ viewMatrixWires: true })} />)

    expect(screen.getByTestId('matrix-wires')).toBeInTheDocument()
  })

  it('stays visible while View Matrix Edit mode is active — the toggle is independent of the mode', () => {
    render(<KeymapEditor {...defaultProps({ viewMatrixWires: true })} />)

    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    expect(screen.getByTestId('view-matrix-mode-toggle')).toHaveTextContent('Done')
    expect(screen.getByTestId('matrix-wires')).toBeInTheDocument()
  })

  it('is absent on the pack simulation preview branch, which never receives matrixWires', () => {
    // Plan-qwerty-select-no-rewrite v7: remapKind="simulated" + a pack name
    // defaults to the read-only simulation (pack) tab, which renders the
    // OTHER `KeyboardPane` branch in `KeymapPrimaryPane` — the one that
    // never threads `matrixWires` through, by design (the overlay is a
    // Base/normal-editing-only surface, see KeymapPrimaryPaneProps).
    render(
      <KeymapEditor
        {...defaultProps({ viewMatrixWires: true })}
        remapKind="simulated"
        keymapPackName="Dvorak"
      />,
    )

    expect(screen.queryByTestId('matrix-wires')).not.toBeInTheDocument()
  })
})
