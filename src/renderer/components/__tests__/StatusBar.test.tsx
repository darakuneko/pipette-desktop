// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusBar } from '../StatusBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'app.connectedTo' && opts?.name) return `Connected to ${opts.name}`
      if (key === 'common.disconnect') return 'Disconnect'
      if (key === 'statusBar.autoAdvance') return 'Auto Move'
      if (key === 'statusBar.locked') return 'Locked'
      if (key === 'statusBar.unlocked') return 'Unlocked'
      if (key === 'statusBar.keyTester') return 'Key Tester'
      if (key === 'statusBar.sync.pending') return 'Pending'
      if (key === 'statusBar.sync.syncing') return 'Syncing...'
      if (key === 'statusBar.sync.synced') return 'Synced'
      if (key === 'statusBar.sync.error') return 'Error'
      if (key === 'sync.cancelPending') return 'Cancel'
      return key
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
    onDisconnect: vi.fn(),
  }

  it('renders device name without "Connected to" prefix', () => {
    render(<StatusBar {...defaultProps} />)
    expect(screen.getByText('My Keyboard')).toBeInTheDocument()
    expect(screen.queryByText('Connected to My Keyboard')).not.toBeInTheDocument()
  })

  it('renders disconnect button', () => {
    render(<StatusBar {...defaultProps} />)
    expect(screen.getByText('Disconnect')).toBeInTheDocument()
  })

  it('calls onDisconnect when button clicked', () => {
    const onDisconnect = vi.fn()
    render(<StatusBar {...defaultProps} onDisconnect={onDisconnect} />)
    fireEvent.click(screen.getByText('Disconnect'))
    expect(onDisconnect).toHaveBeenCalledOnce()
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
      expect(screen.getByTestId('loaded-label')).toHaveTextContent('— My Layout')
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

  describe('cancel pending button', () => {
    it('shows Cancel button when syncStatus is pending and onCancelPending is provided', () => {
      const onCancelPending = vi.fn()
      render(<StatusBar {...defaultProps} syncStatus="pending" onCancelPending={onCancelPending} />)
      expect(screen.getByTestId('sync-cancel-pending')).toHaveTextContent('Cancel')
    })

    it('does not show Cancel button when syncStatus is not pending', () => {
      const onCancelPending = vi.fn()
      render(<StatusBar {...defaultProps} syncStatus="syncing" onCancelPending={onCancelPending} />)
      expect(screen.queryByTestId('sync-cancel-pending')).not.toBeInTheDocument()
    })

    it('does not show Cancel button when onCancelPending is not provided', () => {
      render(<StatusBar {...defaultProps} syncStatus="pending" />)
      expect(screen.queryByTestId('sync-cancel-pending')).not.toBeInTheDocument()
    })

    it('calls onCancelPending when Cancel button is clicked', () => {
      const onCancelPending = vi.fn()
      render(<StatusBar {...defaultProps} syncStatus="pending" onCancelPending={onCancelPending} />)
      fireEvent.click(screen.getByTestId('sync-cancel-pending'))
      expect(onCancelPending).toHaveBeenCalledOnce()
    })
  })
})
