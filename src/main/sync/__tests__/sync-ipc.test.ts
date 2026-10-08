// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused coverage for the SYNC_RESET_TARGETS handler's keyLabels /
// typingTestTexts cases. sync-ipc.ts pulls in most of the main
// process's sync/typing-analytics surface, so every dependency is
// stubbed to a bare vi.fn() — this file intentionally does not attempt
// broader sync-ipc coverage.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  app: { getPath: vi.fn(() => '/mock/userData') },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('node:fs/promises', () => ({
  rm: vi.fn(async () => {}),
  readFile: vi.fn(async () => ''),
  readdir: vi.fn(async () => []),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}))

vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  getAppConfigStore: vi.fn(() => ({ clear: vi.fn() })),
  onAppConfigChange: vi.fn(),
}))

vi.mock('../sync-crypto', () => ({
  hasStoredPassword: vi.fn(),
  checkPasswordStrength: vi.fn(),
}))

const mockStartOAuthFlow = vi.fn(async (): Promise<void> => {})
const mockGetAuthStatus = vi.fn(async (): Promise<unknown> => ({ authenticated: false }))
vi.mock('../google-auth', () => ({
  startOAuthFlow: () => mockStartOAuthFlow(),
  getAuthStatus: () => mockGetAuthStatus(),
  signOut: vi.fn(),
}))

vi.mock('../../hub/hub-ipc', () => ({
  clearHubTokenCache: vi.fn(),
}))

const mockDeleteFilesByPrefix = vi.fn(async (..._args: unknown[]) => ({ attempted: 0, failed: 0 }))
const mockDeleteFilesByExactName = vi.fn(async (..._args: unknown[]) => ({ attempted: 0, failed: 0 }))
const mockDeleteFilesById = vi.fn(async (ids: readonly string[]): Promise<{ attempted: number; failed: number; firstError?: string }> => ({ attempted: ids.length, failed: 0 }))
vi.mock('../google-drive', () => ({
  deleteFilesByPrefix: (...args: unknown[]) => mockDeleteFilesByPrefix(...args),
  deleteFilesByExactName: (...args: unknown[]) => mockDeleteFilesByExactName(...args),
  deleteFilesById: (ids: readonly string[]) => mockDeleteFilesById(ids),
  driveFileName: (syncUnit: string) => `${syncUnit.replaceAll('/', '_')}.enc`,
}))

const mockCancelPendingChanges = vi.fn()
const mockListLocalKeyboardUids = vi.fn(async () => new Set<string>())
const mockAssertSyncAllowed = vi.fn(async () => {})
const mockForgetChangeStateCache = vi.fn()
const mockAssertNoLocalPasswordChange = vi.fn(async () => {})
const mockGetPasswordChangeLockStatus = vi.fn(async (): Promise<unknown> => null)
const mockReleasePasswordChangeLocks = vi.fn(async (): Promise<void> => {})
const mockReplacePasswordAndValidate = vi.fn(async (_password: string): Promise<void> => {})
const mockSetPasswordAndValidate = vi.fn(async (_password: string): Promise<void> => {})
const mockScheduleFlushIfPending = vi.fn()
const mockStartPolling = vi.fn()
const mockStartPollingIfAutoSync = vi.fn()
const mockStartPollingAtLaunch = vi.fn()
const mockStopPolling = vi.fn()
const { MockSyncBlockedError } = vi.hoisted(() => ({
  MockSyncBlockedError: class MockSyncBlockedError extends Error {
    readonly reason: string | undefined
    constructor(message: string, reason?: string) {
      super(message)
      this.reason = reason
    }
  },
}))
const mockResetPasswordCheckCache = vi.fn()
const mockForgetCreatedSyncFormatMarker = vi.fn()
const mockGetCachedSyncFormatStatus = vi.fn((): unknown => null)
const mockRefreshSyncFormatStatus = vi.fn(async (): Promise<unknown> => null)
const mockClearSyncFormatStatus = vi.fn()
const mockSetSyncFormatStatusListener = vi.fn()
const mockBroadcastToAllWindows = vi.fn()
vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}))
// The reset lock runs for real on the real sync-runtime-state, so the tests
// below can hold the lock and register analytics writers themselves.
vi.mock('../sync-service', async () => ({
  withResetLock: (await vi.importActual<typeof import('../sync-reset-lock')>('../sync-reset-lock')).withResetLock,
  executeAnalyticsSync: vi.fn(),
  executeSync: vi.fn(async () => ({ status: 'success' })),
  hasPendingChanges: vi.fn(),
  cancelPendingChanges: (...args: unknown[]) => mockCancelPendingChanges(...args),
  listLocalKeyboardUids: () => mockListLocalKeyboardUids(),
  notifyChange: vi.fn(),
  scheduleFlushIfPending: (...args: unknown[]) => mockScheduleFlushIfPending(...args),
  setProgressCallback: vi.fn(),
  setupBeforeQuitHandler: vi.fn(),
  startPolling: () => mockStartPolling(),
  startPollingIfAutoSync: () => mockStartPollingIfAutoSync(),
  startPollingAtLaunch: () => mockStartPollingAtLaunch(),
  stopPolling: () => mockStopPolling(),
  collectAllSyncUnits: vi.fn(async () => []),
  bundleSyncUnit: vi.fn(),
  readIndexFile: vi.fn(),
  resetPasswordCheckCache: () => mockResetPasswordCheckCache(),
  forgetCreatedSyncFormatMarker: () => mockForgetCreatedSyncFormatMarker(),
  getCachedSyncFormatStatus: () => mockGetCachedSyncFormatStatus(),
  refreshSyncFormatStatus: () => mockRefreshSyncFormatStatus(),
  clearSyncFormatStatus: () => mockClearSyncFormatStatus(),
  setSyncFormatStatusListener: (listener: unknown) => mockSetSyncFormatStatusListener(listener),
  listUndecryptableFiles: vi.fn(),
  scanRemoteData: vi.fn(),
  fetchRemoteBundle: vi.fn(),
  startPasswordChange: vi.fn(),
  resumePasswordChange: vi.fn(),
  revertPasswordChange: vi.fn(),
  abandonPasswordChange: vi.fn(),
  deletePasswordChangeUndecryptableFiles: vi.fn(),
  recoverPasswordChangeOnStartup: vi.fn(async () => 'none'),
  getPasswordChangeStatus: vi.fn(),
  getPasswordChangeLockStatus: () => mockGetPasswordChangeLockStatus(),
  releasePasswordChangeLocks: () => mockReleasePasswordChangeLocks(),
  checkPasswordCheckExists: vi.fn(),
  setPasswordAndValidate: (password: string) => mockSetPasswordAndValidate(password),
  replacePasswordAndValidate: (password: string) => mockReplacePasswordAndValidate(password),
  deleteRemoteTypingDay: vi.fn(),
  fetchRemoteTypingDay: vi.fn(),
  hasAnyRemoteTypingData: vi.fn(),
  listRemoteTypingDaysFor: vi.fn(),
  listRemoteTypingHashesForUidFromCloud: vi.fn(),
  listRemoteFileNames: vi.fn(),
  SyncCredentialError: class SyncCredentialError extends Error {},
  SyncBlockedError: MockSyncBlockedError,
  assertSyncAllowed: () => mockAssertSyncAllowed(),
  forgetChangeStateCache: () => mockForgetChangeStateCache(),
  assertNoLocalPasswordChange: () => mockAssertNoLocalPasswordChange(),
}))

