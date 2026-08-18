// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeycodesOverlayPanel } from '../KeycodesOverlayPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editorSettings.tabTools': 'Tools',
        'editorSettings.tabLayout': 'Layout',
        'editorSettings.tabSave': 'Save',
        'editorSettings.keyEditorZoom': 'Key Editor Zoom',
        'editor.autoAdvance': 'Auto Move',
        'editor.keyTester.title': 'Key Tester',
        'settings.security': 'Security',
        'security.lock': 'Lock',
        'security.unlock': 'Unlock',
        'security.lockRecConfirmTitle': 'Turn off Record and lock?',
        'security.lockRecConfirmBody': 'Record is on. Locking the keyboard turns Record off.',
        'statusBar.locked': 'Locked',
        'statusBar.unlocked': 'Unlocked',
        'common.cancel': 'Cancel',
      }
      return map[key] ?? key
    },
  }),
}))

const DEFAULT_PROPS = {
  hasLayoutOptions: false,
  autoAdvance: true,
  onAutoAdvanceChange: vi.fn(),
  matrixMode: false,
  hasMatrixTester: false,
  unlocked: true,
  onLock: vi.fn(),
}

describe('KeycodesOverlayPanel', () => {
  it('renders tools content when no layout options', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('keycodes-overlay-panel')).toBeInTheDocument()
    expect(screen.getByTestId('overlay-auto-advance-row')).toBeInTheDocument()
  })

  it('does not show tabs when no layout options', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    expect(screen.queryByTestId('overlay-tabs')).not.toBeInTheDocument()
  })

  it('shows tabs with proper accessibility when hasLayoutOptions is true', () => {
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    const tablist = screen.getByTestId('overlay-tabs')
    expect(tablist).toHaveAttribute('role', 'tablist')

    const layoutTab = screen.getByTestId('overlay-tab-layout')
    expect(layoutTab).toHaveAttribute('role', 'tab')
    expect(layoutTab).toHaveAttribute('aria-selected', 'true')
    expect(layoutTab).toHaveTextContent('Layout')

    const toolsTab = screen.getByTestId('overlay-tab-tools')
    expect(toolsTab).toHaveAttribute('role', 'tab')
    expect(toolsTab).toHaveAttribute('aria-selected', 'false')
    expect(toolsTab).toHaveTextContent('Tools')
  })

  it('defaults to layout tab when hasLayoutOptions is true', () => {
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Split Backspace')).toBeInTheDocument()
  })

  it('switches to tools tab when clicked', () => {
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('overlay-tab-tools'))

    expect(screen.getByTestId('overlay-auto-advance-row')).toBeInTheDocument()
    // Layout content is still in DOM (for width stability) but invisible
    expect(screen.getByText('Split Backspace').closest('[inert]')).toBeTruthy()
  })

  it('calls onAutoAdvanceChange when toggle is clicked', () => {
    const onAutoAdvanceChange = vi.fn()
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} onAutoAdvanceChange={onAutoAdvanceChange} />)

    fireEvent.click(screen.getByTestId('overlay-auto-advance-toggle'))
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(false)
  })

  it('shows lock row with unlocked status', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} unlocked />)

    expect(screen.getByTestId('overlay-lock-status')).toHaveTextContent('Unlocked')
  })

  it('hides lock row when isDummy', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} isDummy />)

    expect(screen.queryByTestId('overlay-lock-row')).not.toBeInTheDocument()
  })

  it('keeps the Lock button enabled while REC (typingRecordEnabled) is armed, and opens a confirm modal instead of locking directly', () => {
    const onLock = vi.fn()
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} unlocked typingRecordEnabled onLock={onLock} />)

    const lockButton = screen.getByTestId('overlay-lock-button')
    expect(lockButton).toBeEnabled()

    fireEvent.click(lockButton)

    expect(onLock).not.toHaveBeenCalled()
    expect(screen.getByTestId('lock-rec-confirm-modal')).toBeInTheDocument()
  })

  it('keeps the Lock button enabled when unlocked and REC is off', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} unlocked typingRecordEnabled={false} />)

    expect(screen.getByTestId('overlay-lock-button')).toBeEnabled()
  })

  describe('Security row — locked state', () => {
    it('shows an enabled Unlock button when unlockStatusKnown, and clicking it fires onUnlock only', () => {
      const onUnlock = vi.fn()
      const onLock = vi.fn()
      render(
        <KeycodesOverlayPanel
          {...DEFAULT_PROPS}
          unlocked={false}
          unlockStatusKnown
          onUnlock={onUnlock}
          onLock={onLock}
        />,
      )

      const button = screen.getByTestId('overlay-lock-button')
      expect(button).toHaveTextContent('Unlock')
      expect(button).toBeEnabled()

      fireEvent.click(button)

      expect(onUnlock).toHaveBeenCalledTimes(1)
      expect(onLock).not.toHaveBeenCalled()
    })

    it('disables the Unlock button until unlockStatusKnown, and a click fires nothing', () => {
      const onUnlock = vi.fn()
      render(
        <KeycodesOverlayPanel
          {...DEFAULT_PROPS}
          unlocked={false}
          unlockStatusKnown={false}
          onUnlock={onUnlock}
        />,
      )

      const button = screen.getByTestId('overlay-lock-button')
      expect(button).toBeDisabled()

      fireEvent.click(button)

      expect(onUnlock).not.toHaveBeenCalled()
    })
  })

  describe('Security row — unlocked state', () => {
    it('shows a Lock button that calls onLock directly when REC is off, without opening the confirm modal', () => {
      const onLock = vi.fn()
      render(<KeycodesOverlayPanel {...DEFAULT_PROPS} unlocked typingRecordEnabled={false} onLock={onLock} />)

      const button = screen.getByTestId('overlay-lock-button')
      expect(button).toHaveTextContent('Lock')

      fireEvent.click(button)

      expect(onLock).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('lock-rec-confirm-modal')).not.toBeInTheDocument()
    })

    it('opens the confirm modal instead of locking when REC is armed, without calling onLock or onTypingRecordDisarm yet', () => {
      const onLock = vi.fn()
      const onTypingRecordDisarm = vi.fn()
      render(
        <KeycodesOverlayPanel
          {...DEFAULT_PROPS}
          unlocked
          typingRecordEnabled
          onLock={onLock}
          onTypingRecordDisarm={onTypingRecordDisarm}
        />,
      )

      expect(screen.queryByTestId('lock-rec-confirm-modal')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('overlay-lock-button'))

      expect(screen.getByTestId('lock-rec-confirm-modal')).toBeInTheDocument()
      expect(onLock).not.toHaveBeenCalled()
      expect(onTypingRecordDisarm).not.toHaveBeenCalled()
    })

    it('confirm flow: closes the modal and calls onTypingRecordDisarm then onLock, each once, in order', () => {
      const calls: string[] = []
      const onLock = vi.fn(() => { calls.push('onLock') })
      const onTypingRecordDisarm = vi.fn(() => { calls.push('onTypingRecordDisarm') })
      render(
        <KeycodesOverlayPanel
          {...DEFAULT_PROPS}
          unlocked
          typingRecordEnabled
          onLock={onLock}
          onTypingRecordDisarm={onTypingRecordDisarm}
        />,
      )

      fireEvent.click(screen.getByTestId('overlay-lock-button'))
      expect(screen.getByTestId('lock-rec-confirm-modal')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('lock-rec-confirm-confirm'))

      expect(screen.queryByTestId('lock-rec-confirm-modal')).not.toBeInTheDocument()
      expect(onTypingRecordDisarm).toHaveBeenCalledTimes(1)
      expect(onLock).toHaveBeenCalledTimes(1)
      expect(calls).toEqual(['onTypingRecordDisarm', 'onLock'])
    })

    it('cancel flow: clicking Cancel closes the modal without calling onLock or onTypingRecordDisarm', () => {
      const onLock = vi.fn()
      const onTypingRecordDisarm = vi.fn()
      render(
        <KeycodesOverlayPanel
          {...DEFAULT_PROPS}
          unlocked
          typingRecordEnabled
          onLock={onLock}
          onTypingRecordDisarm={onTypingRecordDisarm}
        />,
      )

      fireEvent.click(screen.getByTestId('overlay-lock-button'))
      expect(screen.getByTestId('lock-rec-confirm-modal')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('lock-rec-confirm-cancel'))

      expect(screen.queryByTestId('lock-rec-confirm-modal')).not.toBeInTheDocument()
      expect(onLock).not.toHaveBeenCalled()
      expect(onTypingRecordDisarm).not.toHaveBeenCalled()
    })

    it('cancel flow: clicking the backdrop closes the modal without calling onLock or onTypingRecordDisarm', () => {
      const onLock = vi.fn()
      const onTypingRecordDisarm = vi.fn()
      render(
        <KeycodesOverlayPanel
          {...DEFAULT_PROPS}
          unlocked
          typingRecordEnabled
          onLock={onLock}
          onTypingRecordDisarm={onTypingRecordDisarm}
        />,
      )

      fireEvent.click(screen.getByTestId('overlay-lock-button'))
      expect(screen.getByTestId('lock-rec-confirm-modal')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('lock-rec-confirm-backdrop'))

      expect(screen.queryByTestId('lock-rec-confirm-modal')).not.toBeInTheDocument()
      expect(onLock).not.toHaveBeenCalled()
      expect(onTypingRecordDisarm).not.toHaveBeenCalled()
    })
  })

  it('shows matrix tester toggle when hasMatrixTester', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} hasMatrixTester onToggleMatrix={vi.fn()} />)

    expect(screen.getByTestId('overlay-matrix-row')).toBeInTheDocument()
  })

  it('resets to tools tab when hasLayoutOptions becomes false', () => {
    const { rerender } = render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    // Starts on layout tab
    expect(screen.getByText('Split Backspace')).toBeInTheDocument()

    // hasLayoutOptions becomes false
    rerender(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    // Should switch to tools tab
    expect(screen.queryByText('Split Backspace')).not.toBeInTheDocument()
    expect(screen.getByTestId('overlay-auto-advance-row')).toBeInTheDocument()
  })

  it('calls onLayoutOptionChange when checkbox toggled', () => {
    const onLayoutOptionChange = vi.fn()
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={onLayoutOptionChange}
      />,
    )

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(onLayoutOptionChange).toHaveBeenCalledWith(0, 1)
  })
})
