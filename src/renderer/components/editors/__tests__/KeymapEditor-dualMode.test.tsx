// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
        'editor.keymap.dualMode': 'Dual View',
        'editorSettings.title': 'Settings',
      }
      return map[key] ?? key
    },
  }),
}))

let capturedWidgetProps: Array<Record<string, unknown>> = []

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: Record<string, unknown>) => {
    capturedWidgetProps.push(props)
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes">TabbedKeycodes</div>,
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: () => 0,
  isMask: () => false,
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

import { KeymapEditor } from '../KeymapEditor'
import type { KleKey } from '../../../../shared/kle/types'

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, height: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
    { x: 1, y: 0, w: 1, h: 1, height: 1, row: 0, col: 1, encoderIdx: -1, decal: false, labels: [] },
  ],
})

describe('KeymapEditor — dual mode', () => {
  const onDualModeChange = vi.fn()
  const onActivePaneChange = vi.fn()

  const defaultProps = {
    layout: makeLayout(),
    layers: 4,
    currentLayer: 0,
    keymap: new Map([
      ['0,0,0', 4],
      ['0,0,1', 5],
      ['1,0,0', 6],
      ['1,0,1', 7],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    onDualModeChange,
    onActivePaneChange,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedWidgetProps = []
  })

  it('renders the dual mode toggle button', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.getByTestId('dual-mode-button')).toBeInTheDocument()
    expect(screen.getByTestId('dual-mode-button')).toHaveAttribute('aria-label', 'Dual View')
  })

  it('calls onDualModeChange when toggle button is clicked', () => {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('dual-mode-button'))
    expect(onDualModeChange).toHaveBeenCalledWith(true)
  })

  it('calls onDualModeChange(false) when dualMode is already on', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="primary" primaryLayer={0} secondaryLayer={0} />)
    fireEvent.click(screen.getByTestId('dual-mode-button'))
    expect(onDualModeChange).toHaveBeenCalledWith(false)
  })

  it('does not render secondary pane when dualMode is off', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.queryByTestId('secondary-pane')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('keyboard-widget')).toHaveLength(1)
  })

  it('renders two keyboard widgets when dualMode is on', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="primary" primaryLayer={0} secondaryLayer={0} />)
    expect(screen.getByTestId('secondary-pane')).toBeInTheDocument()
    expect(screen.getAllByTestId('keyboard-widget')).toHaveLength(2)
  })

  it('applies border-accent to the active primary pane', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="primary" primaryLayer={0} secondaryLayer={0} />)
    const primaryPane = screen.getByTestId('primary-pane')
    expect(primaryPane.className).toContain('border-accent')
    const secondaryPane = screen.getByTestId('secondary-pane')
    expect(secondaryPane.className).not.toContain('border-accent')
    expect(secondaryPane.className).toContain('border-edge-subtle')
  })

  it('applies border-accent to the active secondary pane', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="secondary" primaryLayer={0} secondaryLayer={0} />)
    const secondaryPane = screen.getByTestId('secondary-pane')
    expect(secondaryPane.className).toContain('border-accent')
    const primaryPane = screen.getByTestId('primary-pane')
    expect(primaryPane.className).not.toContain('border-accent')
  })

  it('calls onActivePaneChange when clicking the inactive pane', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="primary" primaryLayer={0} secondaryLayer={0} />)
    fireEvent.click(screen.getByTestId('secondary-pane'))
    expect(onActivePaneChange).toHaveBeenCalledWith('secondary')
  })

  it('calls onActivePaneChange("primary") when clicking primary pane while secondary is active', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="secondary" primaryLayer={0} secondaryLayer={0} />)
    fireEvent.click(screen.getByTestId('primary-pane'))
    expect(onActivePaneChange).toHaveBeenCalledWith('primary')
  })

  it('shows correct layer labels for each pane', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="primary" primaryLayer={0} secondaryLayer={1} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
    expect(screen.getByTestId('secondary-layer-label')).toHaveTextContent('Layer 1')
  })

  it('shows correct layer labels with custom layer names', () => {
    render(
      <KeymapEditor
        {...defaultProps}
        dualMode={true}
        activePane="primary"
        primaryLayer={0}
        secondaryLayer={1}
        layerNames={['Base', 'Nav', 'Sym', 'Fn']}
      />,
    )
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Base')
    expect(screen.getByTestId('secondary-layer-label')).toHaveTextContent('Nav')
  })

  it('passes correct keycodes to each pane for different layers', () => {
    capturedWidgetProps = []
    render(
      <KeymapEditor
        {...defaultProps}
        dualMode={true}
        activePane="primary"
        primaryLayer={0}
        secondaryLayer={1}
        currentLayer={0}
      />,
    )
    // Two KeyboardWidgets rendered
    expect(capturedWidgetProps).toHaveLength(2)

    // Primary pane (active, layer 0) should have layerKeycodes from currentLayer=0
    const primaryProps = capturedWidgetProps[0]
    const primaryKC = primaryProps.keycodes as Map<string, string>
    expect(primaryKC.get('0,0')).toBe('KC_4')

    // Secondary pane (inactive, layer 1) should have inactiveLayerKeycodes
    const secondaryProps = capturedWidgetProps[1]
    const secondaryKC = secondaryProps.keycodes as Map<string, string>
    expect(secondaryKC.get('0,0')).toBe('KC_6')
  })

  it('renders only one pane without border-accent when not in dual mode', () => {
    render(<KeymapEditor {...defaultProps} dualMode={false} />)
    const primaryPane = screen.getByTestId('primary-pane')
    expect(primaryPane.className).toContain('border-edge-subtle')
    expect(primaryPane.className).not.toContain('border-accent')
    expect(screen.queryByTestId('secondary-pane')).not.toBeInTheDocument()
  })

  it('active pane keyboard widget receives interactive handlers, inactive does not', () => {
    capturedWidgetProps = []
    render(
      <KeymapEditor
        {...defaultProps}
        dualMode={true}
        activePane="primary"
        primaryLayer={0}
        secondaryLayer={0}
      />,
    )
    const primaryProps = capturedWidgetProps[0]
    const secondaryProps = capturedWidgetProps[1]

    // Active (primary) should have click handlers
    expect(primaryProps.onKeyClick).toBeDefined()
    expect(primaryProps.onKeyDoubleClick).toBeDefined()
    expect(primaryProps.readOnly).toBe(false)

    // Inactive (secondary) should be read-only
    expect(secondaryProps.onKeyClick).toBeUndefined()
    expect(secondaryProps.onKeyDoubleClick).toBeUndefined()
    expect(secondaryProps.readOnly).toBe(true)
  })

  it('shows correct keycodes when dualMode=false and activePane="secondary"', () => {
    // Guard against blank-map regression: single pane should always show currentLayer keycodes
    capturedWidgetProps = []
    render(
      <KeymapEditor
        {...defaultProps}
        dualMode={false}
        activePane={'secondary' as 'primary' | 'secondary'}
        currentLayer={0}
      />,
    )
    expect(capturedWidgetProps).toHaveLength(1)
    const kc = capturedWidgetProps[0].keycodes as Map<string, string>
    expect(kc.get('0,0')).toBe('KC_4')
    expect(kc.get('0,1')).toBe('KC_5')
  })

  it('passes correct keycodes when activePane is secondary', () => {
    capturedWidgetProps = []
    render(
      <KeymapEditor
        {...defaultProps}
        dualMode={true}
        activePane="secondary"
        primaryLayer={0}
        secondaryLayer={1}
        currentLayer={1}
      />,
    )
    expect(capturedWidgetProps).toHaveLength(2)

    // Primary pane (inactive, layer 0)
    const primaryKC = capturedWidgetProps[0].keycodes as Map<string, string>
    expect(primaryKC.get('0,0')).toBe('KC_4')

    // Secondary pane (active, layer 1)
    const secondaryKC = capturedWidgetProps[1].keycodes as Map<string, string>
    expect(secondaryKC.get('0,0')).toBe('KC_6')
  })

  it('does not call onActivePaneChange when clicking the active pane', () => {
    render(<KeymapEditor {...defaultProps} dualMode={true} activePane="primary" primaryLayer={0} secondaryLayer={0} />)
    fireEvent.click(screen.getByTestId('primary-pane'))
    expect(onActivePaneChange).not.toHaveBeenCalled()
  })

  it('does not call onActivePaneChange when clicking pane in single mode', () => {
    render(<KeymapEditor {...defaultProps} dualMode={false} />)
    fireEvent.click(screen.getByTestId('primary-pane'))
    expect(onActivePaneChange).not.toHaveBeenCalled()
  })

  it('clears selected key when active pane changes', () => {
    capturedWidgetProps = []
    const { rerender } = render(
      <KeymapEditor
        {...defaultProps}
        dualMode={true}
        activePane="primary"
        primaryLayer={0}
        secondaryLayer={0}
      />,
    )
    // Simulate key click on active pane
    const firstRenderPrimary = capturedWidgetProps[0]
    const onKeyClick = firstRenderPrimary.onKeyClick as (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
    onKeyClick({ row: 0, col: 0 } as KleKey, false)

    // Rerender with switched active pane
    capturedWidgetProps = []
    rerender(
      <KeymapEditor
        {...defaultProps}
        dualMode={true}
        activePane="secondary"
        primaryLayer={0}
        secondaryLayer={0}
      />,
    )

    // The useEffect clears selection after render, triggering a re-render.
    // Check the final captured props (last secondary pane entry).
    const lastSecondary = capturedWidgetProps.filter(
      (_p, i) => i % 2 === 1,
    ).pop()
    expect(lastSecondary?.selectedKey).toBeNull()
  })
})