vi.mock('../../typing-analytics/import-export', () => ({
  exportTypingDataForKeyboard: vi.fn(),
  importTypingDataFiles: vi.fn(),
}))
vi.mock('../../typing-analytics/machine-hash', () => ({ getMachineHash: vi.fn() }))
vi.mock('../../typing-analytics/cache-rebuild', () => ({ ensureCacheIsFresh: vi.fn() }))
vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({ getTypingAnalyticsDB: vi.fn() }))
const mockDeleteAllTypingForKeyboard = vi.fn(async (_uid: string): Promise<void> => {})
const mockListTypingKeyboards = vi.fn((): Array<{ uid: string }> => [])
vi.mock('../../typing-analytics/typing-analytics-service', () => ({
  deleteAllTypingForKeyboard: (uid: string) => mockDeleteAllTypingForKeyboard(uid),
  listTypingKeyboards: () => mockListTypingKeyboards(),
}))

vi.mock('../../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle, secureOn: vi.fn() }
})

vi.mock('../keyboard-meta', () => ({
  extractDeviceNameFromFilename: vi.fn(),
  getActiveKeyboardMetaMap: vi.fn(),
  readKeyboardMetaIndex: vi.fn(),
  tombstoneAllKeyboardMeta: vi.fn(),
  tombstoneKeyboardMeta: vi.fn(),
  upsertKeyboardMeta: vi.fn(),
  nameKeyboardOnConnect: vi.fn(),
}))

import { setupSyncIpc } from '../sync-ipc'
import { syncRuntime, claimSyncLock, tryClaimSyncLock, resetSyncRuntimeForTests } from '../sync-runtime-state'
import { ipcMain } from 'electron'
import { onAppConfigChange } from '../../app-config'
import { IpcChannels } from '../../../shared/ipc/channels'
import { KEY_LABEL_SYNC_UNIT } from '../../key-label-store'
import { TYPING_TEST_TEXT_SYNC_UNIT } from '../../typing-test-text-store'

type ResetTargetsHandler = (_event: unknown, targets: unknown) => Promise<{ success: boolean; error?: string }>

function getResetTargetsHandler(): ResetTargetsHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([channel]) => channel === IpcChannels.SYNC_RESET_TARGETS)
  if (!match) throw new Error('SYNC_RESET_TARGETS handler not registered')
  return match[1] as ResetTargetsHandler
}

function getHandler(channel: string): (...args: unknown[]) => Promise<{ success: boolean; error?: string }> {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel)
  if (!match) throw new Error(`${channel} handler not registered`)
  return match[1] as (...args: unknown[]) => Promise<{ success: boolean; error?: string }>
}

