// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { UpdateAvailableModal } from '../UpdateAvailableModal'
import { AboutUpdateCheck } from '../AboutUpdateCheck'
import type { UpdatePrompt } from '../../hooks/useUpdateCheck'
import type { UpdateCheckResult, UpdateInstallResult, UpdateProgress } from '../../../shared/types/update'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}))

const RELEASE_URL = 'https://github.com/darakuneko/pipette-desktop/releases/tag/v0.5.0-beta.3'
const AVAILABLE: UpdatePrompt = {
  kind: 'available',
  version: '0.5.0-beta.3',
  currentVersion: '0.5.0-beta.2',
  releaseUrl: RELEASE_URL,
}

let progressListener: ((progress: UpdateProgress) => void) | null
let resolveInstall: (result: UpdateInstallResult) => void
const api = {
  openExternal: vi.fn(() => Promise.resolve()),
  updateInstall: vi.fn(() => new Promise<UpdateInstallResult>((resolve) => { resolveInstall = resolve })),
  updateOnProgress: vi.fn((callback: (progress: UpdateProgress) => void) => {
    progressListener = callback
    return () => { progressListener = null }
  }),
  updateCheck: vi.fn<() => Promise<UpdateCheckResult>>(),
}

beforeEach(() => {
  vi.clearAllMocks()
  progressListener = null
  Object.defineProperty(window, 'vialAPI', { value: api, writable: true, configurable: true })
})

describe('UpdateAvailableModal', () => {
  it('offers the three buttons and opens the release page in the browser', () => {
    const onClose = vi.fn()
    const onSkip = vi.fn()
    render(<UpdateAvailableModal prompt={AVAILABLE} onClose={onClose} onSkip={onSkip} />)
    expect(screen.getByTestId('update-modal-message').textContent).toContain('0.5.0-beta.3')
    fireEvent.click(screen.getByTestId('update-modal-release-link'))
    expect(api.openExternal).toHaveBeenCalledWith(RELEASE_URL)
    fireEvent.click(screen.getByTestId('update-modal-skip'))
    expect(onSkip).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('update-modal-later'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the progress while updating and cannot be closed', async () => {
    const onClose = vi.fn()
    render(<UpdateAvailableModal prompt={AVAILABLE} onClose={onClose} />)
    expect(screen.queryByTestId('update-modal-skip')).toBeNull()
    fireEvent.click(screen.getByTestId('update-modal-install'))
    expect(api.updateInstall).toHaveBeenCalledWith('0.5.0-beta.3')
    act(() => progressListener?.({ downloaded: 50, total: 200 }))
    expect(screen.getByTestId('update-modal-progress').textContent).toContain('"percent":25')
    act(() => progressListener?.({ downloaded: 3 * 1024 * 1024, total: null }))
    expect(screen.getByTestId('update-modal-progress').textContent).toContain('"size":"3.0"')
    expect(screen.queryByTestId('update-modal-close')).toBeNull()
    fireEvent.click(screen.getByTestId('update-modal-backdrop'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolveInstall({ status: 'restarting' }))
    expect(screen.getByTestId('update-modal-restarting')).toBeTruthy()
  })

  it('maps a failure to its message and offers to try again', async () => {
    render(<UpdateAvailableModal prompt={AVAILABLE} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('update-modal-install'))
    await act(async () => resolveInstall({ status: 'failed', code: 'signature', releaseUrl: RELEASE_URL }))
    expect(screen.getByTestId('update-modal-error').textContent).toContain('update.error.signature')
    expect(screen.getByTestId('update-modal-install').textContent).toBe('update.retry')
  })

  it('shows the failure the last update left with the release page only', () => {
    const onClose = vi.fn()
    render(
      <UpdateAvailableModal
        prompt={{ kind: 'failed', version: '0.5.0-beta.3', code: 'permission', releaseUrl: RELEASE_URL }}
        onClose={onClose}
      />,
    )
    expect(screen.getByTestId('update-modal-error').textContent).toContain('update.error.permission')
    expect(screen.queryByTestId('update-modal-install')).toBeNull()
    fireEvent.click(screen.getByTestId('update-modal-release-link'))
    expect(api.openExternal).toHaveBeenCalledWith(RELEASE_URL)
    fireEvent.click(screen.getByTestId('update-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('UpdateAvailableModal, a previous app that was not put back', () => {
  it('says where the copy of the previous app was kept', () => {
    render(
      <UpdateAvailableModal
        prompt={{ kind: 'failed', version: '0.5.0-beta.3', code: 'previousAppNotRestored', releaseUrl: RELEASE_URL, backupPath: '/tmp/tauri_current_app1/Pipette.app' }}
        onClose={vi.fn()}
      />,
    )
    const text = screen.getByTestId('update-modal-error').textContent ?? ''
    expect(text).toContain('update.error.previousAppNotRestored')
    expect(text).toContain('/tmp/tauri_current_app1/Pipette.app')
    expect(screen.getByTestId('update-modal-release-link')).toBeTruthy()
  })
})

describe('AboutUpdateCheck', () => {
  async function checkWith(result: UpdateCheckResult): Promise<string> {
    api.updateCheck.mockResolvedValueOnce(result)
    await act(async () => {
      fireEvent.click(screen.getByTestId('about-update-check'))
    })
    return screen.getByTestId('about-update-result').textContent ?? ''
  }

  it('shows what each check found, a skipped version included', async () => {
    render(<AboutUpdateCheck />)
    expect(await checkWith({ status: 'upToDate' })).toBe('update.about.upToDate')
    expect(await checkWith({ status: 'disabled' })).toBe('update.about.disabled')
    expect(await checkWith({ status: 'failed', code: 'network' })).toBe('update.error.network')
    const skipped = await checkWith({ status: 'available', version: '0.5.0-beta.3', currentVersion: '0.5.0-beta.2', releaseUrl: RELEASE_URL, skipped: true })
    expect(skipped).toContain('update.about.availableSkipped')
    expect(screen.getByTestId('about-update-open').textContent).toBe('update.about.open {"version":"0.5.0-beta.3"}')
    fireEvent.click(screen.getByTestId('about-update-open'))
    expect(screen.getByTestId('update-modal')).toBeTruthy()
    expect(screen.queryByTestId('update-modal-skip')).toBeNull()
  })
})
