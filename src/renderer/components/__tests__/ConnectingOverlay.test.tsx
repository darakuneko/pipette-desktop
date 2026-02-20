// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConnectingOverlay } from '../ConnectingOverlay'
import type { SyncProgress } from '../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('ConnectingOverlay', () => {
  it('renders connecting message with device info', () => {
    render(
      <ConnectingOverlay deviceName="TestKeyboard" deviceId="1234:5678" />,
    )

    expect(screen.getByText('TestKeyboard')).toBeInTheDocument()
    expect(screen.getByText('1234:5678')).toBeInTheDocument()
  })

  it('shows loading progress text', () => {
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        loadingProgress="keyboard.loadingKeymap"
      />,
    )

    expect(screen.getByText('keyboard.loadingKeymap')).toBeInTheDocument()
  })

  it('hides device name and id when empty', () => {
    const { container } = render(
      <ConnectingOverlay deviceName="" deviceId="" syncOnly />,
    )

    // Device info elements should not be rendered at all
    const fontMonoEls = container.querySelectorAll('.font-mono')
    expect(fontMonoEls).toHaveLength(0)
  })

  it('shows sync progress details', () => {
    const progress: SyncProgress = {
      direction: 'download',
      status: 'syncing',
      syncUnit: 'favorites/tapDance',
      current: 2,
      total: 5,
    }
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={progress}
        syncOnly
      />,
    )

    expect(screen.getByText('favorites/tapDance')).toBeInTheDocument()
    expect(screen.getByText('2 / 5')).toBeInTheDocument()
  })

  it('shows error message when sync status is error', () => {
    const progress: SyncProgress = {
      direction: 'download',
      status: 'error',
      message: 'Network failure',
    }
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={progress}
        syncOnly
      />,
    )

    expect(screen.getByText('Network failure')).toBeInTheDocument()
  })

  it('shows warning message when sync status is partial', () => {
    const progress: SyncProgress = {
      direction: 'download',
      status: 'partial',
      message: '2 sync unit(s) failed',
      failedUnits: ['favorites/tapDance', 'favorites/macro'],
    }
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={progress}
        syncOnly
      />,
    )

    const warningEl = screen.getByText('2 sync unit(s) failed')
    expect(warningEl).toBeInTheDocument()
    expect(warningEl.className).toContain('text-warning')
  })

  it('does not show sync details when syncProgress is null', () => {
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={null}
      />,
    )

    expect(screen.queryByText(/\d+ \/ \d+/)).not.toBeInTheDocument()
  })

  it('renders skip button when onSyncSkip is provided', () => {
    const onSkip = vi.fn()
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={null}
        syncOnly
        onSyncSkip={onSkip}
      />,
    )

    expect(screen.getByTestId('sync-overlay-skip')).toBeInTheDocument()
  })

  it('calls onSyncSkip when skip button is clicked', () => {
    const onSkip = vi.fn()
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={null}
        syncOnly
        onSyncSkip={onSkip}
      />,
    )

    fireEvent.click(screen.getByTestId('sync-overlay-skip'))
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('does not render skip button when onSyncSkip is not provided', () => {
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncProgress={null}
        syncOnly
      />,
    )

    expect(screen.queryByTestId('sync-overlay-skip')).not.toBeInTheDocument()
  })

  it('uses syncing text when syncOnly is true', () => {
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        syncOnly
      />,
    )

    expect(screen.getByText('sync.syncing')).toBeInTheDocument()
  })

  it('shows sync progress section alongside loading when both present', () => {
    const progress: SyncProgress = {
      direction: 'download',
      status: 'syncing',
      syncUnit: 'favorites/macro',
      current: 1,
      total: 3,
    }
    render(
      <ConnectingOverlay
        deviceName="TestKeyboard"
        deviceId="1234:5678"
        loadingProgress="keyboard.loadingKeymap"
        syncProgress={progress}
      />,
    )

    expect(screen.getByText('keyboard.loadingKeymap')).toBeInTheDocument()
    expect(screen.getByText('favorites/macro')).toBeInTheDocument()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  })
})