describe('sync-ipc while a sync password change is in progress', () => {
  const blockedKey = 'sync.passwordChange.blockedByOtherDevice'

  beforeEach(() => {
    vi.clearAllMocks()
    mockAssertSyncAllowed.mockRejectedValue(new MockSyncBlockedError(blockedKey))
    setupSyncIpc()
  })

  it('SYNC_PASSWORD_CHANGE_LOCK_STATUS is answered without the sync guard', async () => {
    mockGetPasswordChangeLockStatus.mockResolvedValueOnce({ startedAt: '2026-10-02T09:00:00.000Z', ownMachine: false })

    const result = await getHandler(IpcChannels.SYNC_PASSWORD_CHANGE_LOCK_STATUS)(null)

    expect(result).toEqual({ startedAt: '2026-10-02T09:00:00.000Z', ownMachine: false })
    expect(mockAssertSyncAllowed).not.toHaveBeenCalled()
  })

  it('SYNC_PASSWORD_CHANGE_RELEASE_LOCKS releases without the sync guard', async () => {
    const result = await getHandler(IpcChannels.SYNC_PASSWORD_CHANGE_RELEASE_LOCKS)(null)

    expect(result).toEqual({ success: true })
    expect(mockReleasePasswordChangeLocks).toHaveBeenCalledTimes(1)
    expect(mockAssertSyncAllowed).not.toHaveBeenCalled()
  })

  it('SYNC_PASSWORD_CHANGE_RELEASE_LOCKS returns the refusal as an error key', async () => {
    mockReleasePasswordChangeLocks.mockRejectedValueOnce(new MockSyncBlockedError('sync.passwordChange.blockedLocal'))

    const result = await getHandler(IpcChannels.SYNC_PASSWORD_CHANGE_RELEASE_LOCKS)(null)

    expect(result).toEqual({ success: false, error: 'sync.passwordChange.blockedLocal' })
  })

  it('SYNC_RESET_TARGETS deletes nothing', async () => {
    const result = await getHandler(IpcChannels.SYNC_RESET_TARGETS)(null, { keyboards: true, favorites: true, keyLabels: true })

    expect(result).toEqual({ success: false, error: blockedKey })
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
    expect(mockDeleteFilesByExactName).not.toHaveBeenCalled()
    expect(mockCancelPendingChanges).not.toHaveBeenCalled()
  })

  it('SYNC_DELETE_FILES deletes nothing', async () => {
    const result = await getHandler(IpcChannels.SYNC_DELETE_FILES)(null, ['id-1'])

    expect(result).toEqual({ success: false, error: blockedKey })
    expect(mockDeleteFilesById).not.toHaveBeenCalled()
  })

  it('RESET_KEYBOARD_DATA is refused before anything is removed', async () => {
    const result = await getHandler(IpcChannels.RESET_KEYBOARD_DATA)(null, 'uid1')

    expect(result).toEqual({ success: false, error: blockedKey })
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
    expect(mockCancelPendingChanges).not.toHaveBeenCalled()
  })

  it('RESET_KEYBOARD_DATA resets locally but skips the remote delete when Drive cannot be checked', async () => {
    mockAssertSyncAllowed.mockRejectedValue(new Error('Not authenticated with Google Drive'))

    const result = await getHandler(IpcChannels.RESET_KEYBOARD_DATA)(null, 'uid1')

    expect(result.success).toBe(true)
    expect(mockCancelPendingChanges).toHaveBeenCalledWith('keyboards/uid1/')
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
  })

  it('RESET_KEYBOARD_DATA resets locally but skips the remote delete when Drive needs a newer app', async () => {
    mockAssertSyncAllowed.mockRejectedValue(new MockSyncBlockedError('sync.updateRequired', 'updateRequired'))

    const result = await getHandler(IpcChannels.RESET_KEYBOARD_DATA)(null, 'uid1')

    expect(result.success).toBe(true)
    expect(mockCancelPendingChanges).toHaveBeenCalledWith('keyboards/uid1/')
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
  })

  it.each([
    ['SYNC_RESET_TARGETS', IpcChannels.SYNC_RESET_TARGETS, { keyboards: true, favorites: true }],
    ['SYNC_DELETE_FILES', IpcChannels.SYNC_DELETE_FILES, ['id-1']],
  ])('%s stays refused when Drive needs a newer app', async (_name, channel, arg) => {
    mockAssertSyncAllowed.mockRejectedValue(new MockSyncBlockedError('sync.updateRequired', 'updateRequired'))

    const result = await getHandler(channel)(null, arg)

    expect(result).toEqual({ success: false, error: 'sync.updateRequired' })
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
    expect(mockDeleteFilesById).not.toHaveBeenCalled()
  })

  it('SYNC_AUTH_SIGN_OUT forgets the created sync-format marker with the password-check cache', async () => {
    const result = await getHandler(IpcChannels.SYNC_AUTH_SIGN_OUT)(null)

    expect(result).toEqual({ success: true })
    expect(mockResetPasswordCheckCache).toHaveBeenCalledTimes(1)
    expect(mockForgetCreatedSyncFormatMarker).toHaveBeenCalledTimes(1)
    expect(mockClearSyncFormatStatus).toHaveBeenCalledTimes(1)
  })

  it('RESET_LOCAL_TARGETS refuses to remove app settings while a local password change exists', async () => {
    mockAssertNoLocalPasswordChange.mockRejectedValueOnce(new MockSyncBlockedError('sync.passwordChange.blockedLocal'))
    const { rm } = await import('node:fs/promises')

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: false, appSettings: true })

    expect(result).toEqual({ success: false, error: 'sync.passwordChange.blockedLocal' })
    expect(rm).not.toHaveBeenCalled()
    expect(mockCancelPendingChanges).not.toHaveBeenCalled()
  })

  it('RESET_LOCAL_TARGETS without app settings does not check for a password change', async () => {
    mockAssertNoLocalPasswordChange.mockRejectedValueOnce(new MockSyncBlockedError('sync.passwordChange.blockedLocal'))

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: false, appSettings: false })

    expect(result.success).toBe(true)
    mockAssertNoLocalPasswordChange.mockReset()
    mockAssertNoLocalPasswordChange.mockResolvedValue(undefined)
  })

  it('RESET_LOCAL_TARGETS forgets the cached password-change state when it removes local/auth', async () => {
    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: false, appSettings: true })

    expect(result.success).toBe(true)
    expect(mockForgetChangeStateCache).toHaveBeenCalled()
  })
})

