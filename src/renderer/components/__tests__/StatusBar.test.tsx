// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusBar } from '../StatusBar'

const TRANSLATIONS: Record<string, string> = {
  'editor.typingTest.switchToTypingMode': 'Switch to Typing Mode',
  'editor.typingTest.exitTypingMode': 'Exit Typing Test',
  'editor.typingTest.viewOnly': 'Typing View',
  'editor.typingTest.recordingIndicator': 'Recording',
  'statusBar.autoAdvance': 'Auto Move',
  'statusBar.locked': 'Locked',
  'statusBar.unlocked': 'Unlocked',
  'statusBar.typingGroup': 'Typing:',
  'statusBar.typingViewShort': 'View',
  'statusBar.typingTestShort': 'Test',
  'statusBar.typingTestExitShort': 'Exit Test',
  'statusBar.typingRecordShort': 'Record',
  'editor.keyTester.title': 'Key Tester',
  'app.analyzeTab': 'Analyze',
  'statusBar.sync.pending': 'Pending',
  'statusBar.sync.syncing': 'Syncing...',
  'statusBar.sync.synced': 'Synced',
  'statusBar.sync.error': 'Error',
  'statusBar.sync.partial': 'Partial',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'app.connectedTo' && opts?.name) return `Connected to ${opts.name}`
      return TRANSLATIONS[key] ?? key
    },
  }),
}))

vi.mock('../QuickSettingsSelects', () => ({
  QuickSettingsSelects: () => null,
}))

vi.mock('../TypingRecordModal', () => ({
  TypingRecordModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="typing-record-modal-stub">
      <button type="button" data-testid="typing-record-modal-stub-close" onClick={onClose}>close</button>
    </div>
  ),
}))

