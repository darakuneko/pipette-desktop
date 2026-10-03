// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SyncUpdateBanner, PIPETTE_RELEASES_URL } from '../SyncUpdateBanner'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const openExternal = vi.fn(async (_url: string) => {})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'vialAPI', { value: { openExternal }, writable: true, configurable: true })
})

describe('SyncUpdateBanner', () => {
  it('renders nothing when hidden', () => {
    render(<SyncUpdateBanner state={{ visible: false, dismiss: vi.fn() }} />)

    expect(screen.queryByTestId('sync-update-banner')).toBeNull()
  })

  it('shows the message with the download and close buttons', () => {
    render(<SyncUpdateBanner state={{ visible: true, dismiss: vi.fn() }} />)

    expect(screen.getByTestId('sync-update-banner')).toHaveTextContent('sync.updateBanner.message')
    expect(screen.getByTestId('sync-update-download')).toHaveTextContent('sync.updateBanner.openDownloadPage')
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument()
  })

  it('opens the latest release page', () => {
    render(<SyncUpdateBanner state={{ visible: true, dismiss: vi.fn() }} />)

    fireEvent.click(screen.getByTestId('sync-update-download'))

    expect(PIPETTE_RELEASES_URL).toBe('https://github.com/darakuneko/pipette-desktop/releases/latest')
    expect(openExternal).toHaveBeenCalledWith(PIPETTE_RELEASES_URL)
  })

  it('the close button dismisses it', () => {
    const dismiss = vi.fn()
    render(<SyncUpdateBanner state={{ visible: true, dismiss }} />)

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))

    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