describe('sync-ipc SYNC_REPLACE_PASSWORD', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSyncIpc()
  })

  it('replaces the password and reports success', async () => {
    const result = await getHandler(IpcChannels.SYNC_REPLACE_PASSWORD)(null, 'other-pc-password')

    expect(result).toEqual({ success: true })
    expect(mockReplacePasswordAndValidate).toHaveBeenCalledWith('other-pc-password')
  })

  it('returns a mismatch as its error key', async () => {
    mockReplacePasswordAndValidate.mockRejectedValueOnce(new Error('sync.passwordMismatch'))

    const result = await getHandler(IpcChannels.SYNC_REPLACE_PASSWORD)(null, 'wrong')

    expect(result).toEqual({ success: false, error: 'sync.passwordMismatch' })
  })

  it('refuses an empty password without calling the service', async () => {
    const result = await getHandler(IpcChannels.SYNC_REPLACE_PASSWORD)(null, '')

    expect(result.success).toBe(false)
    expect(mockReplacePasswordAndValidate).not.toHaveBeenCalled()
  })
})

describe('sync-ipc pending changes kept by a flush', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStartOAuthFlow.mockResolvedValue(undefined)
    setupSyncIpc()
  })

  function configListener(): (key: string, value: unknown) => void {
    const listener = vi.mocked(onAppConfigChange).mock.calls.at(-1)?.[0]
    if (!listener) throw new Error('onAppConfigChange listener not registered')
    return listener as (key: string, value: unknown) => void
  }

  it('turning auto sync on starts polling and schedules a flush of pending changes', () => {
    configListener()('autoSync', true)

    expect(mockStartPolling).toHaveBeenCalledTimes(1)
    expect(mockScheduleFlushIfPending).toHaveBeenCalledTimes(1)
  })

  it('turning auto sync off schedules no flush', () => {
    configListener()('autoSync', false)

    expect(mockStopPolling).toHaveBeenCalledTimes(1)
    expect(mockScheduleFlushIfPending).not.toHaveBeenCalled()
  })

  it('SYNC_SET_PASSWORD schedules a flush once the password is stored', async () => {
    const result = await getHandler(IpcChannels.SYNC_SET_PASSWORD)(null, 'my-password')

    expect(result).toEqual({ success: true })
    expect(mockScheduleFlushIfPending).toHaveBeenCalledTimes(1)
    expect(mockSetPasswordAndValidate.mock.invocationCallOrder[0])
      .toBeLessThan(mockScheduleFlushIfPending.mock.invocationCallOrder[0])
  })

  it('SYNC_SET_PASSWORD schedules no flush when the password is refused', async () => {
    mockSetPasswordAndValidate.mockRejectedValueOnce(new Error('sync.passwordMismatch'))

    const result = await getHandler(IpcChannels.SYNC_SET_PASSWORD)(null, 'wrong')

    expect(result.success).toBe(false)
    expect(mockScheduleFlushIfPending).not.toHaveBeenCalled()
  })

  it('SYNC_REPLACE_PASSWORD schedules a flush once the password is stored', async () => {
    await getHandler(IpcChannels.SYNC_REPLACE_PASSWORD)(null, 'other-pc-password')

    expect(mockScheduleFlushIfPending).toHaveBeenCalledTimes(1)
  })

  it('SYNC_REPLACE_PASSWORD schedules no flush when the password is refused', async () => {
    mockReplacePasswordAndValidate.mockRejectedValueOnce(new Error('sync.passwordMismatch'))

    await getHandler(IpcChannels.SYNC_REPLACE_PASSWORD)(null, 'wrong')

    expect(mockScheduleFlushIfPending).not.toHaveBeenCalled()
  })

  it('SYNC_AUTH_START schedules a flush after signing in', async () => {
    const result = await getHandler(IpcChannels.SYNC_AUTH_START)(null)

    expect(result).toEqual({ success: true })
    expect(mockScheduleFlushIfPending).toHaveBeenCalledTimes(1)
  })

  it('SYNC_AUTH_START schedules no flush when signing in fails', async () => {
    mockStartOAuthFlow.mockRejectedValueOnce(new Error('denied'))

    await getHandler(IpcChannels.SYNC_AUTH_START)(null)

    expect(mockScheduleFlushIfPending).not.toHaveBeenCalled()
  })

  it('SYNC_AUTH_SIGN_OUT keeps the pending changes', async () => {
    const result = await getHandler(IpcChannels.SYNC_AUTH_SIGN_OUT)(null)

    expect(result).toEqual({ success: true })
    expect(mockCancelPendingChanges).not.toHaveBeenCalled()
  })
})

