// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from '../SettingsModal'
import type { UseSyncReturn } from '../../hooks/useSync'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT } from '../../../shared/types/hub'
import type { NotificationFetchResult } from '../../../shared/types/notification'
import { DEFAULT_APP_CONFIG } from '../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../i18n', () => ({
  default: { changeLanguage: vi.fn() },
  SUPPORTED_LANGUAGES: [
    { id: 'en', name: 'English' },
    { id: 'ja', name: '日本語' },
  ],
}))

const mockAppConfigSet = vi.fn()
vi.mock('../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { language: 'en' },
    loading: false,
    set: mockAppConfigSet,
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
const mockNotificationFetch = vi.fn().mockResolvedValue({ success: true, notifications: [] })
Object.defineProperty(window, 'vialAPI', {
  value: {
    resetLocalTargets: mockResetLocalTargets,
    exportLocalData: mockExportLocalData,
    importLocalData: mockImportLocalData,
    openExternal: mockOpenExternal,
    notificationFetch: mockNotificationFetch,
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
    hasRemotePassword: null,
    checkingRemotePassword: false,
    syncUnavailable: false,
    retryRemoteCheck: vi.fn(),
    startAuth: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn().mockResolvedValue(undefined),
    setPassword: vi.fn().mockResolvedValue({ success: true }),
    changePassword: vi.fn().mockResolvedValue({ success: true }),
    resetSyncTargets: vi.fn().mockResolvedValue({ success: true }),
    validatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
    syncNow: vi.fn().mockResolvedValue(undefined),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
    listUndecryptable: vi.fn().mockResolvedValue([]),
    deleteFiles: vi.fn().mockResolvedValue({ success: true }),
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
  hubEnabled: true,
  onHubEnabledChange: vi.fn(),
  hubAuthenticated: false,
}

describe('SettingsModal', () => {
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    onClose = vi.fn()
    defaultProps.onThemeChange = vi.fn()
    defaultProps.onDefaultLayoutChange = vi.fn()
    defaultProps.onDefaultAutoAdvanceChange = vi.fn()
    defaultProps.onAutoLockTimeChange = vi.fn()
    defaultProps.onHubEnabledChange = vi.fn()
    defaultProps.hubAuthenticated = false
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

  it('calls syncNow with favorites scope when sync button clicked (no keyboard)', async () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-now'))
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('download', 'favorites')
    })
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('upload', 'favorites')
    })
  })

  it('calls syncNow with favorites and keyboard scope when connected', async () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync, connectedKeyboardUid: '0xABCD' })

    fireEvent.click(screen.getByTestId('sync-now'))
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('download', 'favorites')
      expect(sync.syncNow).toHaveBeenCalledWith('download', { keyboard: '0xABCD' })
      expect(sync.syncNow).toHaveBeenCalledWith('upload', 'favorites')
      expect(sync.syncNow).toHaveBeenCalledWith('upload', { keyboard: '0xABCD' })
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

  it('hides close button and prevents backdrop close while busy', async () => {
    let resolveSet: (value: { success: boolean }) => void
    const setPromise = new Promise<{ success: boolean }>((resolve) => { resolveSet = resolve })
    const sync = makeSyncMock({
      setPassword: vi.fn().mockReturnValue(setPromise),
      validatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
    })
    renderAndSwitchToData({ sync })

    fireEvent.change(screen.getByTestId('sync-password-input'), { target: { value: 'Str0ng!Pass99' } })
    await waitFor(() => {
      expect(screen.getByTestId('sync-password-save')).not.toBeDisabled()
    })

    fireEvent.click(screen.getByTestId('sync-password-save'))

    await waitFor(() => {
      expect(screen.queryByTestId('settings-close')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('settings-backdrop'))
    expect(onClose).not.toHaveBeenCalled()

    resolveSet!({ success: true })

    await waitFor(() => {
      expect(screen.getByTestId('settings-close')).toBeInTheDocument()
    })
  })

  it('enables auto-sync and triggers download when start button is clicked', async () => {
    const sync = makeSyncMock(FULLY_CONFIGURED)
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-auto-on'))

    await waitFor(() => {
      expect(sync.setConfig).toHaveBeenCalledWith({ autoSync: true })
    })
    await waitFor(() => {
      expect(sync.syncNow).toHaveBeenCalledWith('download', 'favorites')
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

  it('hides password controls and shows busy banner while setting password', async () => {
    let resolveSet: (value: { success: boolean }) => void
    const setPromise = new Promise<{ success: boolean }>((resolve) => { resolveSet = resolve })
    const sync = makeSyncMock({
      setPassword: vi.fn().mockReturnValue(setPromise),
      validatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
    })
    renderAndSwitchToData({ sync })

    fireEvent.change(screen.getByTestId('sync-password-input'), { target: { value: 'Str0ng!Pass99' } })

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-save')).not.toBeDisabled()
    })

    fireEvent.click(screen.getByTestId('sync-password-save'))

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-busy')).toBeInTheDocument()
      expect(screen.getByTestId('sync-password-busy')).toHaveTextContent('sync.settingPassword')
      expect(screen.queryByTestId('sync-password-save')).not.toBeInTheDocument()
      expect(screen.getByTestId('sync-password-input')).toBeDisabled()
    })

    resolveSet!({ success: true })

    await waitFor(() => {
      expect(screen.queryByTestId('sync-password-busy')).not.toBeInTheDocument()
    })
  })

  it('disables change password button while busy', async () => {
    let resolveImport: (value: { success: boolean }) => void
    const importPromise = new Promise<{ success: boolean }>((resolve) => { resolveImport = resolve })
    mockImportLocalData.mockReturnValueOnce(importPromise)

    renderAndSwitchToData({ sync: makeSyncMock(FULLY_CONFIGURED) })

    expect(screen.getByTestId('sync-password-change-btn')).not.toBeDisabled()

    fireEvent.click(screen.getByTestId('local-data-import'))

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-change-btn')).toBeDisabled()
    })

    resolveImport!({ success: true })

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-change-btn')).not.toBeDisabled()
    })
  })

  it('hides change password controls and shows busy banner while saving', async () => {
    let resolveChange: (value: { success: boolean }) => void
    const changePromise = new Promise<{ success: boolean }>((resolve) => { resolveChange = resolve })
    const sync = makeSyncMock({
      ...FULLY_CONFIGURED,
      changePassword: vi.fn().mockReturnValue(changePromise),
      validatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
    })
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-password-change-btn'))
    fireEvent.change(screen.getByTestId('sync-password-input'), { target: { value: 'NewStr0ng!Pass' } })

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-save')).not.toBeDisabled()
    })

    fireEvent.click(screen.getByTestId('sync-password-save'))

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-busy')).toBeInTheDocument()
      expect(screen.getByTestId('sync-password-busy')).toHaveTextContent('sync.changingPassword')
      expect(screen.queryByTestId('sync-password-save')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sync-password-reset-cancel')).not.toBeInTheDocument()
      expect(screen.getByTestId('sync-password-input')).toBeDisabled()
    })

    resolveChange!({ success: true })

    await waitFor(() => {
      expect(screen.getByTestId('sync-password-set')).toBeInTheDocument()
    })
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

  describe('tabs', () => {
    it('renders Tools, Data, Notification, and About tabs', () => {
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

      expect(screen.getByTestId('settings-tab-tools')).toBeInTheDocument()
      expect(screen.getByTestId('settings-tab-data')).toBeInTheDocument()
      expect(screen.getByTestId('settings-tab-notification')).toBeInTheDocument()
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

  describe('Language selector (Tools tab)', () => {
    it('renders the language selector', () => {
      renderAndSwitchToTools()
      expect(screen.getByTestId('settings-language-selector')).toBeInTheDocument()
    })

    it('calls appConfig.set and i18n.changeLanguage when language is changed', async () => {
      const { default: i18nMock } = await import('../../i18n')
      renderAndSwitchToTools()

      fireEvent.change(screen.getByTestId('settings-language-selector'), { target: { value: 'ja' } })
      expect(mockAppConfigSet).toHaveBeenCalledWith('language', 'ja')
      expect(i18nMock.changeLanguage).toHaveBeenCalledWith('ja')
    })
  })

  describe('Hub settings (Data tab)', () => {
    it('shows hub toggle on Data tab', () => {
      renderAndSwitchToData()

      expect(screen.getByTestId('hub-enable-toggle')).toBeInTheDocument()
      expect(screen.queryByTestId('theme-option-system')).not.toBeInTheDocument()
    })

    it('shows enabled status when hub is enabled', () => {
      renderAndSwitchToData({ hubEnabled: true })
      expect(screen.getByTestId('hub-enabled-status')).toBeInTheDocument()
    })

    it('shows confirmation when disconnect button is clicked', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToData({ hubEnabled: true, onHubEnabledChange })

      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      expect(screen.getByTestId('hub-disconnect-confirm')).toBeInTheDocument()
      expect(screen.getByTestId('hub-disconnect-cancel')).toBeInTheDocument()
      expect(onHubEnabledChange).not.toHaveBeenCalled()
    })

    it('calls onHubEnabledChange with false when confirmation is accepted', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToData({ hubEnabled: true, onHubEnabledChange })

      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      fireEvent.click(screen.getByTestId('hub-disconnect-confirm'))
      expect(onHubEnabledChange).toHaveBeenCalledWith(false)
    })

    it('cancels hub disconnect when cancel is clicked', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToData({ hubEnabled: true, onHubEnabledChange })

      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      fireEvent.click(screen.getByTestId('hub-disconnect-cancel'))
      expect(screen.getByTestId('hub-enable-toggle')).toBeInTheDocument()
      expect(onHubEnabledChange).not.toHaveBeenCalled()
    })

    it('calls onHubEnabledChange with true when enable button is clicked while authenticated', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToData({ hubEnabled: false, hubAuthenticated: true, onHubEnabledChange })
      fireEvent.click(screen.getByTestId('hub-enable-toggle'))
      expect(onHubEnabledChange).toHaveBeenCalledWith(true)
    })

    it('disables hub enable button when not authenticated', () => {
      const onHubEnabledChange = vi.fn()
      renderAndSwitchToData({ hubEnabled: false, hubAuthenticated: false, onHubEnabledChange })
      const button = screen.getByTestId('hub-enable-toggle')
      expect(button).toBeDisabled()
      fireEvent.click(button)
      expect(onHubEnabledChange).not.toHaveBeenCalled()
    })

    it('shows auth required message below connect button when not authenticated and disabled', () => {
      renderAndSwitchToData({ hubEnabled: false, hubAuthenticated: false })

      expect(screen.getByTestId('hub-requires-auth')).toBeInTheDocument()
      expect(screen.queryByTestId('hub-post-list')).not.toBeInTheDocument()
    })

    it('clears saved indicator timeout on unmount', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
      const onHubDisplayNameChange = vi.fn().mockResolvedValue({ success: true })
      const { unmount } = renderAndSwitchToData({
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
        renderAndSwitchToData({
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
        renderAndSwitchToData({
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
        renderAndSwitchToData({
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
        renderAndSwitchToData({
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
        renderAndSwitchToData({
          hubEnabled: true,
          hubAuthenticated: true,
          hubDisplayName: null,
        })

        expect(screen.getByTestId('hub-display-name-required')).toHaveTextContent('hub.displayNameRequired')
      })

      it('does not show required hint when display name is set', () => {
        renderAndSwitchToData({
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
        renderAndSwitchToData({
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
        renderAndSwitchToData({
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
      renderAndSwitchToData({ hubEnabled: true, hubAuthenticated: true })
      const input = screen.getByTestId('hub-display-name-input')
      expect(input).toHaveAttribute('maxLength', '50')
    })
  })

  describe('Notification tab', () => {
    function renderAndSwitchToNotification(props?: Partial<Parameters<typeof SettingsModal>[0]>) {
      const result = render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} {...props} />)
      fireEvent.click(screen.getByTestId('settings-tab-notification'))
      return result
    }

    it('renders notification tab', () => {
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)
      expect(screen.getByTestId('settings-tab-notification')).toBeInTheDocument()
    })

    it('fetches notifications when tab is activated', async () => {
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(mockNotificationFetch).toHaveBeenCalledOnce()
      })
    })

    it('shows empty message when no notifications', async () => {
      mockNotificationFetch.mockResolvedValueOnce({ success: true, notifications: [] })
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('notification.empty')).toBeInTheDocument()
      })
    })

    it('renders notification cards when notifications exist', async () => {
      mockNotificationFetch.mockResolvedValueOnce({
        success: true,
        notifications: [
          { title: 'Update v2.0', body: 'New features', type: 'Info', publishedAt: '2025-06-01T00:00:00Z' },
          { title: 'Maintenance', body: 'Scheduled downtime', type: 'Warning', publishedAt: '2025-05-15T00:00:00Z' },
        ],
      })
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('Update v2.0')).toBeInTheDocument()
      })
      expect(screen.getByText('Maintenance')).toBeInTheDocument()
    })

    it('shows at most 3 notifications sorted by date descending', async () => {
      mockNotificationFetch.mockResolvedValueOnce({
        success: true,
        notifications: [
          { title: 'Oldest', body: 'b1', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
          { title: 'Newest', body: 'b2', type: 'Info', publishedAt: '2025-06-01T00:00:00Z' },
          { title: 'Middle', body: 'b3', type: 'Info', publishedAt: '2025-03-01T00:00:00Z' },
          { title: 'Hidden', body: 'b4', type: 'Info', publishedAt: '2024-12-01T00:00:00Z' },
        ],
      })
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('Newest')).toBeInTheDocument()
      })
      expect(screen.getByText('Middle')).toBeInTheDocument()
      expect(screen.getByText('Oldest')).toBeInTheDocument()
      expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
    })

    it('shows empty message when fetch fails', async () => {
      mockNotificationFetch.mockResolvedValueOnce({ success: false, error: 'Network error' })
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('notification.empty')).toBeInTheDocument()
      })
    })

    it('shows empty message when fetch rejects', async () => {
      mockNotificationFetch.mockRejectedValueOnce(new Error('Network error'))
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('notification.empty')).toBeInTheDocument()
      })
    })

    it('re-fetches when switching away during in-flight fetch and returning', async () => {
      let resolveFetch!: (value: NotificationFetchResult) => void
      mockNotificationFetch.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve }))

      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

      // Switch to notification tab - starts fetch
      fireEvent.click(screen.getByTestId('settings-tab-notification'))
      expect(mockNotificationFetch).toHaveBeenCalledOnce()

      // Switch away before fetch resolves
      fireEvent.click(screen.getByTestId('settings-tab-tools'))

      // Resolve the in-flight fetch (cancelled by cleanup)
      resolveFetch({ success: true, notifications: [{ title: 'Old', body: 'b', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' }] })

      // Set up new mock for second fetch
      mockNotificationFetch.mockResolvedValueOnce({
        success: true,
        notifications: [{ title: 'Fresh', body: 'b', type: 'Info', publishedAt: '2025-06-01T00:00:00Z' }],
      })

      // Switch back to notification tab - should re-fetch
      fireEvent.click(screen.getByTestId('settings-tab-notification'))

      await waitFor(() => {
        expect(mockNotificationFetch).toHaveBeenCalledTimes(2)
      })
      await waitFor(() => {
        expect(screen.getByText('Fresh')).toBeInTheDocument()
      })
    })

    it('does not re-fetch when switching tabs after successful load', async () => {
      mockNotificationFetch.mockResolvedValueOnce({
        success: true,
        notifications: [{ title: 'Cached', body: 'b', type: 'Info', publishedAt: '2025-06-01T00:00:00Z' }],
      })
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('Cached')).toBeInTheDocument()
      })

      // Switch away and back
      fireEvent.click(screen.getByTestId('settings-tab-tools'))
      fireEvent.click(screen.getByTestId('settings-tab-notification'))

      expect(mockNotificationFetch).toHaveBeenCalledOnce()
      expect(screen.getByText('Cached')).toBeInTheDocument()
    })

    it('has aria-live region for async updates', () => {
      renderAndSwitchToNotification()

      expect(screen.getByTestId('notification-tab-content')).toHaveAttribute('aria-live', 'polite')
    })

    it('renders notifications as semantic list items', async () => {
      mockNotificationFetch.mockResolvedValueOnce({
        success: true,
        notifications: [{ title: 'Test', body: 'body', type: 'Info', publishedAt: '2025-06-01T00:00:00Z' }],
      })
      renderAndSwitchToNotification()

      await waitFor(() => {
        expect(screen.getByText('Test')).toBeInTheDocument()
      })
      const list = screen.getByTestId('notification-tab-content').querySelector('ul')
      expect(list).toBeInTheDocument()
      expect(list!.querySelectorAll('li')).toHaveLength(1)
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

    it('shows legal content', () => {
      renderAndSwitchToAbout()

      expect(screen.getByTestId('about-legal-content')).toBeInTheDocument()
    })

    it('does not show other tab content when About is active', () => {
      renderAndSwitchToAbout()

      expect(screen.queryByTestId('theme-option-system')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sync-sign-in')).not.toBeInTheDocument()
      expect(screen.queryByTestId('hub-enable-toggle')).not.toBeInTheDocument()
    })
  })

  describe('remote password check UI', () => {
    it('shows checking spinner when checkingRemotePassword is true', () => {
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, hasPassword: false, checkingRemotePassword: true }),
      })

      expect(screen.getByTestId('sync-checking-remote')).toBeInTheDocument()
      expect(screen.queryByTestId('sync-password-input')).not.toBeInTheDocument()
    })

    it('shows existing password hint when hasRemotePassword is true', () => {
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, hasPassword: false, hasRemotePassword: true }),
      })

      expect(screen.getByTestId('sync-existing-password-hint')).toBeInTheDocument()
    })

    it('does not show hint when hasRemotePassword is false', () => {
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, hasPassword: false, hasRemotePassword: false }),
      })

      expect(screen.queryByTestId('sync-existing-password-hint')).not.toBeInTheDocument()
    })

    it('shows sync unavailable banner when syncUnavailable is true', () => {
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, syncUnavailable: true }),
      })

      expect(screen.getByTestId('sync-unavailable')).toBeInTheDocument()
    })

    it('disables sync controls when syncUnavailable is true', () => {
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, syncUnavailable: true }),
      })

      expect(screen.getByTestId('sync-now')).toBeDisabled()
      expect(screen.getByTestId('sync-auto-on')).toBeDisabled()
    })

    it('disables password input and save when syncUnavailable is true', () => {
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, hasPassword: false, syncUnavailable: true }),
      })

      expect(screen.getByTestId('sync-password-input')).toBeDisabled()
      expect(screen.getByTestId('sync-password-save')).toBeDisabled()
    })

    it('calls retryRemoteCheck when retry button is clicked', async () => {
      const retryRemoteCheck = vi.fn()
      renderAndSwitchToData({
        sync: makeSyncMock({ ...FULLY_CONFIGURED, syncUnavailable: true, retryRemoteCheck }),
      })

      fireEvent.click(screen.getByTestId('sync-retry-btn'))
      expect(retryRemoteCheck).toHaveBeenCalledOnce()
    })
  })
})
