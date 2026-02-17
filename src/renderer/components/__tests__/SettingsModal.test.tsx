// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from '../SettingsModal'
import type { UseSyncReturn } from '../../hooks/useSync'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT } from '../../../shared/types/hub'
import { DEFAULT_APP_CONFIG } from '../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../assets/app-icon.png', () => ({ default: 'test-app-icon.png' }))

vi.mock('../editors/ModalCloseButton', () => ({
  ModalCloseButton: ({ testid, onClick }: { testid: string; onClick: () => void }) => (
    <button data-testid={testid} onClick={onClick}>close</button>
  ),
}))

const mockResetLocalTargets = vi.fn().mockResolvedValue({ success: true })
const mockExportLocalData = vi.fn().mockResolvedValue({ success: true })
const mockImportLocalData = vi.fn().mockResolvedValue({ success: true })
const mockOpenExternal = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(window, 'vialAPI', {
  value: {
    resetLocalTargets: mockResetLocalTargets,
    exportLocalData: mockExportLocalData,
    importLocalData: mockImportLocalData,
    openExternal: mockOpenExternal,
  },
  writable: true,
})

const FULLY_CONFIGURED: Partial<UseSyncReturn> = {
  authStatus: { authenticated: true },
  hasPassword: true,
  config: { autoSync: false },
}

const SYNC_ENABLED: Partial<UseSyncReturn> = {
  ...FULLY_CONFIGURED,
  config: { autoSync: true },
}

