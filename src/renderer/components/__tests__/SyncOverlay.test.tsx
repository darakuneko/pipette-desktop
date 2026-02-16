// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SyncOverlay } from '../SyncOverlay'
import type { SyncProgress } from '../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('SyncOverlay', () => {
  it('renders syncing message and skip button', () => {
    const onSkip = vi.fn()
    render(<SyncOverlay progress={null} onSkip={onSkip} />)

    expect(screen.getByText('sync.syncing')).toBeInTheDocument()
    expect(screen.getByTestId('sync-overlay-skip')).toBeInTheDocument()
  })

  it('calls onSkip when skip button is clicked', () => {
    const onSkip = vi.fn()
    render(<SyncOverlay progress={null} onSkip={onSkip} />)

    fireEvent.click(screen.getByTestId('sync-overlay-skip'))
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('shows progress details when progress is provided', () => {
    const progress: SyncProgress = {
      direction: 'download',
      status: 'syncing',
      syncUnit: 'favorites/tapDance',
      current: 2,
      total: 5,
    }
    render(<SyncOverlay progress={progress} onSkip={vi.fn()} />)

    expect(screen.getByText('favorites/tapDance')).toBeInTheDocument()
    expect(screen.getByText('2 / 5')).toBeInTheDocument()
  })

  it('shows error message when progress status is error', () => {
    const progress: SyncProgress = {
      direction: 'download',
      status: 'error',
      message: 'Network failure',
    }
    render(<SyncOverlay progress={progress} onSkip={vi.fn()} />)

    expect(screen.getByText('Network failure')).toBeInTheDocument()
  })

  it('does not show progress details when progress is null', () => {
    render(<SyncOverlay progress={null} onSkip={vi.fn()} />)

    expect(screen.queryByText(/\d+ \/ \d+/)).not.toBeInTheDocument()
  })
})
