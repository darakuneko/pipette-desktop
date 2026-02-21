// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { EditorSettingsModal } from '../EditorSettingsModal'
import { KEYBOARD_LAYOUTS } from '../../../data/keyboard-layouts'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editorSettings.title': 'Settings',
        'editorSettings.tabLayers': 'Layers',
        'editorSettings.tabData': 'Data',
        'editorSettings.tabTools': 'Tools',
        'editor.autoAdvance': 'Auto Move',
        'layout.keyboardLayout': 'Layout',
        'settings.security': 'Security',
        'security.lock': 'Lock',
        'statusBar.locked': 'Locked',
        'statusBar.unlocked': 'Unlocked',
        'editor.keymap.zoomLabel': 'Zoom',
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
        'sync.resetKeyboardData': 'Reset Keyboard Data',
        'sync.resetKeyboardDataConfirm': "{{name}}'s data will be deleted.",
        'common.cancel': 'Cancel',
        'common.reset': 'Reset',
        'sync.resetDisabledWhileSyncing': 'Cannot reset while sync is in progress',
      }
      if (key === 'editor.keymap.layerN' && params) return `Layer ${params.n}`
      return map[key] ?? key
    },
  }),
}))

const DEFAULT_PROPS = {
  entries: [],
  onSave: vi.fn(),
  onLoad: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onClose: vi.fn(),
  activeTab: 'layers' as const,
  onTabChange: vi.fn(),
  layers: 4,
  currentLayer: 0,
  onLayerChange: vi.fn(),
  keyboardLayout: 'qwerty',
  onKeyboardLayoutChange: vi.fn(),
  autoAdvance: true,
  onAutoAdvanceChange: vi.fn(),
  unlocked: true,
  onLock: vi.fn(),
}

