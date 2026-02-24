// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusBar } from '../StatusBar'

const TRANSLATIONS: Record<string, string> = {
  'editor.typingTest.switchToTypingMode': 'Switch to Typing Mode',
  'statusBar.autoAdvance': 'Auto Move',
  'statusBar.locked': 'Locked',
  'statusBar.unlocked': 'Unlocked',
  'statusBar.keyTester': 'Key Tester',
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
    expect(screen.getByTestId('typing-test-button')).toBeInTheDocument()
    expect(screen.getByText('Switch to Typing Mode')).toBeInTheDocument()
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

})