function makeSyncMock(overrides?: Partial<UseSyncReturn>): UseSyncReturn {
  return {
    config: { ...DEFAULT_APP_CONFIG },
    authStatus: { authenticated: false },
    hasPassword: false,
    hasPendingChanges: false,
    progress: null,
    lastSyncResult: null,
    syncStatus: 'none',
    loading: false,
    startAuth: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn().mockResolvedValue(undefined),
    setPassword: vi.fn().mockResolvedValue({ success: true }),
    resetPassword: vi.fn().mockResolvedValue({ success: true }),
    resetSyncTargets: vi.fn().mockResolvedValue({ success: true }),
    validatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
    syncNow: vi.fn().mockResolvedValue(undefined),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const defaultProps = {
  theme: 'system' as const,
  onThemeChange: vi.fn(),
  defaultLayout: 'qwerty',
  onDefaultLayoutChange: vi.fn(),
  defaultAutoAdvance: true,
  onDefaultAutoAdvanceChange: vi.fn(),
  autoLockTime: 10 as const,
  onAutoLockTimeChange: vi.fn(),
  panelSide: 'left' as const,
  onPanelSideChange: vi.fn(),
  hubEnabled: true,
  onHubEnabledChange: vi.fn(),
  hubPosts: [] as { id: string; title: string; keyboard_name: string; created_at: string }[],
  hubAuthenticated: false,
  onHubRename: vi.fn().mockResolvedValue(undefined),
  onHubDelete: vi.fn().mockResolvedValue(undefined),
}

describe('SettingsModal', () => {
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    defaultProps.onThemeChange = vi.fn()
    defaultProps.onDefaultLayoutChange = vi.fn()
    defaultProps.onDefaultAutoAdvanceChange = vi.fn()
    defaultProps.onAutoLockTimeChange = vi.fn()
    defaultProps.onPanelSideChange = vi.fn()
    defaultProps.onHubEnabledChange = vi.fn()
    defaultProps.onHubRename = vi.fn().mockResolvedValue(undefined)
    defaultProps.onHubDelete = vi.fn().mockResolvedValue(undefined)
    defaultProps.hubPosts = []
    defaultProps.hubAuthenticated = false
    mockResetLocalTargets.mockClear()
    mockExportLocalData.mockClear()
    mockImportLocalData.mockClear()
    mockOpenExternal.mockClear()
  })

  function renderAndSwitchToTools(props?: Partial<Parameters<typeof SettingsModal>[0]>) {
    const result = render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} {...props} />)
    fireEvent.click(screen.getByTestId('settings-tab-tools'))
    return result
  }

  function renderAndSwitchToData(props?: Partial<Parameters<typeof SettingsModal>[0]>) {
    const result = render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} {...props} />)
    fireEvent.click(screen.getByTestId('settings-tab-data'))
    return result
  }

  it('renders sign-in button when not authenticated', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('sync-sign-in')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-sign-out')).not.toBeInTheDocument()
  })

  it('renders connected status and sign-out when authenticated', () => {
    renderAndSwitchToData({ sync: makeSyncMock({ authStatus: { authenticated: true } }) })

    expect(screen.getByTestId('sync-auth-status')).toBeInTheDocument()
    expect(screen.getByTestId('sync-sign-out')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-sign-in')).not.toBeInTheDocument()
  })

  it('calls startAuth when sign-in button is clicked', () => {
    const sync = makeSyncMock()
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-sign-in'))
    expect(sync.startAuth).toHaveBeenCalledOnce()
  })

  it('shows confirmation when sign-out button is clicked', () => {
    const sync = makeSyncMock({ authStatus: { authenticated: true } })
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-sign-out'))
    expect(screen.getByTestId('sync-sign-out-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('sync-sign-out-cancel')).toBeInTheDocument()
    expect(sync.signOut).not.toHaveBeenCalled()
  })

  it('calls signOut and disables hub when confirmation is accepted', () => {
    const sync = makeSyncMock({ authStatus: { authenticated: true } })
    const onHubEnabledChange = vi.fn()
    renderAndSwitchToData({ sync, hubEnabled: true, onHubEnabledChange })

    fireEvent.click(screen.getByTestId('sync-sign-out'))
    fireEvent.click(screen.getByTestId('sync-sign-out-confirm'))
    expect(sync.signOut).toHaveBeenCalledOnce()
    expect(onHubEnabledChange).toHaveBeenCalledWith(false)
  })

  it('shows hub warning when hub is enabled and confirming disconnect', () => {
    const sync = makeSyncMock({ authStatus: { authenticated: true } })
    renderAndSwitchToData({ sync, hubEnabled: true })

    fireEvent.click(screen.getByTestId('sync-sign-out'))
    expect(screen.getByTestId('sync-disconnect-hub-warning')).toBeInTheDocument()
  })

  it('does not show hub warning when hub is disabled', () => {
    const sync = makeSyncMock({ authStatus: { authenticated: true } })
    renderAndSwitchToData({ sync, hubEnabled: false })

    fireEvent.click(screen.getByTestId('sync-sign-out'))
    expect(screen.queryByTestId('sync-disconnect-hub-warning')).not.toBeInTheDocument()
  })

  it('cancels sign-out when cancel is clicked', () => {
    const sync = makeSyncMock({ authStatus: { authenticated: true } })
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-sign-out'))
    fireEvent.click(screen.getByTestId('sync-sign-out-cancel'))
    expect(screen.getByTestId('sync-sign-out')).toBeInTheDocument()
    expect(sync.signOut).not.toHaveBeenCalled()
  })

  it('shows password set indicator when hasPassword is true', () => {
    renderAndSwitchToData({ sync: makeSyncMock({ hasPassword: true }) })

    expect(screen.getByTestId('sync-password-set')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-password-input')).not.toBeInTheDocument()
  })

  it('shows password input when hasPassword is false', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('sync-password-input')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-password-set')).not.toBeInTheDocument()
  })

  it('disables sync buttons when not fully configured', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('sync-now')).toBeDisabled()
    expect(screen.getByTestId('sync-reset-data')).toBeDisabled()
  })

  it('enables sync-now when fully configured (reset requires checkbox selection)', () => {
    renderAndSwitchToData({ sync: makeSyncMock(FULLY_CONFIGURED) })

    expect(screen.getByTestId('sync-now')).not.toBeDisabled()
    // Delete button disabled until a checkbox is selected
    expect(screen.getByTestId('sync-reset-data')).toBeDisabled()
  })

  it('calls syncNow with download then upload when sync button clicked', async () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-now'))
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('download')
    })
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('upload')
    })
  })

  it('shows confirmation before resetting sync targets', async () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync })

    // Select keyboards checkbox
    fireEvent.click(screen.getByTestId('sync-target-keyboards').querySelector('input')!)
    expect(screen.getByTestId('sync-reset-data')).not.toBeDisabled()

    fireEvent.click(screen.getByTestId('sync-reset-data'))

    expect(screen.getByTestId('sync-reset-data-warning')).toBeInTheDocument()
    expect(screen.getByTestId('sync-reset-data-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('sync-reset-data-cancel')).toBeInTheDocument()
    expect(sync.resetSyncTargets).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('sync-reset-data-confirm'))
    await waitFor(() => {
      expect(sync.resetSyncTargets).toHaveBeenCalledWith({ keyboards: true, favorites: false })
    })
  })

  it('cancels reset data confirmation', () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync })

    // Select a target first
    fireEvent.click(screen.getByTestId('sync-target-keyboards').querySelector('input')!)
    fireEvent.click(screen.getByTestId('sync-reset-data'))
    expect(screen.getByTestId('sync-reset-data-warning')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-reset-data-cancel'))
    expect(screen.queryByTestId('sync-reset-data-warning')).not.toBeInTheDocument()
    expect(screen.getByTestId('sync-reset-data')).toBeInTheDocument()
    expect(sync.resetSyncTargets).not.toHaveBeenCalled()
  })

  it('calls onClose when backdrop is clicked', () => {
    render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('settings-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call onClose when modal content is clicked', () => {
    render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('settings-modal'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', () => {
    render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('settings-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('enables auto-sync and triggers download when start button is clicked', async () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-auto-on'))

    await waitFor(() => {
      expect(sync.setConfig).toHaveBeenCalledWith({ autoSync: true })
    })
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('download')
    })
  })

  it('shows disable button when auto-sync is on', () => {
    renderAndSwitchToData({ sync: makeSyncMock(SYNC_ENABLED) })

    expect(screen.getByTestId('sync-auto-off')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-auto-on')).not.toBeInTheDocument()
  })

  it('disables auto-sync when stop button is clicked', async () => {
    const sync = makeSyncMock(SYNC_ENABLED)
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-auto-off'))

    await waitFor(() => {
      expect(sync.setConfig).toHaveBeenCalledWith({ autoSync: false })
    })
    expect(sync.syncNow).not.toHaveBeenCalled()
  })

  it('allows disabling auto-sync even when not authenticated', async () => {
    const sync = makeSyncMock({ config: { autoSync: true } })
    renderAndSwitchToData({ sync })

    const stopBtn = screen.getByTestId('sync-auto-off')
    expect(stopBtn).not.toBeDisabled()
    fireEvent.click(stopBtn)

    await waitFor(() => {
      expect(sync.setConfig).toHaveBeenCalledWith({ autoSync: false })
    })
  })

  it('shows authenticating state while sign-in is in progress', async () => {
    let resolveAuth: () => void
    const authPromise = new Promise<void>((resolve) => { resolveAuth = resolve })
    renderAndSwitchToData({
      sync: makeSyncMock({ startAuth: vi.fn().mockReturnValue(authPromise) }),
    })

    fireEvent.click(screen.getByTestId('sync-sign-in'))

    await waitFor(() => {
      expect(screen.getByTestId('sync-sign-in')).toBeDisabled()
      expect(screen.getByTestId('sync-sign-in')).toHaveTextContent('sync.authenticating')
    })

    resolveAuth!()
    await waitFor(() => {
      expect(screen.getByTestId('sync-sign-in')).not.toBeDisabled()
      expect(screen.getByTestId('sync-sign-in')).toHaveTextContent('sync.signIn')
    })
  })

  it('shows auth error when sign-in fails', async () => {
    renderAndSwitchToData({
      sync: makeSyncMock({ startAuth: vi.fn().mockRejectedValue(new Error('OAuth error')) }),
    })

    fireEvent.click(screen.getByTestId('sync-sign-in'))

    await waitFor(() => {
      expect(screen.getByTestId('sync-auth-error')).toHaveTextContent('OAuth error')
    })
    expect(screen.getByTestId('sync-sign-in')).not.toBeDisabled()
  })

  it('shows reset password button when password is set and authenticated', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({ hasPassword: true, authStatus: { authenticated: true } }),
    })

    expect(screen.getByTestId('sync-password-reset-btn')).not.toBeDisabled()
  })

  it('disables reset password button when not authenticated', () => {
    renderAndSwitchToData({ sync: makeSyncMock({ hasPassword: true }) })

    expect(screen.getByTestId('sync-password-reset-btn')).toBeDisabled()
  })

  it('shows warning and input when reset password is clicked', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({ hasPassword: true, authStatus: { authenticated: true } }),
    })

    fireEvent.click(screen.getByTestId('sync-password-reset-btn'))

    expect(screen.getByTestId('sync-reset-warning')).toBeInTheDocument()
    expect(screen.getByTestId('sync-password-input')).toBeInTheDocument()
    expect(screen.getByTestId('sync-password-reset-cancel')).toBeInTheDocument()
  })

  it('calls resetPassword on submit during reset mode', async () => {
    const sync = makeSyncMock({
      hasPassword: true,
      authStatus: { authenticated: true },
      validatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
    })
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-password-reset-btn'))
    fireEvent.change(screen.getByTestId('sync-password-input'), { target: { value: 'NewStr0ng!Pass' } })

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-save')).not.toBeDisabled()
    })

    fireEvent.click(screen.getByTestId('sync-password-save'))

    await waitFor(() => {
      expect(sync.resetPassword).toHaveBeenCalledWith('NewStr0ng!Pass')
    })
    expect(sync.setPassword).not.toHaveBeenCalled()
  })

  it('cancels reset and returns to password-set view', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({ hasPassword: true, authStatus: { authenticated: true } }),
    })

    fireEvent.click(screen.getByTestId('sync-password-reset-btn'))
    expect(screen.getByTestId('sync-reset-warning')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-password-reset-cancel'))
    expect(screen.queryByTestId('sync-reset-warning')).not.toBeInTheDocument()
    expect(screen.getByTestId('sync-password-set')).toBeInTheDocument()
  })

  it('shows syncing status in sync status section', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...SYNC_ENABLED,
        syncStatus: 'syncing',
        progress: {
          direction: 'download',
          status: 'syncing',
          syncUnit: 'favorites/tapDance',
          current: 2,
          total: 5,
        },
      }),
    })

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('statusBar.sync.syncing')
    expect(screen.getByTestId('sync-status-progress')).toHaveTextContent('2 / 5')
    expect(screen.getByTestId('sync-status-unit')).toHaveTextContent('favorites/tapDance')
  })

  it('shows "not synced yet" when sync is not enabled', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('sync.noSyncYet')
  })

  it('shows success status with timestamp', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...SYNC_ENABLED,
        syncStatus: 'synced',
        lastSyncResult: { status: 'success', timestamp: Date.now() },
      }),
    })

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('statusBar.sync.synced')
    expect(screen.getByTestId('sync-status-time')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-status-error-message')).not.toBeInTheDocument()
  })

  it('shows error status with message', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...SYNC_ENABLED,
        syncStatus: 'error',
        lastSyncResult: { status: 'error', message: 'Drive API 403', timestamp: Date.now() },
      }),
    })

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('statusBar.sync.error')
    expect(screen.getByTestId('sync-status-error-message')).toHaveTextContent('Drive API 403')
  })

  it('shows partial status with failed units list', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...SYNC_ENABLED,
        syncStatus: 'partial',
        lastSyncResult: {
          status: 'partial',
          message: '2 sync unit(s) failed',
          failedUnits: ['favorites/tapDance', 'favorites/macro'],
          timestamp: Date.now(),
        },
      }),
    })

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('statusBar.sync.partial')
    expect(screen.getByTestId('sync-status-partial-details')).toBeInTheDocument()
    expect(screen.getByTestId('sync-status-partial-details')).toHaveTextContent('favorites/tapDance')
    expect(screen.getByTestId('sync-status-partial-details')).toHaveTextContent('favorites/macro')
  })

  it('shows pending status when hasPendingChanges is true', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...SYNC_ENABLED,
        syncStatus: 'pending',
        hasPendingChanges: true,
        lastSyncResult: { status: 'success', timestamp: Date.now() },
      }),
    })

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('statusBar.sync.pending')
    expect(screen.getByTestId('sync-status-time')).toBeInTheDocument()
  })

  it('shows synced from terminal progress before lastSyncResult lands', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...SYNC_ENABLED,
        syncStatus: 'synced',
        progress: { direction: 'upload', status: 'success' },
        lastSyncResult: null,
      }),
    })

    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('statusBar.sync.synced')
  })

  it('validates password and shows strength meter', async () => {
    const sync = makeSyncMock({
      validatePassword: vi.fn().mockResolvedValue({ score: 2, feedback: ['Add a number'] }),
    })
    renderAndSwitchToData({ sync })

    fireEvent.change(screen.getByTestId('sync-password-input'), { target: { value: 'weak' } })

    await waitFor(() => {
      expect(sync.validatePassword).toHaveBeenCalledWith('weak')
    })

    await waitFor(() => {
      expect(screen.getByText('Add a number')).toBeInTheDocument()
    })
  })

  it('shows confirmation before resetting local data', () => {
    renderAndSwitchToData()

    // Select a local target
    fireEvent.click(screen.getByTestId('local-target-keyboards').querySelector('input')!)
    fireEvent.click(screen.getByTestId('reset-local-data'))

    expect(screen.getByTestId('reset-local-data-warning')).toBeInTheDocument()
    expect(screen.getByTestId('reset-local-data-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('reset-local-data-cancel')).toBeInTheDocument()
    expect(mockResetLocalTargets).not.toHaveBeenCalled()
  })

  it('cancels reset local data confirmation', () => {
    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-target-keyboards').querySelector('input')!)
    fireEvent.click(screen.getByTestId('reset-local-data'))
    expect(screen.getByTestId('reset-local-data-warning')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('reset-local-data-cancel'))
    expect(screen.queryByTestId('reset-local-data-warning')).not.toBeInTheDocument()
    expect(screen.getByTestId('reset-local-data')).toBeInTheDocument()
    expect(mockResetLocalTargets).not.toHaveBeenCalled()
  })

  it('calls resetLocalTargets with selected targets when confirm is clicked', async () => {
    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-target-keyboards').querySelector('input')!)
    fireEvent.click(screen.getByTestId('local-target-appSettings').querySelector('input')!)
    fireEvent.click(screen.getByTestId('reset-local-data'))
    fireEvent.click(screen.getByTestId('reset-local-data-confirm'))

    await waitFor(() => {
      expect(mockResetLocalTargets).toHaveBeenCalledWith({ keyboards: true, favorites: false, appSettings: true })
    })
  })

  it('disables delete button when no local targets are selected', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('reset-local-data')).toBeDisabled()
  })

  it('renders sync reset checkboxes', () => {
    renderAndSwitchToData({ sync: makeSyncMock(FULLY_CONFIGURED) })

    expect(screen.getByTestId('sync-target-keyboards')).toBeInTheDocument()
    expect(screen.getByTestId('sync-target-favorites')).toBeInTheDocument()
  })

  it('renders local reset checkboxes', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('local-target-keyboards')).toBeInTheDocument()
    expect(screen.getByTestId('local-target-favorites')).toBeInTheDocument()
    expect(screen.getByTestId('local-target-appSettings')).toBeInTheDocument()
  })

  it('renders import and export buttons', () => {
    renderAndSwitchToData()

    expect(screen.getByTestId('local-data-import')).toBeInTheDocument()
    expect(screen.getByTestId('local-data-export')).toBeInTheDocument()
  })

  it('calls exportLocalData when export button is clicked', async () => {
    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-data-export'))

    await waitFor(() => {
      expect(mockExportLocalData).toHaveBeenCalledOnce()
    })
  })

  it('calls importLocalData when import button is clicked', async () => {
    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-data-import'))

    await waitFor(() => {
      expect(mockImportLocalData).toHaveBeenCalledOnce()
    })
  })

  it('shows success message after import completes', async () => {
    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-data-import'))

    await waitFor(() => {
      expect(screen.getByTestId('local-data-import-result')).toHaveTextContent('sync.importComplete')
    })
  })

  it('shows error message when import fails', async () => {
    mockImportLocalData.mockResolvedValueOnce({ success: false, error: 'bad file' })
    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-data-import'))

    await waitFor(() => {
      expect(screen.getByTestId('local-data-import-result')).toHaveTextContent('sync.importFailed')
    })
  })

  it('disables sync and reset buttons when syncing', () => {
    renderAndSwitchToData({
      sync: makeSyncMock({
        ...FULLY_CONFIGURED,
        syncStatus: 'syncing',
        progress: { direction: 'download', status: 'syncing' },
      }),
    })

    expect(screen.getByTestId('sync-now')).toBeDisabled()

    // Checkboxes disabled during sync
    expect(screen.getByTestId('sync-target-keyboards').querySelector('input')).toBeDisabled()
    expect(screen.getByTestId('sync-reset-data')).toBeDisabled()
    expect(screen.getByTestId('reset-local-data')).toBeDisabled()
  })

  it('disables import, export, and checkboxes when busy', async () => {
    let resolveImport: (value: { success: boolean }) => void
    const importPromise = new Promise<{ success: boolean }>((resolve) => { resolveImport = resolve })
    mockImportLocalData.mockReturnValueOnce(importPromise)

    renderAndSwitchToData()

    fireEvent.click(screen.getByTestId('local-data-import'))

    await waitFor(() => {
      expect(screen.getByTestId('local-data-import')).toBeDisabled()
      expect(screen.getByTestId('local-data-export')).toBeDisabled()
      expect(screen.getByTestId('local-target-keyboards').querySelector('input')).toBeDisabled()
    })

    resolveImport!({ success: true })

    await waitFor(() => {
      expect(screen.getByTestId('local-data-import')).not.toBeDisabled()
      expect(screen.getByTestId('local-data-export')).not.toBeDisabled()
      expect(screen.getByTestId('local-target-keyboards').querySelector('input')).not.toBeDisabled()
    })
  })

  function renderAndSwitchToHub(props?: Partial<Parameters<typeof SettingsModal>[0]>) {
    const result = render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} {...props} />)
    fireEvent.click(screen.getByTestId('settings-tab-hub'))
    return result
  }

  describe('tabs', () => {
    it('renders Tools, Data, Hub, and About tabs', () => {
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

      expect(screen.getByTestId('settings-tab-tools')).toBeInTheDocument()
      expect(screen.getByTestId('settings-tab-data')).toBeInTheDocument()
      expect(screen.getByTestId('settings-tab-hub')).toBeInTheDocument()
      expect(screen.getByTestId('settings-tab-about')).toBeInTheDocument()
    })

    it('shows Tools tab content by default', () => {
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

      expect(screen.getByTestId('theme-option-system')).toBeInTheDocument()
      expect(screen.queryByTestId('sync-sign-in')).not.toBeInTheDocument()
    })

    it('switches to Data tab showing sync and data content', () => {
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

      fireEvent.click(screen.getByTestId('settings-tab-data'))

      expect(screen.getByTestId('sync-sign-in')).toBeInTheDocument()
      expect(screen.getByTestId('local-data-import')).toBeInTheDocument()
      expect(screen.queryByTestId('theme-option-system')).not.toBeInTheDocument()
    })
  })

  describe('Defaults section (Tools tab)', () => {
    it('renders default layout selector', () => {
      renderAndSwitchToTools()
      expect(screen.getByTestId('settings-default-layout-selector')).toBeInTheDocument()
    })

    it('renders default auto advance toggle', () => {
      renderAndSwitchToTools()
      expect(screen.getByTestId('settings-default-auto-advance-toggle')).toBeInTheDocument()
    })

    it('calls onDefaultLayoutChange when layout selector changes', () => {
      const onDefaultLayoutChange = vi.fn()
      renderAndSwitchToTools({ onDefaultLayoutChange })

      fireEvent.change(screen.getByTestId('settings-default-layout-selector'), { target: { value: 'dvorak' } })
      expect(onDefaultLayoutChange).toHaveBeenCalledWith('dvorak')
    })

    it('calls onDefaultAutoAdvanceChange when toggle is clicked', () => {
      const onDefaultAutoAdvanceChange = vi.fn()
      renderAndSwitchToTools({ defaultAutoAdvance: true, onDefaultAutoAdvanceChange })

      fireEvent.click(screen.getByTestId('settings-default-auto-advance-toggle'))
      expect(onDefaultAutoAdvanceChange).toHaveBeenCalledWith(false)
    })

    it('reflects defaultAutoAdvance off state', () => {
      renderAndSwitchToTools({ defaultAutoAdvance: false })
      const toggle = screen.getByTestId('settings-default-auto-advance-toggle')
      expect(toggle.getAttribute('aria-checked')).toBe('false')
    })
  })

  describe('Appearance section (Tools tab)', () => {
    it('renders theme option buttons', () => {
      renderAndSwitchToTools()

      expect(screen.getByTestId('theme-option-system')).toBeInTheDocument()
      expect(screen.getByTestId('theme-option-light')).toBeInTheDocument()
      expect(screen.getByTestId('theme-option-dark')).toBeInTheDocument()
    })

    it('highlights the active theme', () => {
      renderAndSwitchToTools({ theme: 'dark' })

      expect(screen.getByTestId('theme-option-dark').className).toContain('bg-accent/15')
      expect(screen.getByTestId('theme-option-light').className).not.toContain('bg-accent/15')
      expect(screen.getByTestId('theme-option-system').className).not.toContain('bg-accent/15')
    })

    it('calls onThemeChange when a theme option is clicked', () => {
      const onThemeChange = vi.fn()
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onThemeChange={onThemeChange} onClose={onClose} />)
      fireEvent.click(screen.getByTestId('settings-tab-tools'))

      fireEvent.click(screen.getByTestId('theme-option-dark'))
      expect(onThemeChange).toHaveBeenCalledWith('dark')

      fireEvent.click(screen.getByTestId('theme-option-light'))
      expect(onThemeChange).toHaveBeenCalledWith('light')
    })
  })

  describe('Security section (Tools tab)', () => {
    it('renders auto lock time selector with default value', () => {
      renderAndSwitchToTools()
      const selector = screen.getByTestId('settings-auto-lock-time-selector')
      expect(selector).toBeInTheDocument()
      expect(selector).toHaveValue('10')
    })

    it('auto lock time selector has 6 options (10-60 in 10-min steps)', () => {
      renderAndSwitchToTools()
      const selector = screen.getByTestId('settings-auto-lock-time-selector')
      const options = selector.querySelectorAll('option')
      expect(options).toHaveLength(6)
    })

    it('calls onAutoLockTimeChange when selector changes', () => {
      const onAutoLockTimeChange = vi.fn()
      renderAndSwitchToTools({ onAutoLockTimeChange })

      fireEvent.change(screen.getByTestId('settings-auto-lock-time-selector'), { target: { value: '30' } })
      expect(onAutoLockTimeChange).toHaveBeenCalledWith(30)
    })

    it('reflects current autoLockTime value', () => {
      renderAndSwitchToTools({ autoLockTime: 50 as const })
      expect(screen.getByTestId('settings-auto-lock-time-selector')).toHaveValue('50')
    })

  })

  describe('Panel Side section (Tools tab)', () => {
    it('renders panel side Left and Right options', () => {
      renderAndSwitchToTools()
      expect(screen.getByTestId('panel-side-option-left')).toBeInTheDocument()
      expect(screen.getByTestId('panel-side-option-right')).toBeInTheDocument()
    })

    it('highlights the active panel side', () => {
      renderAndSwitchToTools({ panelSide: 'right' as const })
      expect(screen.getByTestId('panel-side-option-right').className).toContain('bg-accent/15')
      expect(screen.getByTestId('panel-side-option-left').className).not.toContain('bg-accent/15')
    })

    it('calls onPanelSideChange when a side option is clicked', () => {
      const onPanelSideChange = vi.fn()
      renderAndSwitchToTools({ panelSide: 'left' as const, onPanelSideChange })

      fireEvent.click(screen.getByTestId('panel-side-option-right'))
      expect(onPanelSideChange).toHaveBeenCalledWith('right')
    })
  })

  describe('Hub tab', () => {
    it('switches to Hub tab and shows hub toggle', () => {
      renderAndSwitchToHub()

      expect(screen.getByTestId('hub-enable-toggle')).toBeInTheDocument()
      expect(screen.queryByTestId('theme-option-system')).not.toBeInTheDocument()
    })

    it('shows enabled status when hub is enabled', () => {
      renderAndSwitchToHub({ hubEnabled: true })
      expect(screen.getByTestId('hub-enabled-status')).toBeInTheDocument()
    })

    it('shows confirmation when disconnect button is clicked', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToHub({ hubEnabled: true, onHubEnabledChange })

      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      expect(screen.getByTestId('hub-disconnect-confirm')).toBeInTheDocument()
      expect(screen.getByTestId('hub-disconnect-cancel')).toBeInTheDocument()
      expect(onHubEnabledChange).not.toHaveBeenCalled()
    })

    it('calls onHubEnabledChange with false when confirmation is accepted', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToHub({ hubEnabled: true, onHubEnabledChange })

      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      fireEvent.click(screen.getByTestId('hub-disconnect-confirm'))
      expect(onHubEnabledChange).toHaveBeenCalledWith(false)
    })

    it('cancels hub disconnect when cancel is clicked', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToHub({ hubEnabled: true, onHubEnabledChange })

      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      fireEvent.click(screen.getByTestId('hub-disconnect-cancel'))
      expect(screen.getByTestId('hub-enable-toggle')).toBeInTheDocument()
      expect(onHubEnabledChange).not.toHaveBeenCalled()
    })

    it('calls onHubEnabledChange with true when enable button is clicked while authenticated', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToHub({ hubEnabled: false, hubAuthenticated: true, onHubEnabledChange })
      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      expect(onHubEnabledChange).toHaveBeenCalledWith(true)
    })

    it('disables hub enable button when not authenticated', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToHub({ hubEnabled: false, hubAuthenticated: false, onHubEnabledChange })
      const button = screen.getByTestId('hub-enable-toggle')
      expect(button).toBeDisabled()
      fireEvent.click(button)
      expect(onHubEnabledChange).not.toHaveBeenCalled()
    })

    it('hides my posts when hub is disabled', () => {
      renderAndSwitchToHub({ hubEnabled: false })
      expect(screen.queryByTestId('hub-post-list')).not.toBeInTheDocument()
      expect(screen.queryByTestId('hub-no-posts')).not.toBeInTheDocument()
    })

    it('shows auth required message below connect button when not authenticated and disabled', () => {
      renderAndSwitchToHub({ hubEnabled: false, hubAuthenticated: false })

      expect(screen.getByTestId('hub-requires-auth')).toBeInTheDocument()
      expect(screen.queryByTestId('hub-post-list')).not.toBeInTheDocument()
    })

    it('hides my posts when hub is enabled but not authenticated', () => {
      renderAndSwitchToHub({ hubEnabled: true, hubAuthenticated: false })

      expect(screen.queryByTestId('hub-post-list')).not.toBeInTheDocument()
      expect(screen.queryByTestId('hub-no-posts')).not.toBeInTheDocument()
    })

    it('shows empty post list when authenticated with no posts', () => {
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: [] })

      expect(screen.queryByTestId('hub-requires-auth')).not.toBeInTheDocument()
      expect(screen.getByTestId('hub-no-posts')).toBeInTheDocument()
    })

    it('renders post list when authenticated with posts', () => {
      const posts = [
        { id: 'p1', title: 'My Layout 1', keyboard_name: 'BoardA', created_at: '2025-01-15T10:30:00Z' },
        { id: 'p2', title: 'My Layout 2', keyboard_name: 'BoardB', created_at: '2025-02-20T14:00:00Z' },
      ]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts })

      expect(screen.getByTestId('hub-post-p1')).toBeInTheDocument()
      expect(screen.getByTestId('hub-post-p2')).toBeInTheDocument()
      expect(screen.getByTestId('hub-post-p1')).toHaveTextContent('My Layout 1')
      expect(screen.getByTestId('hub-post-p1')).toHaveTextContent('BoardA')
      expect(screen.getByTestId('hub-post-p2')).toHaveTextContent('My Layout 2')
      expect(screen.getByTestId('hub-post-p2')).toHaveTextContent('BoardB')
    })

    it('enters rename mode when rename button is clicked', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts })

      fireEvent.click(screen.getByTestId('hub-rename-p1'))

      expect(screen.getByTestId('hub-rename-input-p1')).toBeInTheDocument()
      expect(screen.getByTestId('hub-rename-input-p1')).toHaveValue('My Layout')
    })

    it('submits rename on Enter key', async () => {
      const onHubRename = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, onHubRename })

      fireEvent.click(screen.getByTestId('hub-rename-p1'))
      const input = screen.getByTestId('hub-rename-input-p1')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(onHubRename).toHaveBeenCalledWith('p1', 'New Name')
      })
    })

    it('refreshes current page after rename completes', async () => {
      const onHubRename = vi.fn().mockResolvedValue(undefined)
      const onHubRefresh = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({
        hubAuthenticated: true,
        hubPosts: posts,
        hubPostsPagination: { total: 25, page: 2, per_page: 10, total_pages: 3 },
        onHubRename,
        onHubRefresh,
      })

      fireEvent.click(screen.getByTestId('hub-rename-p1'))
      const input = screen.getByTestId('hub-rename-input-p1')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(onHubRefresh).toHaveBeenCalledWith({ page: 2, per_page: 10 })
      })
    })

    it('cancels rename on Escape key', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts })

      fireEvent.click(screen.getByTestId('hub-rename-p1'))
      expect(screen.getByTestId('hub-rename-input-p1')).toBeInTheDocument()

      fireEvent.keyDown(screen.getByTestId('hub-rename-input-p1'), { key: 'Escape' })
      expect(screen.queryByTestId('hub-rename-input-p1')).not.toBeInTheDocument()
      expect(screen.getByTestId('hub-post-p1')).toHaveTextContent('My Layout')
    })

    it('shows delete confirmation when delete button is clicked', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts })

      fireEvent.click(screen.getByTestId('hub-delete-p1'))

      expect(screen.getByTestId('hub-confirm-delete-p1')).toBeInTheDocument()
      expect(screen.getByTestId('hub-cancel-delete-p1')).toBeInTheDocument()
    })

    it('calls onHubDelete when delete is confirmed', async () => {
      const onHubDelete = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, onHubDelete })

      fireEvent.click(screen.getByTestId('hub-delete-p1'))
      fireEvent.click(screen.getByTestId('hub-confirm-delete-p1'))

      await waitFor(() => {
        expect(onHubDelete).toHaveBeenCalledWith('p1')
      })
    })

    it('cancels delete confirmation', () => {
      const onHubDelete = vi.fn()
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, onHubDelete })

      fireEvent.click(screen.getByTestId('hub-delete-p1'))
      expect(screen.getByTestId('hub-confirm-delete-p1')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('hub-cancel-delete-p1'))
      expect(screen.queryByTestId('hub-confirm-delete-p1')).not.toBeInTheDocument()
      expect(onHubDelete).not.toHaveBeenCalled()
    })

    it('shows error and stays in edit mode when rename fails', async () => {
      const onHubRename = vi.fn().mockRejectedValue(new Error('Rename failed'))
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, onHubRename })

      fireEvent.click(screen.getByTestId('hub-rename-p1'))
      const input = screen.getByTestId('hub-rename-input-p1')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByTestId('hub-error-p1')).toHaveTextContent('hub.renameFailed')
      })
      expect(screen.getByTestId('hub-rename-input-p1')).toBeInTheDocument()
    })

    it('shows error when delete fails', async () => {
      const onHubDelete = vi.fn().mockRejectedValue(new Error('Delete failed'))
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, onHubDelete })

      fireEvent.click(screen.getByTestId('hub-delete-p1'))
      fireEvent.click(screen.getByTestId('hub-confirm-delete-p1'))

      await waitFor(() => {
        expect(screen.getByTestId('hub-error-p1')).toHaveTextContent('hub.deleteFailed')
      })
    })

    describe('pagination', () => {
      it('does not show pagination controls when total_pages is 1', () => {
        const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({
          hubAuthenticated: true,
          hubPosts: posts,
          hubPostsPagination: { total: 1, page: 1, per_page: 10, total_pages: 1 },
        })

        expect(screen.getByTestId('hub-post-list')).toBeInTheDocument()
        expect(screen.queryByTestId('hub-pagination')).not.toBeInTheDocument()
      })

      it('shows pagination controls when total_pages > 1', () => {
        const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({
          hubAuthenticated: true,
          hubPosts: posts,
          hubPostsPagination: { total: 25, page: 1, per_page: 10, total_pages: 3 },
        })

        expect(screen.getByTestId('hub-pagination')).toBeInTheDocument()
        expect(screen.getByTestId('hub-page-prev')).toBeDisabled()
        expect(screen.getByTestId('hub-page-next')).not.toBeDisabled()
        expect(screen.getByTestId('hub-page-info')).toHaveTextContent('hub.pageInfo')
      })

      it('calls onHubRefresh with next page when Next is clicked', () => {
        const onHubRefresh = vi.fn().mockResolvedValue(undefined)
        const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({
          hubAuthenticated: true,
          hubPosts: posts,
          hubPostsPagination: { total: 25, page: 1, per_page: 10, total_pages: 3 },
          onHubRefresh,
        })

        fireEvent.click(screen.getByTestId('hub-page-next'))

        expect(onHubRefresh).toHaveBeenCalledWith({ page: 2, per_page: 10 })
      })

      it('syncs hubPage from pagination props and disables Next on last page', () => {
        const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({
          hubAuthenticated: true,
          hubPosts: posts,
          hubPostsPagination: { total: 25, page: 3, per_page: 10, total_pages: 3 },
        })

        // hubPage syncs from hubPostsPagination.page=3, so Next is disabled on last page
        expect(screen.getByTestId('hub-page-next')).toBeDisabled()
        expect(screen.getByTestId('hub-page-prev')).not.toBeDisabled()
      })

      it('shows pagination controls on empty page when total_pages > 1', () => {
        renderAndSwitchToHub({
          hubAuthenticated: true,
          hubPosts: [],
          hubPostsPagination: { total: 15, page: 2, per_page: 10, total_pages: 2 },
        })

        expect(screen.getByTestId('hub-no-posts')).toBeInTheDocument()
        expect(screen.getByTestId('hub-pagination')).toBeInTheDocument()
        expect(screen.getByTestId('hub-page-prev')).not.toBeDisabled()
      })
    })

    describe('open in browser', () => {
      it('shows open in browser button when hubOrigin is provided', () => {
        const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, hubOrigin: 'https://hub.example.com' })

        expect(screen.getByTestId('hub-open-p1')).toBeInTheDocument()
      })

      it('does not show open in browser button when hubOrigin is undefined', () => {
        const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts })

        expect(screen.queryByTestId('hub-open-p1')).not.toBeInTheDocument()
      })

      it('calls openExternal with correct URL when clicked', () => {
        const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
        renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts, hubOrigin: 'https://hub.example.com' })

        fireEvent.click(screen.getByTestId('hub-open-p1'))

        expect(mockOpenExternal).toHaveBeenCalledWith('https://hub.example.com/post/p1')
      })
    })

    it('clears saved indicator timeout on unmount', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
      const onHubDisplayNameChange = vi.fn().mockResolvedValue({ success: true })
      const { unmount } = renderAndSwitchToHub({
        hubEnabled: true,
        hubAuthenticated: true,
        hubDisplayName: 'Alice',
        onHubDisplayNameChange,
      })

      const input = screen.getByTestId('hub-display-name-input')
      fireEvent.change(input, { target: { value: 'Bob' } })
      fireEvent.click(screen.getByTestId('hub-display-name-save'))

      await waitFor(() => {
        expect(onHubDisplayNameChange).toHaveBeenCalledWith('Bob')
      })

      clearTimeoutSpy.mockClear()
      unmount()

      expect(clearTimeoutSpy).toHaveBeenCalled()
      clearTimeoutSpy.mockRestore()
    })

    describe('display name empty save prevention', () => {
      it('disables save button when input is cleared to empty', () => {
        const onHubDisplayNameChange = vi.fn().mockResolvedValue({ success: true })
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
          onHubDisplayNameChange,
        })

        const input = screen.getByTestId('hub-display-name-input')
        fireEvent.change(input, { target: { value: '' } })

        const saveBtn = screen.getByTestId('hub-display-name-save')
        expect(saveBtn).toBeDisabled()
      })

      it('disables save button when input is whitespace only', () => {
        const onHubDisplayNameChange = vi.fn().mockResolvedValue({ success: true })
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
          onHubDisplayNameChange,
        })

        const input = screen.getByTestId('hub-display-name-input')
        fireEvent.change(input, { target: { value: '   ' } })

        const saveBtn = screen.getByTestId('hub-display-name-save')
        expect(saveBtn).toBeDisabled()
      })

      it('does not call onSave on Enter when input is empty', () => {
        const onHubDisplayNameChange = vi.fn().mockResolvedValue({ success: true })
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
          onHubDisplayNameChange,
        })

        const input = screen.getByTestId('hub-display-name-input')
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(onHubDisplayNameChange).not.toHaveBeenCalled()
      })

      it('does not call onSave on Enter when input is whitespace only', () => {
        const onHubDisplayNameChange = vi.fn().mockResolvedValue({ success: true })
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
          onHubDisplayNameChange,
        })

        const input = screen.getByTestId('hub-display-name-input')
        fireEvent.change(input, { target: { value: '   ' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(onHubDisplayNameChange).not.toHaveBeenCalled()
      })

      it('shows required hint when display name is empty', () => {
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: null,
        })

        expect(screen.getByTestId('hub-display-name-required')).toHaveTextContent('hub.displayNameRequired')
      })

      it('does not show required hint when display name is set', () => {
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
        })

        expect(screen.queryByTestId('hub-display-name-required')).not.toBeInTheDocument()
      })

      it('shows duplicate error when save returns DISPLAY_NAME_CONFLICT', async () => {
        const onHubDisplayNameChange = vi.fn().mockResolvedValue({
          success: false,
          error: HUB_ERROR_DISPLAY_NAME_CONFLICT,
        })
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
          onHubDisplayNameChange,
        })

        const input = screen.getByTestId('hub-display-name-input')
        fireEvent.change(input, { target: { value: 'Bob' } })
        fireEvent.click(screen.getByTestId('hub-display-name-save'))

        await waitFor(() => {
          expect(screen.getByTestId('hub-display-name-error')).toHaveTextContent('hub.displayNameTaken')
        })
      })

      it('shows generic error when save fails without 409', async () => {
        const onHubDisplayNameChange = vi.fn().mockResolvedValue({
          success: false,
          error: 'Hub patch auth me failed: 500',
        })
        renderAndSwitchToHub({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: 'Alice',
          onHubDisplayNameChange,
        })

        const input = screen.getByTestId('hub-display-name-input')
        fireEvent.change(input, { target: { value: 'Bob' } })
        fireEvent.click(screen.getByTestId('hub-display-name-save'))

        await waitFor(() => {
          expect(screen.getByTestId('hub-display-name-error')).toHaveTextContent('hub.displayNameSaveFailed')
        })
      })
    })
  })

  describe('input maxLength attributes', () => {
    it('display name input has maxLength=50', () => {
      renderAndSwitchToHub({ hubEnabled: true, hubAuthenticated: true })
      const input = screen.getByTestId('hub-display-name-input')
      expect(input).toHaveAttribute('maxLength', '50')
    })

    it('hub post rename input has maxLength=200', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      renderAndSwitchToHub({ hubAuthenticated: true, hubPosts: posts })
      fireEvent.click(screen.getByTestId('hub-rename-p1'))
      const input = screen.getByTestId('hub-rename-input-p1')
      expect(input).toHaveAttribute('maxLength', '200')
    })
  })

  describe('About tab', () => {
    function renderAndSwitchToAbout(props?: Partial<Parameters<typeof SettingsModal>[0]>) {
      const result = render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} {...props} />)
      fireEvent.click(screen.getByTestId('settings-tab-about'))
      return result
    }

    it('shows app icon, name, and version', () => {
      renderAndSwitchToAbout()

      expect(screen.getByTestId('about-app-icon')).toBeInTheDocument()
      expect(screen.getByTestId('about-app-name')).toHaveTextContent('Pipette')
      expect(screen.getByTestId('about-app-version')).toBeInTheDocument()
    })

    it('shows license info', () => {
      renderAndSwitchToAbout()

      expect(screen.getByTestId('about-license')).toBeInTheDocument()
    })

    it('shows terms of service content by default', () => {
      renderAndSwitchToAbout()

      expect(screen.getByTestId('about-terms-content')).toBeInTheDocument()
    })

    it('does not show other tab content when About is active', () => {
      renderAndSwitchToAbout()

      expect(screen.queryByTestId('theme-option-system')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sync-sign-in')).not.toBeInTheDocument()
      expect(screen.queryByTestId('hub-enable-toggle')).not.toBeInTheDocument()
    })
  })
})