describe('StatusBar', () => {
  const defaultProps = {
    deviceName: 'My Keyboard',
    autoAdvance: true,
    unlocked: false,
    syncStatus: 'none' as const,
    matrixMode: false,
  }

  it('renders device name without "Connected to" prefix', () => {
    render(<StatusBar {...defaultProps} />)
    expect(screen.getByText('My Keyboard')).toBeInTheDocument()
    expect(screen.queryByText('Connected to My Keyboard')).not.toBeInTheDocument()
  })

  it('renders typing mode button when hasMatrixTester and onTypingTestModeChange', () => {
    render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingTestModeChange={vi.fn()} />)
    const button = screen.getByTestId('typing-test-button')
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('Test')
    expect(button).toHaveAttribute('aria-label', 'Switch to Typing Mode')
  })

  it('shows "Exit Test" label when typing test mode is active', () => {
    render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingTestModeChange={vi.fn()} typingTestMode={true} />)
    const button = screen.getByTestId('typing-test-button')
    expect(button.textContent).toBe('Exit Test')
    expect(button).toHaveAttribute('aria-label', 'Exit Typing Test')
  })

  it('calls onTypingTestModeChange when typing mode button clicked', () => {
    const onTypingTestModeChange = vi.fn()
    render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingTestModeChange={onTypingTestModeChange} />)
    fireEvent.click(screen.getByTestId('typing-test-button'))
    expect(onTypingTestModeChange).toHaveBeenCalledOnce()
  })

  it('renders different device names', () => {
    render(<StatusBar {...defaultProps} deviceName="Planck EZ" />)
    expect(screen.getByText('Planck EZ')).toBeInTheDocument()
  })

  it('renders as a flex container with correct structure', () => {
    const { container } = render(<StatusBar {...defaultProps} />)
    const root = container.firstElementChild
    expect(root?.tagName).toBe('DIV')
    expect(root?.children.length).toBe(2)
  })

  describe('auto advance status text', () => {
    it('shows "Auto Move" when autoAdvance is true', () => {
      render(<StatusBar {...defaultProps} autoAdvance={true} />)
      const status = screen.getByTestId('auto-advance-status')
      expect(status).toHaveTextContent('Auto Move')
    })

    it('hides auto advance status when autoAdvance is false', () => {
      render(<StatusBar {...defaultProps} autoAdvance={false} />)
      expect(screen.queryByTestId('auto-advance-status')).not.toBeInTheDocument()
    })
  })

  describe('lock status text', () => {
    it('shows "Locked" when unlocked is false', () => {
      render(<StatusBar {...defaultProps} unlocked={false} />)
      const lockStatus = screen.getByTestId('lock-status')
      expect(lockStatus).toHaveTextContent('Locked')
    })

    it('shows "Unlocked" when unlocked is true', () => {
      render(<StatusBar {...defaultProps} unlocked={true} />)
      const lockStatus = screen.getByTestId('lock-status')
      expect(lockStatus).toHaveTextContent('Unlocked')
    })
  })

  describe('sync status text', () => {
    it('shows "Pending" with pending class when syncStatus is pending', () => {
      render(<StatusBar {...defaultProps} syncStatus="pending" />)
      const syncStatus = screen.getByTestId('sync-status')
      expect(syncStatus).toHaveTextContent('Pending')
      expect(syncStatus.className).toContain('text-pending')
    })

    it('shows "Syncing..." with animate-pulse when syncStatus is syncing', () => {
      render(<StatusBar {...defaultProps} syncStatus="syncing" />)
      const syncStatus = screen.getByTestId('sync-status')
      expect(syncStatus).toHaveTextContent('Syncing...')
      expect(syncStatus.className).toContain('animate-pulse')
    })

    it('shows "Synced" with accent class when syncStatus is synced', () => {
      render(<StatusBar {...defaultProps} syncStatus="synced" />)
      const syncStatus = screen.getByTestId('sync-status')
      expect(syncStatus).toHaveTextContent('Synced')
      expect(syncStatus.className).toContain('text-accent')
    })

    it('shows "Error" with danger class when syncStatus is error', () => {
      render(<StatusBar {...defaultProps} syncStatus="error" />)
      const syncStatus = screen.getByTestId('sync-status')
      expect(syncStatus).toHaveTextContent('Error')
      expect(syncStatus.className).toContain('text-danger')
    })

    it('shows "Partial" with warning class when syncStatus is partial', () => {
      render(<StatusBar {...defaultProps} syncStatus="partial" />)
      const syncStatus = screen.getByTestId('sync-status')
      expect(syncStatus).toHaveTextContent('Partial')
      expect(syncStatus.className).toContain('text-warning')
      expect(syncStatus.className).not.toContain('animate-pulse')
    })

    it('does not render sync status when syncStatus is none', () => {
      render(<StatusBar {...defaultProps} syncStatus="none" />)
      expect(screen.queryByTestId('sync-status')).not.toBeInTheDocument()
    })
  })

  describe('key tester status text', () => {
    it('does not render key tester status when matrixMode is off', () => {
      render(<StatusBar {...defaultProps} matrixMode={false} />)
      expect(screen.queryByTestId('matrix-status')).not.toBeInTheDocument()
    })

    it('shows "Key Tester" when matrixMode is on', () => {
      render(<StatusBar {...defaultProps} matrixMode={true} />)
      const status = screen.getByTestId('matrix-status')
      expect(status).toHaveTextContent('Key Tester')
    })

    it('places key tester status before lock status', () => {
      render(<StatusBar {...defaultProps} matrixMode={true} syncStatus="synced" />)
      const leftSection = screen.getByTestId('status-bar').firstElementChild!
      const items = Array.from(leftSection.children)
      const matrixIdx = items.findIndex(el => el.getAttribute('data-testid') === 'matrix-status')
      const lockIdx = items.findIndex(el => el.getAttribute('data-testid') === 'lock-status')
      const syncIdx = items.findIndex(el => el.getAttribute('data-testid') === 'sync-status')
      expect(matrixIdx).toBeLessThan(lockIdx)
      expect(lockIdx).toBeLessThan(syncIdx)
    })
  })

  describe('analyze button', () => {
    it('renders when onOpenAnalyze is provided and typing test mode is off', () => {
      render(<StatusBar {...defaultProps} onOpenAnalyze={vi.fn()} />)
      const button = screen.getByTestId('status-analyze-button')
      expect(button).toBeInTheDocument()
      expect(button).toHaveTextContent('Analyze')
    })

    it('is hidden when typing test mode is active', () => {
      render(<StatusBar {...defaultProps} onOpenAnalyze={vi.fn()} typingTestMode={true} />)
      expect(screen.queryByTestId('status-analyze-button')).not.toBeInTheDocument()
    })

    it('is not rendered when onOpenAnalyze is not provided', () => {
      render(<StatusBar {...defaultProps} />)
      expect(screen.queryByTestId('status-analyze-button')).not.toBeInTheDocument()
    })

    it('calls onOpenAnalyze when clicked', () => {
      const onOpenAnalyze = vi.fn()
      render(<StatusBar {...defaultProps} onOpenAnalyze={onOpenAnalyze} />)
      fireEvent.click(screen.getByTestId('status-analyze-button'))
      expect(onOpenAnalyze).toHaveBeenCalledOnce()
    })

    it('is disabled while a keymap rewrite is in flight (analyzeDisabled) and does not fire on click', () => {
      const onOpenAnalyze = vi.fn()
      render(<StatusBar {...defaultProps} onOpenAnalyze={onOpenAnalyze} analyzeDisabled={true} />)
      const button = screen.getByTestId('status-analyze-button')
      expect(button).toBeDisabled()
      fireEvent.click(button)
      expect(onOpenAnalyze).not.toHaveBeenCalled()
    })

    it('is enabled when analyzeDisabled is not set', () => {
      render(<StatusBar {...defaultProps} onOpenAnalyze={vi.fn()} />)
      expect(screen.getByTestId('status-analyze-button')).not.toBeDisabled()
    })

    it('renders before the Typing group (Analyze | Typing: View Test Record order)', () => {
      render(
        <StatusBar
          {...defaultProps}
          onOpenAnalyze={vi.fn()}
          onViewOnlyChange={vi.fn()}
          onTypingTestModeChange={vi.fn()}
          onTypingRecordEnabledChange={vi.fn()}
          hasMatrixTester={true}
        />
      )
      const rightSection = screen.getByTestId('status-bar').lastElementChild!
      const items = Array.from(rightSection.children)
      const analyzeIdx = items.findIndex(el => el.getAttribute('data-testid') === 'status-analyze-button')
      const groupLabelIdx = items.findIndex(el => el.textContent === 'Typing:')
      const viewOnlyIdx = items.findIndex(el => el.getAttribute('data-testid') === 'view-only-button')
      const typingTestIdx = items.findIndex(el => el.getAttribute('data-testid') === 'typing-test-button')
      const recordIdx = items.findIndex(el => el.getAttribute('data-testid') === 'typing-record-button')
      expect(analyzeIdx).toBeGreaterThanOrEqual(0)
      expect(analyzeIdx).toBeLessThan(groupLabelIdx)
      expect(groupLabelIdx).toBeLessThan(viewOnlyIdx)
      expect(viewOnlyIdx).toBeLessThan(typingTestIdx)
      expect(typingTestIdx).toBeLessThan(recordIdx)
    })

    it('keeps the typing-test-mode Analyze (view-analytics) before the Typing group too', () => {
      render(
        <StatusBar
          {...defaultProps}
          typingTestMode={true}
          onViewAnalytics={vi.fn()}
          onTypingTestModeChange={vi.fn()}
          onTypingRecordEnabledChange={vi.fn()}
          hasMatrixTester={true}
        />
      )
      const rightSection = screen.getByTestId('status-bar').lastElementChild!
      const items = Array.from(rightSection.children)
      const analyzeIdx = items.findIndex(el => el.getAttribute('data-testid') === 'status-view-analytics')
      const groupLabelIdx = items.findIndex(el => el.textContent === 'Typing:')
      const typingTestIdx = items.findIndex(el => el.getAttribute('data-testid') === 'typing-test-button')
      const recordIdx = items.findIndex(el => el.getAttribute('data-testid') === 'typing-record-button')
      expect(analyzeIdx).toBeGreaterThanOrEqual(0)
      expect(analyzeIdx).toBeLessThan(groupLabelIdx)
      // The separator between the Analyze slot and the group label exists.
      expect(items.slice(analyzeIdx + 1, groupLabelIdx).some(el => el.textContent === '|')).toBe(true)
      expect(groupLabelIdx).toBeLessThan(typingTestIdx)
      expect(typingTestIdx).toBeLessThan(recordIdx)
    })

    it('shows a separator between the Analyze button and the Typing group', () => {
      render(
        <StatusBar
          {...defaultProps}
          onOpenAnalyze={vi.fn()}
          onTypingTestModeChange={vi.fn()}
          hasMatrixTester={true}
        />
      )
      const rightSection = screen.getByTestId('status-bar').lastElementChild!
      const items = Array.from(rightSection.children)
      const analyzeIdx = items.findIndex(el => el.getAttribute('data-testid') === 'status-analyze-button')
      const groupLabelIdx = items.findIndex(el => el.textContent === 'Typing:')
      const separatorIdx = items.findIndex((el, i) => i > analyzeIdx && i < groupLabelIdx && el.tagName === 'SPAN' && el.textContent === '|')
      expect(separatorIdx).toBeGreaterThan(analyzeIdx)
      expect(separatorIdx).toBeLessThan(groupLabelIdx)
    })

    it('shows a separator between quick settings and the Analyze button even without matrix tester support', () => {
      render(
        <StatusBar
          {...defaultProps}
          onOpenAnalyze={vi.fn()}
          quickSettings={{
            onThemeChange: vi.fn(),
          }}
        />
      )
      const rightSection = screen.getByTestId('status-bar').lastElementChild!
      const items = Array.from(rightSection.children)
      const separatorIdx = items.findIndex(el => el.tagName === 'SPAN' && el.textContent === '|')
      const analyzeIdx = items.findIndex(el => el.getAttribute('data-testid') === 'status-analyze-button')
      expect(separatorIdx).toBeGreaterThanOrEqual(0)
      expect(separatorIdx).toBeLessThan(analyzeIdx)
    })
  })

  describe('record button and modal', () => {
    it('is not rendered when onTypingRecordEnabledChange is not provided', () => {
      render(<StatusBar {...defaultProps} hasMatrixTester={true} />)
      expect(screen.queryByTestId('typing-record-button')).not.toBeInTheDocument()
    })

    it('is not rendered when hasMatrixTester is false', () => {
      render(<StatusBar {...defaultProps} onTypingRecordEnabledChange={vi.fn()} />)
      expect(screen.queryByTestId('typing-record-button')).not.toBeInTheDocument()
    })

    it('renders with the short "Record" label and aria-haspopup="dialog"', () => {
      render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingRecordEnabledChange={vi.fn()} />)
      const button = screen.getByTestId('typing-record-button')
      expect(button).toHaveTextContent('Record')
      expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    })

    it('uses the active style when typingRecordEnabled is true', () => {
      render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingRecordEnabledChange={vi.fn()} typingRecordEnabled={true} />)
      expect(screen.getByTestId('typing-record-button').className).toContain('text-accent')
    })

    it('uses the inactive style when typingRecordEnabled is false', () => {
      render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingRecordEnabledChange={vi.fn()} typingRecordEnabled={false} />)
      expect(screen.getByTestId('typing-record-button').className).not.toContain('text-accent')
    })

    it('opens the TypingRecordModal when clicked, and the modal can close itself', () => {
      render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingRecordEnabledChange={vi.fn()} />)
      expect(screen.queryByTestId('typing-record-modal-stub')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('typing-record-button'))
      expect(screen.getByTestId('typing-record-modal-stub')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('typing-record-modal-stub-close'))
      expect(screen.queryByTestId('typing-record-modal-stub')).not.toBeInTheDocument()
    })

    it('is present under the same condition as the Test button even outside typing test mode', () => {
      render(<StatusBar {...defaultProps} hasMatrixTester={true} onTypingRecordEnabledChange={vi.fn()} typingTestMode={true} />)
      expect(screen.getByTestId('typing-record-button')).toBeInTheDocument()
    })
  })

  describe('recording status (footer left side)', () => {
    it('does not render when typingRecordEnabled is false', () => {
      render(<StatusBar {...defaultProps} typingRecordEnabled={false} />)
      expect(screen.queryByTestId('recording-status')).not.toBeInTheDocument()
    })

    it('renders "Recording" when typingRecordEnabled is true, regardless of hubConnected', () => {
      render(<StatusBar {...defaultProps} typingRecordEnabled={true} />)
      const status = screen.getByTestId('recording-status')
      expect(status).toHaveTextContent('Recording')
      expect(status.className).toContain('text-accent')
    })

    it('renders alongside the hub status when both are present', () => {
      render(<StatusBar {...defaultProps} typingRecordEnabled={true} hubConnected={false} />)
      expect(screen.getByTestId('hub-status')).toBeInTheDocument()
      expect(screen.getByTestId('recording-status')).toBeInTheDocument()
    })
  })

  describe('loaded label', () => {
    it('shows loaded label next to device name when provided', () => {
      render(<StatusBar {...defaultProps} loadedLabel="My Layout" />)
      expect(screen.getByTestId('loaded-label')).toHaveTextContent('My Layout')
    })

    it('does not render loaded label when empty string', () => {
      render(<StatusBar {...defaultProps} loadedLabel="" />)
      expect(screen.queryByTestId('loaded-label')).not.toBeInTheDocument()
    })

    it('does not render loaded label when not provided', () => {
      render(<StatusBar {...defaultProps} />)
      expect(screen.queryByTestId('loaded-label')).not.toBeInTheDocument()
    })
  })

  describe('footer overflow (Task-typing-record-footer min-width fix)', () => {
    it('keeps the bar root and both sides as a single non-wrapping flex row with a min-w-0 shrink chain', () => {
      const { container } = render(<StatusBar {...defaultProps} />)
      const root = container.firstElementChild as HTMLElement
      expect(root.className).toContain('flex-nowrap')
      const [left, right] = Array.from(root.children) as HTMLElement[]
      expect(left.className).toContain('min-w-0')
      expect(left.className).toContain('flex-nowrap')
      expect(right.className).toContain('min-w-0')
      expect(right.className).toContain('flex-nowrap')
    })

    it('truncates the device name instead of letting it wrap, while giving it a shrink floor', () => {
      render(<StatusBar {...defaultProps} deviceName="leneko54R" />)
      const name = screen.getByTestId('status-device-name')
      expect(name.className).toContain('truncate')
      expect(name.className).toContain('min-w-10')
      expect(name.className).toContain('flex-1')
    })

    it('marks fixed-size status text and separators shrink-0 so only the device name gives up space', () => {
      render(<StatusBar {...defaultProps} syncStatus="synced" hubConnected={true} />)
      expect(screen.getByTestId('lock-status').className).toContain('shrink-0')
      expect(screen.getByTestId('sync-status').className).toContain('shrink-0')
      expect(screen.getByTestId('hub-status').className).toContain('shrink-0')
    })

    it('marks the typing-mode buttons and disconnect button shrink-0 so they never shrink or wrap', () => {
      render(
        <StatusBar
          {...defaultProps}
          hasMatrixTester={true}
          onTypingTestModeChange={vi.fn()}
          onDisconnect={vi.fn()}
        />,
      )
      expect(screen.getByTestId('typing-test-button').className).toContain('shrink-0')
      expect(screen.getByTestId('typing-test-button').className).toContain('whitespace-nowrap')
      expect(screen.getByTestId('disconnect-button').className).toContain('shrink-0')
      expect(screen.getByTestId('disconnect-button').className).toContain('whitespace-nowrap')
    })
  })

})