describe('sync-ipc SYNC_RESET_TARGETS — keyLabels / typingTestTexts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAssertSyncAllowed.mockResolvedValue(undefined)
    setupSyncIpc()
  })

  it('deletes the exact key-labels remote file and cancels its pending changes', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true })

    expect(result.success).toBe(true)
    expect(mockDeleteFilesByExactName).toHaveBeenCalledWith(`${KEY_LABEL_SYNC_UNIT}.enc`)
    expect(mockCancelPendingChanges).toHaveBeenCalledWith(KEY_LABEL_SYNC_UNIT)
  })

  it('deletes the exact typing-test-texts remote file and cancels its pending changes', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, typingTestTexts: true })

    expect(result.success).toBe(true)
    expect(mockDeleteFilesByExactName).toHaveBeenCalledWith(`${TYPING_TEST_TEXT_SYNC_UNIT}.enc`)
    expect(mockCancelPendingChanges).toHaveBeenCalledWith(TYPING_TEST_TEXT_SYNC_UNIT)
  })

  it('rejects a non-boolean keyLabels target', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: 'yes' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/keyLabels must be boolean/)
    expect(mockDeleteFilesByExactName).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean typingTestTexts target', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, typingTestTexts: 1 })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/typingTestTexts must be boolean/)
  })

  it('rejects an all-false target set even when keyLabels/typingTestTexts are present but false', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: false, typingTestTexts: false })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No targets selected/)
  })

  it('rejects while a sync is already in progress', async () => {
    const releaseLock = claimSyncLock()
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true })
    releaseLock()

    expect(result).toEqual({ success: false, error: 'Cannot reset while sync is in progress' })
    expect(mockDeleteFilesByExactName).not.toHaveBeenCalled()
  })

  it('handles both keyLabels and typingTestTexts selected together', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true, typingTestTexts: true })

    expect(result.success).toBe(true)
    expect(mockDeleteFilesByExactName).toHaveBeenCalledWith(`${KEY_LABEL_SYNC_UNIT}.enc`)
    expect(mockDeleteFilesByExactName).toHaveBeenCalledWith(`${TYPING_TEST_TEXT_SYNC_UNIT}.enc`)
  })

  // A rejected Drive delete must surface as a reset failure with a
  // unit-name-only message — not be silently discarded by the
  // underlying Promise.allSettled inside deleteMatchingFiles.
  it('reports failure with a unit-name-only message when a delete batch had a rejection', async () => {
    mockDeleteFilesByExactName.mockResolvedValueOnce({ attempted: 1, failed: 1 })
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/keyLabels/)
    // Unit-name-only: no raw filename/content in the surfaced message.
    expect(result.error).not.toMatch(/\.enc/)
  })

  it('still attempts every requested target even when an earlier one failed', async () => {
    mockDeleteFilesByExactName.mockResolvedValueOnce({ attempted: 1, failed: 1 })
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true, typingTestTexts: true })

    expect(result.success).toBe(false)
    expect(mockDeleteFilesByExactName).toHaveBeenCalledWith(`${KEY_LABEL_SYNC_UNIT}.enc`)
    expect(mockDeleteFilesByExactName).toHaveBeenCalledWith(`${TYPING_TEST_TEXT_SYNC_UNIT}.enc`)
  })
})

