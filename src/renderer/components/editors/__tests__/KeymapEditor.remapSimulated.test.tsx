// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Task-kaw-sim-color (4-angle review follow-up): `remapKind` is applied as
// a pure CSS cascade override — the `remap-simulated` class (style.css) on
// the single container wrapping the active keymap surface — rather than
// threaded as a prop through KeyboardPane/TypingTestPane/KeyboardWidget/
// KeyWidget/EncoderWidget. This covers the container-level toggle; the
// simulated/actual derivation itself is covered by useDevicePrefs.test.ts's
// "remapKind (Task-kaw-sim-color)" block.

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

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

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: () => <div data-testid="keyboard-widget">KeyboardWidget</div>,
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes">TabbedKeycodes</div>,
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

const makeLayout = () => ({
  keys: [makeKey(0, 0), makeKey(1, 1), makeKey(2, 2)],
})

const defaultProps = {
  layout: makeLayout(),
  layers: 1,
  currentLayer: 0,
  onLayerChange: () => {},
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
}

describe('KeymapEditor — remap-simulated container class', () => {
  it('does not apply remap-simulated when remapKind is omitted (defaults to actual)', () => {
    const { container } = render(<KeymapEditor {...defaultProps} />)
    const surface = container.querySelector('[data-testid="keymap-surface"]')
    expect(surface).not.toBeNull()
    expect(surface).not.toHaveClass('remap-simulated')
  })

  it('does not apply remap-simulated when remapKind is "actual"', () => {
    const { container } = render(<KeymapEditor {...defaultProps} remapKind="actual" />)
    const surface = container.querySelector('[data-testid="keymap-surface"]')
    expect(surface).not.toHaveClass('remap-simulated')
  })

  it('applies remap-simulated when remapKind is "simulated"', () => {
    const { container } = render(<KeymapEditor {...defaultProps} remapKind="simulated" />)
    const surface = container.querySelector('[data-testid="keymap-surface"]')
    expect(surface).toHaveClass('remap-simulated')
  })

  it('the keyboard pane renders inside the keymap-surface container (scoping precondition)', () => {
    const { container } = render(<KeymapEditor {...defaultProps} remapKind="simulated" />)
    const surface = container.querySelector('[data-testid="keymap-surface"]')
    const pane = container.querySelector('[data-testid="primary-pane"]')
    expect(surface).not.toBeNull()
    expect(pane).not.toBeNull()
    expect(surface?.contains(pane)).toBe(true)
  })

  it('the key picker (TabbedKeycodes) renders OUTSIDE the keymap-surface container — never inherits the override', () => {
    const { container } = render(<KeymapEditor {...defaultProps} remapKind="simulated" />)
    const surface = container.querySelector('[data-testid="keymap-surface"]')
    const picker = container.querySelector('[data-testid="tabbed-keycodes"]')
    expect(surface).not.toBeNull()
    expect(picker).not.toBeNull()
    expect(surface?.contains(picker)).toBe(false)
  })
})
