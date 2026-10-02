// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PasswordChangeLockBanner, type PasswordChangeLockBannerProps } from '../PasswordChangeLockBanner'
import { formatDate } from '../../editors/store-modal-shared'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts && 'time' in opts ? `${key}:${String(opts.time)}` : key),
  }),
}))

const STARTED = '2026-10-02T09:00:00.000Z'

function renderBanner(overrides?: Partial<PasswordChangeLockBannerProps>) {
  const props: PasswordChangeLockBannerProps = {
    lockStatus: { startedAt: STARTED, ownMachine: false },
    running: false,
    error: null,
    onRelease: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
  render(<PasswordChangeLockBanner {...props} />)
  return props
}

describe('PasswordChangeLockBanner', () => {
  it("explains another PC's lock and when it started", () => {
    renderBanner()
    expect(screen.getByTestId('sync-password-change-lock-message')).toHaveTextContent('sync.passwordChange.blockedByOtherDevice')
    expect(screen.getByTestId('sync-password-change-lock-started')).toHaveTextContent(
      `sync.passwordChange.lockStartedAt:${formatDate(STARTED)}`,
    )
  })

  it('uses different wording for a lock this PC left behind', () => {
    renderBanner({ lockStatus: { startedAt: STARTED, ownMachine: true } })
    expect(screen.getByTestId('sync-password-change-lock-message')).toHaveTextContent('sync.passwordChange.ownLockLeft')
  })

  it('omits the start time when the lock is unreadable', () => {
    renderBanner({ lockStatus: { startedAt: null, ownMachine: false } })
    expect(screen.queryByTestId('sync-password-change-lock-started')).not.toBeInTheDocument()
  })

  it('warns on the first press and releases only on the second', async () => {
    const props = renderBanner()
    fireEvent.click(screen.getByTestId('sync-password-change-release'))
    expect(props.onRelease).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-password-change-release-row')).toHaveTextContent('sync.passwordChange.releaseWarning')

    fireEvent.click(screen.getByTestId('sync-password-change-release-confirm'))
    expect(props.onRelease).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('sync-password-change-release')).toBeInTheDocument())
  })

  it('cancel returns to the release button without releasing', () => {
    const props = renderBanner()
    fireEvent.click(screen.getByTestId('sync-password-change-release'))
    fireEvent.click(screen.getByTestId('sync-password-change-release-cancel'))
    expect(props.onRelease).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-password-change-release')).toBeInTheDocument()
  })

  it('shows a release error', () => {
    renderBanner({ error: 'sync.passwordChange.releaseBusy' })
    expect(screen.getByTestId('sync-password-change-lock-error')).toHaveTextContent('sync.passwordChange.releaseBusy')
  })

  it('disables the buttons while an action runs', () => {
    renderBanner({ running: true })
    expect(screen.getByTestId('sync-password-change-release')).toBeDisabled()
  })
})
