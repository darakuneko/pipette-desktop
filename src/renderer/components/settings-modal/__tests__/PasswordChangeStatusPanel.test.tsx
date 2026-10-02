// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PasswordChangeStatusPanel, type PasswordChangeStatusPanelProps } from '../PasswordChangeStatusPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts && 'step' in opts ? `${key}:${String(opts.step)}` : key),
  }),
}))

const REENCRYPTING: PasswordChangeStatusPanelProps['status'] = {
  kind: 'inProgress',
  target: 'new',
  step: 'reencrypting',
  startedAt: 1,
}

function renderPanel(overrides?: Partial<PasswordChangeStatusPanelProps>) {
  const props: PasswordChangeStatusPanelProps = {
    status: REENCRYPTING,
    running: false,
    error: null,
    onResume: vi.fn().mockResolvedValue(true),
    onRevert: vi.fn().mockResolvedValue(true),
    onAbandon: vi.fn().mockResolvedValue(true),
    onDeleteFile: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
  render(<PasswordChangeStatusPanel {...props} />)
  return props
}

describe('PasswordChangeStatusPanel', () => {
  it('describes a change to the new password and its step', () => {
    renderPanel()
    expect(screen.getByTestId('sync-password-change-direction')).toHaveTextContent('sync.passwordChange.toNew')
    expect(screen.getByTestId('sync-password-change-step')).toHaveTextContent(
      'sync.passwordChange.stepLabel:sync.passwordChange.step.reencrypting',
    )
  })

  it('offers Continue and Go Back while re-encrypting', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByTestId('sync-password-change-resume'))
    expect(props.onResume).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('sync-password-change-revert')).toHaveTextContent('sync.passwordChange.revertToOld')
    fireEvent.click(screen.getByTestId('sync-password-change-revert'))
    expect(props.onRevert).toHaveBeenCalledTimes(1)
  })

  it('describes a rollback and offers switching to the new password again', () => {
    renderPanel({ status: { ...REENCRYPTING, target: 'old' } })
    expect(screen.getByTestId('sync-password-change-direction')).toHaveTextContent('sync.passwordChange.toOld')
    expect(screen.getByTestId('sync-password-change-revert')).toHaveTextContent('sync.passwordChange.revertToNew')
  })

  it('offers only Continue at the committing step', () => {
    renderPanel({ status: { ...REENCRYPTING, step: 'committing' } })
    expect(screen.getByTestId('sync-password-change-resume')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-password-change-revert')).not.toBeInTheDocument()
  })

  it('offers Continue as a retry when the saved passwords are unavailable', () => {
    renderPanel({
      status: { kind: 'keysUnavailable', reason: 'keystoreUnavailable', target: 'new', step: 'reencrypting', startedAt: 1 },
    })
    expect(screen.getByTestId('sync-password-change-state')).toHaveTextContent('sync.passwordChange.keysUnavailable')
    expect(screen.getByTestId('sync-password-change-resume')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-password-change-revert')).not.toBeInTheDocument()
  })

  it('shows only the message and Abandon for an unreadable state', () => {
    renderPanel({ status: { kind: 'invalid' } })
    expect(screen.getByTestId('sync-password-change-state')).toHaveTextContent('sync.passwordChange.invalidState')
    expect(screen.queryByTestId('sync-password-change-resume')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sync-password-change-revert')).not.toBeInTheDocument()
    expect(screen.getByTestId('sync-password-change-abandon')).toBeInTheDocument()
  })

  it('notes a lost lock', () => {
    renderPanel({ status: { ...REENCRYPTING, lockLost: true } })
    expect(screen.getByTestId('sync-password-change-lock-lost')).toHaveTextContent('sync.passwordChange.lockLost')
  })

  it('abandons only on the second press, after a warning', async () => {
    const props = renderPanel()
    fireEvent.click(screen.getByTestId('sync-password-change-abandon'))
    expect(props.onAbandon).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-password-change-abandon-row')).toHaveTextContent('sync.passwordChange.abandonWarning')

    fireEvent.click(screen.getByTestId('sync-password-change-abandon-confirm'))
    expect(props.onAbandon).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('sync-password-change-abandon')).toBeInTheDocument())
  })

  it('cancelling the abandon confirmation does nothing', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByTestId('sync-password-change-abandon'))
    fireEvent.click(screen.getByTestId('sync-password-change-abandon-cancel'))
    expect(props.onAbandon).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-password-change-abandon')).toBeInTheDocument()
  })

  it('keeps the confirmation open when abandoning fails', async () => {
    renderPanel({ onAbandon: vi.fn().mockResolvedValue(false) })
    fireEvent.click(screen.getByTestId('sync-password-change-abandon'))
    fireEvent.click(screen.getByTestId('sync-password-change-abandon-confirm'))
    await waitFor(() => expect(screen.getByTestId('sync-password-change-abandon-confirm')).toBeInTheDocument())
  })

  it('lists files neither password opens and deletes one only on the second press', () => {
    const props = renderPanel({
      status: { ...REENCRYPTING, undecryptable: [{ id: 'f1', name: 'favorites_macro.enc' }, { id: 'f2', name: 'keyboards_u_settings.enc' }] },
    })
    expect(screen.getByTestId('sync-password-change-undecryptable')).toHaveTextContent('sync.passwordChange.undecryptable')
    expect(screen.getByTestId('sync-password-change-file-f1')).toHaveTextContent('favorites_macro.enc')

    fireEvent.click(screen.getByTestId('sync-password-change-file-delete-f1'))
    expect(props.onDeleteFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-password-change-file-delete-f2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-password-change-file-confirm-f1'))
    expect(props.onDeleteFile).toHaveBeenCalledWith('f1')
  })

  it('shows the spinner and disables every action while one runs', () => {
    renderPanel({ running: true })
    expect(screen.getByTestId('sync-password-change-running')).toHaveTextContent('sync.passwordChange.working')
    expect(screen.getByTestId('sync-password-change-resume')).toBeDisabled()
    expect(screen.getByTestId('sync-password-change-revert')).toBeDisabled()
    expect(screen.getByTestId('sync-password-change-abandon')).toBeDisabled()
  })

  it('shows the error of the last action', () => {
    renderPanel({ error: 'Another PC is changing the sync password.' })
    expect(screen.getByTestId('sync-password-change-error')).toHaveTextContent('Another PC is changing the sync password.')
  })
})