describe('EditorSettingsModal', () => {
  it('renders with title and three tabs', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-tab-layers')).toHaveTextContent('Layers')
    expect(screen.getByTestId('editor-settings-tab-tools')).toHaveTextContent('Tools')
    expect(screen.getByTestId('editor-settings-tab-data')).toHaveTextContent('Data')
  })

  it('has correct dialog semantics', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'editor-settings-title')
  })

  it('tabs have correct ARIA tab semantics', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeInTheDocument()

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('shows Layers tab content by default', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('editor-settings-layers-list')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-layer-0')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-layer-3')).toBeInTheDocument()
  })

  it('shows Data tab content when data tab active', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="data" />)

    expect(screen.getByTestId('layout-store-empty')).toBeInTheDocument()
  })

  it('calls onTabChange when Tools tab is clicked', () => {
    const onTabChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onTabChange={onTabChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-tab-tools'))

    expect(onTabChange).toHaveBeenCalledWith('tools')
  })

  it('shows layout selector and auto-advance toggle on Tools tab', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" />)

    const selector = screen.getByTestId('editor-settings-layout-selector')
    expect(selector).toBeInTheDocument()
    const options = selector.querySelectorAll('option')
    expect(options.length).toBe(KEYBOARD_LAYOUTS.length)

    expect(screen.getByTestId('editor-settings-auto-advance-row')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-auto-advance-toggle')).toBeInTheDocument()
  })

  it('shows lock button and unlocked status in Tools tab', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" unlocked={true} />)

    expect(screen.getByTestId('editor-settings-lock-row')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-lock-button')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-lock-status')).toHaveTextContent('Unlocked')
  })

  it('shows locked status in Tools tab when locked', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" unlocked={false} />)

    expect(screen.getByTestId('editor-settings-lock-status')).toHaveTextContent('Locked')
  })

  it('calls onLock when lock button is clicked', () => {
    const onLock = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" onLock={onLock} />)

    fireEvent.click(screen.getByTestId('editor-settings-lock-button'))

    expect(onLock).toHaveBeenCalledOnce()
  })

  it('calls onKeyboardLayoutChange when layout is changed', () => {
    const onKeyboardLayoutChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" onKeyboardLayoutChange={onKeyboardLayoutChange} />)

    fireEvent.change(screen.getByTestId('editor-settings-layout-selector'), { target: { value: 'dvorak' } })

    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak')
  })

  it('calls onAutoAdvanceChange when toggle is clicked', () => {
    const onAutoAdvanceChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" autoAdvance={true} onAutoAdvanceChange={onAutoAdvanceChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-auto-advance-toggle'))

    expect(onAutoAdvanceChange).toHaveBeenCalledWith(false)
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('editor-settings-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('editor-settings-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close modal on Escape key', () => {
    const onClose = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('auto-advance toggle has correct aria-checked attribute', () => {
    const { rerender } = render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" autoAdvance={true} />)

    const toggle = screen.getByTestId('editor-settings-auto-advance-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAttribute('aria-label', 'Auto Move')

    rerender(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" autoAdvance={false} />)
    expect(screen.getByTestId('editor-settings-auto-advance-toggle')).toHaveAttribute('aria-checked', 'false')
  })

  it('calls onLayerChange when a layer row is clicked', () => {
    const onLayerChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onLayerChange={onLayerChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-layer-num-2'))
    expect(onLayerChange).toHaveBeenCalledWith(2)
  })

  it('highlights the current layer row', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} currentLayer={1} />)

    const layerNum = screen.getByTestId('editor-settings-layer-num-1')
    expect(layerNum.className).toContain('border-accent')
  })

  it('displays custom layer names when provided', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} layerNames={['Base', 'Nav', '', 'Num']} />)

    expect(screen.getByTestId('editor-settings-layer-0')).toHaveTextContent('Base')
    expect(screen.getByTestId('editor-settings-layer-1')).toHaveTextContent('Nav')
    expect(screen.getByTestId('editor-settings-layer-2')).toHaveTextContent('Layer 2')
    expect(screen.getByTestId('editor-settings-layer-3')).toHaveTextContent('Num')
  })

  it('shows zoom controls on Tools tab with percentage display', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={1.0} />)

    expect(screen.getByTestId('editor-settings-zoom-row')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-zoom-value')).toHaveTextContent('100%')
    expect(screen.getByTestId('editor-settings-zoom-in')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-zoom-out')).toBeInTheDocument()
  })

  it('calls onScaleChange when zoom buttons are clicked', () => {
    const onScaleChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={1.0} onScaleChange={onScaleChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-zoom-in'))
    expect(onScaleChange).toHaveBeenCalledWith(0.1)

    fireEvent.click(screen.getByTestId('editor-settings-zoom-out'))
    expect(onScaleChange).toHaveBeenCalledWith(-0.1)
  })

  it('disables zoom-in at max scale and zoom-out at min scale', () => {
    const { rerender } = render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={2.0} />)

    expect(screen.getByTestId('editor-settings-zoom-in')).toBeDisabled()
    expect(screen.getByTestId('editor-settings-zoom-out')).not.toBeDisabled()

    rerender(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={0.3} />)

    expect(screen.getByTestId('editor-settings-zoom-out')).toBeDisabled()
    expect(screen.getByTestId('editor-settings-zoom-in')).not.toBeDisabled()
  })

  it('displays correct percentage for fractional scales', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={0.5} />)

    expect(screen.getByTestId('editor-settings-zoom-value')).toHaveTextContent('50%')
  })

  it('renders on left side by default', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('left-0')
    expect(dialog.className).toContain('border-r')
  })

  it('renders on left side when panelSide="left"', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} panelSide="left" />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('left-0')
    expect(dialog.className).toContain('border-r')
    expect(dialog.className).not.toContain('right-0')
  })

  it('renders on right side when panelSide="right"', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} panelSide="right" />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('right-0')
    expect(dialog.className).toContain('border-l')
    expect(dialog.className).not.toContain('left-0')
  })

  describe('isDummy mode', () => {
    it('hides Layers tab when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" isDummy />)

      expect(screen.queryByTestId('editor-settings-tab-layers')).not.toBeInTheDocument()
      expect(screen.getByTestId('editor-settings-tab-tools')).toBeInTheDocument()
      expect(screen.getByTestId('editor-settings-tab-data')).toBeInTheDocument()
    })

    it('does not render Layers content even if activeTab is stale as layers', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="layers" isDummy />)

      expect(screen.queryByTestId('editor-settings-layers-list')).not.toBeInTheDocument()
    })

    it('hides lock row in Tools tab when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" isDummy />)

      expect(screen.queryByTestId('editor-settings-lock-row')).not.toBeInTheDocument()
    })

    it('hides save form and history in Data tab when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="data" isDummy />)

      expect(screen.queryByTestId('layout-store-save-input')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-empty')).not.toBeInTheDocument()
    })
  })

  describe('layer rename inline editing', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('cancels layer rename on blur (clicking outside)', () => {
      const onSetLayerName = vi.fn()
      render(
        <EditorSettingsModal
          {...DEFAULT_PROPS}
          layerNames={['Base', '', '', '']}
          onSetLayerName={onSetLayerName}
        />,
      )

      // Click label to enter edit mode
      fireEvent.click(screen.getByTestId('editor-settings-layer-name-0'))

      const input = screen.getByTestId('editor-settings-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })

      // Blur (clicking outside) should cancel, not save
      fireEvent.blur(input)

      expect(onSetLayerName).not.toHaveBeenCalled()
      expect(screen.queryByTestId('editor-settings-layer-name-input-0')).not.toBeInTheDocument()
    })

    it('saves layer rename only on Enter', () => {
      const onSetLayerName = vi.fn()
      render(
        <EditorSettingsModal
          {...DEFAULT_PROPS}
          layerNames={['Base', '', '', '']}
          onSetLayerName={onSetLayerName}
        />,
      )

      fireEvent.click(screen.getByTestId('editor-settings-layer-name-0'))

      const input = screen.getByTestId('editor-settings-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onSetLayerName).toHaveBeenCalledWith(0, 'NewName')
    })

    it('clicking row selects layer without entering edit mode', () => {
      const onLayerChange = vi.fn()
      const onSetLayerName = vi.fn()
      render(
        <EditorSettingsModal
          {...DEFAULT_PROPS}
          layerNames={['Base', '', '', '']}
          onSetLayerName={onSetLayerName}
          onLayerChange={onLayerChange}
        />,
      )

      // Click on the number box (not the name box)
      fireEvent.click(screen.getByTestId('editor-settings-layer-num-1'))

      expect(onLayerChange).toHaveBeenCalledWith(1)
      expect(screen.queryByTestId('editor-settings-layer-name-input-1')).not.toBeInTheDocument()
    })

    it('shows confirm flash on row after Enter rename', () => {
      vi.useFakeTimers()
      const onSetLayerName = vi.fn()
      render(
        <EditorSettingsModal
          {...DEFAULT_PROPS}
          layerNames={['Base', '', '', '']}
          onSetLayerName={onSetLayerName}
        />,
      )

      fireEvent.click(screen.getByTestId('editor-settings-layer-name-0'))

      const input = screen.getByTestId('editor-settings-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      // Flash is deferred via setTimeout(0) so the class is added after the label mounts
      act(() => { vi.advanceTimersByTime(0) })

      // After Enter, name box should have confirm flash animation
      const nameBox = screen.getByTestId('editor-settings-layer-name-box-0')
      expect(nameBox.className).toContain('confirm-flash')

      // After 1200ms, animation class should be removed
      act(() => { vi.advanceTimersByTime(1200) })
      expect(nameBox.className).not.toContain('confirm-flash')

      vi.useRealTimers()
    })

    it('does not flash when Enter is pressed without changes', () => {
      const onSetLayerName = vi.fn()
      render(
        <EditorSettingsModal
          {...DEFAULT_PROPS}
          layerNames={['Base', '', '', '']}
          onSetLayerName={onSetLayerName}
        />,
      )

      fireEvent.click(screen.getByTestId('editor-settings-layer-name-0'))

      const input = screen.getByTestId('editor-settings-layer-name-input-0')
      // Press Enter without changing the value
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onSetLayerName).not.toHaveBeenCalled()
      const nameBox = screen.getByTestId('editor-settings-layer-name-box-0')
      expect(nameBox.className).not.toContain('confirm-flash')
    })
  })

  describe('Reset Keyboard Data', () => {
    const RESET_PROPS = {
      ...DEFAULT_PROPS,
      activeTab: 'data' as const,
      onResetKeyboardData: vi.fn().mockResolvedValue(undefined),
    }

    it('does not render reset section when onResetKeyboardData is not provided', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="data" />)

      expect(screen.queryByTestId('reset-keyboard-data-section')).not.toBeInTheDocument()
    })

    it('renders reset button when onResetKeyboardData is provided', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      expect(screen.getByTestId('reset-keyboard-data-section')).toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-btn')).toBeInTheDocument()
    })

    it('shows confirmation warning when reset button is clicked', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))

      expect(screen.getByTestId('reset-keyboard-data-warning')).toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-cancel')).toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-confirm')).toBeInTheDocument()
    })

    it('hides confirmation when cancel is clicked', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))
      fireEvent.click(screen.getByTestId('reset-keyboard-data-cancel'))

      expect(screen.queryByTestId('reset-keyboard-data-warning')).not.toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-btn')).toBeInTheDocument()
    })

    it('calls onResetKeyboardData when confirm is clicked', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))
      fireEvent.click(screen.getByTestId('reset-keyboard-data-confirm'))

      expect(RESET_PROPS.onResetKeyboardData).toHaveBeenCalledOnce()
    })

    it('disables reset button when syncStatus is syncing', () => {
      render(<EditorSettingsModal {...RESET_PROPS} syncStatus="syncing" />)

      expect(screen.getByTestId('reset-keyboard-data-btn')).toBeDisabled()
    })

    it('enables reset button when syncStatus is not syncing', () => {
      render(<EditorSettingsModal {...RESET_PROPS} syncStatus="pending" />)

      expect(screen.getByTestId('reset-keyboard-data-btn')).not.toBeDisabled()
    })

    it('disables confirm button when syncStatus changes to syncing', () => {
      const { rerender } = render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))
      expect(screen.getByTestId('reset-keyboard-data-confirm')).not.toBeDisabled()

      // Sync starts while confirmation dialog is open
      rerender(<EditorSettingsModal {...RESET_PROPS} syncStatus="syncing" />)
      expect(screen.getByTestId('reset-keyboard-data-confirm')).toBeDisabled()
    })
  })
})
