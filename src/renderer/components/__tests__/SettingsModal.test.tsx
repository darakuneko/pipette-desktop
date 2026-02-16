// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from '../SettingsModal'
import type { UseSyncReturn } from '../../hooks/useSync'
import { DEFAULT_APP_CONFIG } from '../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../editors/ModalCloseButton', () => ({
  ModalCloseButton: ({ testid, onClick }: { testid: string; onClick: () => void }) => (
    <button data-testid={testid} onClick={onClick}>close</button>
  ),
}))

const mockResetLocalTargets = vi.fn().mockResolvedValue({ success: true })
const mockExportLocalData = vi.fn().mockResolvedValue({ success: true })
const mockImportLocalData = vi.fn().mockResolvedValue({ success: true })
Object.defineProperty(window, 'vialAPI', {
  value: {
    resetLocalTargets: mockResetLocalTargets,
    exportLocalData: mockExportLocalData,
    importLocalData: mockImportLocalData,
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
    mockResetLocalTargets.mockClear()
    mockExportLocalData.mockClear()
    mockImportLocalData.mockClear()
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

  it('calls signOut when sign-out button is clicked', () => {
    const sync = makeSyncMock({ authStatus: { authenticated: true } })
    renderAndSwitchToData({ sync })

    fireEvent.click(screen.getByTestId('sync-sign-out'))
    expect(sync.signOut).toHaveBeenCalledOnce()
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
    it('renders Tools and Data tabs', () => {
      render(<SettingsModal sync={makeSyncMock()} {...defaultProps} onClose={onClose} />)

      expect(screen.getByTestId('settings-tab-tools')).toBeInTheDocument()
      expect(screen.getByTestId('settings-tab-data')).toBeInTheDocument()
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
})