describe('sync-ipc sync-format status', () => {
  const newer = { required: 2, supported: 1, updateRequired: true }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedSyncFormatStatus.mockReturnValue(null)
    mockRefreshSyncFormatStatus.mockResolvedValue(newer)
    mockGetAuthStatus.mockResolvedValue({ authenticated: false })
    mockStartOAuthFlow.mockResolvedValue(undefined)
  })

  it('checks Drive at startup when signed in', async () => {
    mockGetAuthStatus.mockResolvedValue({ authenticated: true })

    setupSyncIpc()

    await vi.waitFor(() => expect(mockRefreshSyncFormatStatus).toHaveBeenCalledTimes(1))
  })

  it('does not check Drive at startup when signed out', async () => {
    setupSyncIpc()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockRefreshSyncFormatStatus).not.toHaveBeenCalled()
  })

  describe('after setup', () => {
    beforeEach(async () => {
      setupSyncIpc()
      await new Promise((resolve) => setTimeout(resolve, 0))
      mockRefreshSyncFormatStatus.mockClear()
    })

    it('SYNC_FORMAT_STATUS returns the cached status without listing Drive', async () => {
      mockGetCachedSyncFormatStatus.mockReturnValue(newer)

      expect(await getHandler(IpcChannels.SYNC_FORMAT_STATUS)(null)).toEqual(newer)
      expect(mockRefreshSyncFormatStatus).not.toHaveBeenCalled()
    })

    it('SYNC_FORMAT_STATUS checks Drive when nothing is cached and the user is signed in', async () => {
      mockGetAuthStatus.mockResolvedValue({ authenticated: true })

      expect(await getHandler(IpcChannels.SYNC_FORMAT_STATUS)(null)).toEqual(newer)
      expect(mockRefreshSyncFormatStatus).toHaveBeenCalledTimes(1)
    })

    it('SYNC_FORMAT_STATUS is null when nothing is cached and the user is signed out', async () => {
      expect(await getHandler(IpcChannels.SYNC_FORMAT_STATUS)(null)).toBeNull()
      expect(mockRefreshSyncFormatStatus).not.toHaveBeenCalled()
    })

    it('SYNC_FORMAT_STATUS is null instead of throwing when the auth check fails', async () => {
      mockGetAuthStatus.mockRejectedValue(new Error('keystore'))

      expect(await getHandler(IpcChannels.SYNC_FORMAT_STATUS)(null)).toBeNull()
    })

    it('a successful sign-in forgets the previous status and checks Drive again', async () => {
      const result = await getHandler(IpcChannels.SYNC_AUTH_START)(null)

      expect(result).toEqual({ success: true })
      expect(mockClearSyncFormatStatus).toHaveBeenCalledTimes(1)
      expect(mockRefreshSyncFormatStatus).toHaveBeenCalledTimes(1)
      expect(mockClearSyncFormatStatus.mock.invocationCallOrder[0])
        .toBeLessThan(mockRefreshSyncFormatStatus.mock.invocationCallOrder[0])
    })

    it('sends every status change to the renderer', () => {
      setupSyncIpc()
      const listener = mockSetSyncFormatStatusListener.mock.calls.at(-1)?.[0] as (status: unknown) => void

      listener(newer)
      listener(null)

      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IpcChannels.SYNC_FORMAT_STATUS_CHANGED, newer)
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IpcChannels.SYNC_FORMAT_STATUS_CHANGED, null)
    })

    it('a failed sign-in leaves the status alone', async () => {
      mockStartOAuthFlow.mockRejectedValueOnce(new Error('denied'))

      const result = await getHandler(IpcChannels.SYNC_AUTH_START)(null)

      expect(result).toEqual({ success: false, error: 'denied' })
      expect(mockClearSyncFormatStatus).not.toHaveBeenCalled()
      expect(mockRefreshSyncFormatStatus).not.toHaveBeenCalled()
    })
  })
})

describe('sync-ipc starting the poll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStartOAuthFlow.mockResolvedValue(undefined)
    mockSetPasswordAndValidate.mockResolvedValue(undefined)
    mockReplacePasswordAndValidate.mockResolvedValue(undefined)
  })

  it('asks for launch polling at setup', () => {
    setupSyncIpc()

    expect(mockStartPollingAtLaunch).toHaveBeenCalledTimes(1)
    expect(mockStartPollingIfAutoSync).not.toHaveBeenCalled()
    expect(mockStartPolling).not.toHaveBeenCalled()
  })

  describe.each([
    { name: 'SYNC_AUTH_START', channel: IpcChannels.SYNC_AUTH_START, args: [] as unknown[], fail: () => mockStartOAuthFlow.mockRejectedValueOnce(new Error('denied')) },
    { name: 'SYNC_SET_PASSWORD', channel: IpcChannels.SYNC_SET_PASSWORD, args: ['my-password'] as unknown[], fail: () => mockSetPasswordAndValidate.mockRejectedValueOnce(new Error('sync.passwordMismatch')) },
    { name: 'SYNC_REPLACE_PASSWORD', channel: IpcChannels.SYNC_REPLACE_PASSWORD, args: ['other-pc-password'] as unknown[], fail: () => mockReplacePasswordAndValidate.mockRejectedValueOnce(new Error('sync.passwordMismatch')) },
  ])('$name', ({ channel, args, fail }) => {
    it('asks to start polling on success', async () => {
      setupSyncIpc()

      const result = await getHandler(channel)(null, ...args)

      expect(result.success).toBe(true)
      expect(mockStartPollingIfAutoSync).toHaveBeenCalledTimes(1)
    })

    it('does not start polling on failure', async () => {
      setupSyncIpc()
      fail()

      const result = await getHandler(channel)(null, ...args)

      expect(result.success).toBe(false)
      expect(mockStartPollingIfAutoSync).not.toHaveBeenCalled()
      expect(mockStartPolling).not.toHaveBeenCalled()
    })
  })

  it('signing out stops the poll and signing in again asks to start it', async () => {
    setupSyncIpc()

    await getHandler(IpcChannels.SYNC_AUTH_SIGN_OUT)(null)
    expect(mockStopPolling).toHaveBeenCalledTimes(1)
    expect(mockStartPollingIfAutoSync).not.toHaveBeenCalled()

    await getHandler(IpcChannels.SYNC_AUTH_START)(null)
    expect(mockStartPollingIfAutoSync).toHaveBeenCalledTimes(1)
    expect(mockStopPolling.mock.invocationCallOrder[0])
      .toBeLessThan(mockStartPollingIfAutoSync.mock.invocationCallOrder[0])
  })

  it('SYNC_EXECUTE asks to start polling after a download only', async () => {
    setupSyncIpc()

    await getHandler(IpcChannels.SYNC_EXECUTE)(null, 'upload')
    expect(mockStartPollingIfAutoSync).not.toHaveBeenCalled()

    await getHandler(IpcChannels.SYNC_EXECUTE)(null, 'download')
    expect(mockStartPollingIfAutoSync).toHaveBeenCalledTimes(1)
  })
})

describe('sync-ipc resets hold the sync lock', () => {
  type Gate = { promise: Promise<void>; release: () => void }
  function makeGate(): Gate {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  const busy = 'Cannot reset while sync is in progress'
  // Each handler with an argument that reaches its first await, and the mock
  // that await waits on.
  const handlers: Array<[string, string, unknown, string, (gate: Gate) => void]> = [
    ['SYNC_RESET_TARGETS', IpcChannels.SYNC_RESET_TARGETS, { keyboards: true, favorites: false }, busy,
      (gate) => mockAssertSyncAllowed.mockImplementationOnce(() => gate.promise)],
    ['RESET_KEYBOARD_DATA', IpcChannels.RESET_KEYBOARD_DATA, 'uid1', busy,
      (gate) => mockAssertSyncAllowed.mockImplementationOnce(() => gate.promise)],
    ['RESET_LOCAL_TARGETS', IpcChannels.RESET_LOCAL_TARGETS, { keyboards: true, favorites: false, appSettings: false }, busy,
      (gate) => mockListLocalKeyboardUids.mockImplementationOnce(async () => {
        await gate.promise
        return new Set<string>()
      })],
    ['SYNC_DELETE_FILES', IpcChannels.SYNC_DELETE_FILES, ['id-1'], 'Cannot delete while sync is in progress',
      (gate) => mockAssertSyncAllowed.mockImplementationOnce(() => gate.promise)],
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockAssertSyncAllowed.mockResolvedValue(undefined)
    resetSyncRuntimeForTests()
    setupSyncIpc()
  })

  it.each(handlers)('%s holds the lock across its awaits and releases it at the end', async (_name, channel, arg, _busy, holdAt) => {
    const gate = makeGate()
    holdAt(gate)

    const result = getHandler(channel)(null, arg)
    expect(tryClaimSyncLock()).toBeNull()
    expect(syncRuntime.inFlightPassWaitable).toBe(true)

    gate.release()
    expect((await result).success).toBe(true)
    expect(syncRuntime.isSyncing).toBe(false)
    expect(syncRuntime.resetKeyboards).toBeNull()
  })

  it.each(handlers)('%s is refused with its error while a sync holds the lock', async (_name, channel, arg, busyMessage) => {
    const { rm } = await import('node:fs/promises')
    const releaseLock = claimSyncLock()

    const result = await getHandler(channel)(null, arg)
    releaseLock()

    expect(result).toEqual({ success: false, error: busyMessage })
    expect(mockAssertSyncAllowed).not.toHaveBeenCalled()
    expect(mockCancelPendingChanges).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
    expect(mockDeleteFilesById).not.toHaveBeenCalled()
  })

  it.each([
    ['SYNC_RESET_TARGETS', IpcChannels.SYNC_RESET_TARGETS, { keyboards: true, favorites: false }],
    ['RESET_KEYBOARD_DATA', IpcChannels.RESET_KEYBOARD_DATA, 'uid1'],
    ['SYNC_DELETE_FILES', IpcChannels.SYNC_DELETE_FILES, ['id-1']],
  ])('%s releases the lock when it throws', async (_name, channel, arg) => {
    mockAssertSyncAllowed.mockRejectedValueOnce(new MockSyncBlockedError('sync.passwordChange.blockedLocal'))

    const result = await getHandler(channel)(null, arg)

    expect(result.success).toBe(false)
    expect(syncRuntime.isSyncing).toBe(false)
    expect(syncRuntime.resetKeyboards).toBeNull()
  })

  it('RESET_LOCAL_TARGETS releases the lock when a remove throws', async () => {
    const { rm } = await import('node:fs/promises')
    vi.mocked(rm).mockRejectedValueOnce(new Error('EBUSY'))

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: true, appSettings: false })

    expect(result).toEqual({ success: false, error: 'EBUSY' })
    expect(syncRuntime.isSyncing).toBe(false)
  })

  it('SYNC_RESET_TARGETS refuses an invalid uid before taking the lock or deleting anything', async () => {
    const result = await getHandler(IpcChannels.SYNC_RESET_TARGETS)(null, { keyboards: ['uid1', '../x'], favorites: false })

    expect(result).toEqual({ success: false, error: 'Invalid keyboard UID' })
    expect(mockAssertSyncAllowed).not.toHaveBeenCalled()
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
  })

  it('SYNC_DELETE_FILES refuses a non-string id before taking the lock or deleting anything', async () => {
    const result = await getHandler(IpcChannels.SYNC_DELETE_FILES)(null, ['id-1', 2])

    expect(result).toEqual({ success: false, error: 'Invalid file ID' })
    expect(mockAssertSyncAllowed).not.toHaveBeenCalled()
    expect(mockDeleteFilesById).not.toHaveBeenCalled()
  })

  it('SYNC_DELETE_FILES deletes every id in one batch and reports failed deletes', async () => {
    mockDeleteFilesById.mockResolvedValueOnce({ attempted: 3, failed: 1, firstError: 'Drive API error 403' })

    const result = await getHandler(IpcChannels.SYNC_DELETE_FILES)(null, ['id-1', 'id-2', 'id-3'])

    expect(mockDeleteFilesById).toHaveBeenCalledWith(['id-1', 'id-2', 'id-3'])
    expect(result).toEqual({ success: false, error: 'Failed to delete 1 of 3 files: Drive API error 403' })
  })

  describe('while an analytics sync of uid1 runs', () => {
    beforeEach(() => {
      syncRuntime.analyticsSyncingUids.add('uid1')
    })

    it.each([
      ['RESET_KEYBOARD_DATA of uid1', IpcChannels.RESET_KEYBOARD_DATA, 'uid1'],
      ['SYNC_RESET_TARGETS of uid1', IpcChannels.SYNC_RESET_TARGETS, { keyboards: ['uid1'], favorites: false }],
      ['SYNC_RESET_TARGETS of every keyboard', IpcChannels.SYNC_RESET_TARGETS, { keyboards: true, favorites: false }],
      ['RESET_LOCAL_TARGETS of keyboards', IpcChannels.RESET_LOCAL_TARGETS, { keyboards: true, favorites: false, appSettings: false }],
    ])('%s is refused', async (_name, channel, arg) => {
      const result = await getHandler(channel)(null, arg)

      expect(result).toEqual({ success: false, error: busy })
      expect(mockCancelPendingChanges).not.toHaveBeenCalled()
      expect(syncRuntime.isSyncing).toBe(false)
    })

    it.each([
      ['RESET_KEYBOARD_DATA of uid2', IpcChannels.RESET_KEYBOARD_DATA, 'uid2'],
      ['SYNC_RESET_TARGETS of favorites', IpcChannels.SYNC_RESET_TARGETS, { keyboards: false, favorites: true }],
      ['RESET_LOCAL_TARGETS of favorites', IpcChannels.RESET_LOCAL_TARGETS, { keyboards: false, favorites: true, appSettings: false }],
    ])('%s runs', async (_name, channel, arg) => {
      expect((await getHandler(channel)(null, arg)).success).toBe(true)
    })
  })

  describe('while a remote day fetch of uid1 runs', () => {
    beforeEach(() => {
      syncRuntime.remoteTypingDayFetches.set('uid1', 1)
    })

    it.each([
      ['RESET_KEYBOARD_DATA of uid1', IpcChannels.RESET_KEYBOARD_DATA, 'uid1'],
      ['RESET_LOCAL_TARGETS of keyboards', IpcChannels.RESET_LOCAL_TARGETS, { keyboards: true, favorites: false, appSettings: false }],
    ])('%s is refused', async (_name, channel, arg) => {
      expect(await getHandler(channel)(null, arg)).toEqual({ success: false, error: busy })
    })

    it.each([
      ['RESET_KEYBOARD_DATA of uid2', IpcChannels.RESET_KEYBOARD_DATA, 'uid2'],
      ['RESET_LOCAL_TARGETS of favorites', IpcChannels.RESET_LOCAL_TARGETS, { keyboards: false, favorites: true, appSettings: false }],
    ])('%s runs', async (_name, channel, arg) => {
      expect((await getHandler(channel)(null, arg)).success).toBe(true)
    })
  })

  it('RESET_LOCAL_TARGETS clears the typing analytics of every local and cached keyboard before it cancels and removes them', async () => {
    const { rm } = await import('node:fs/promises')
    mockListLocalKeyboardUids.mockResolvedValueOnce(new Set(['uid1', 'uid2']))
    mockListTypingKeyboards.mockReturnValueOnce([{ uid: 'uid2' }, { uid: 'uid3' }])

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: false, appSettings: false })

    expect(result.success).toBe(true)
    expect(mockDeleteAllTypingForKeyboard.mock.calls.map(([uid]) => uid)).toEqual(['uid1', 'uid2', 'uid3'])
    const lastCleanup = mockDeleteAllTypingForKeyboard.mock.invocationCallOrder.at(-1) ?? Infinity
    expect(lastCleanup).toBeLessThan(mockCancelPendingChanges.mock.invocationCallOrder[0])
    expect(lastCleanup).toBeLessThan(vi.mocked(rm).mock.invocationCallOrder[0])
  })

  it('RESET_LOCAL_TARGETS without keyboards leaves the typing analytics alone', async () => {
    await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: true, appSettings: false })

    expect(mockDeleteAllTypingForKeyboard).not.toHaveBeenCalled()
  })

  it('RESET_LOCAL_TARGETS still removes the keyboards when a typing-analytics cleanup fails', async () => {
    const { rm } = await import('node:fs/promises')
    mockListLocalKeyboardUids.mockResolvedValueOnce(new Set(['uid1', 'uid2']))
    mockDeleteAllTypingForKeyboard.mockRejectedValueOnce(new Error('disk full'))
    mockListTypingKeyboards.mockImplementationOnce(() => {
      throw new Error('db closed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: false, appSettings: false })
    warn.mockRestore()

    expect(result.success).toBe(true)
    expect(mockDeleteAllTypingForKeyboard).toHaveBeenCalledTimes(2)
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('keyboards'), { recursive: true, force: true })
  })
})
