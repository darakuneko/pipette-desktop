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

vi.mock('../google-auth', () => ({
  startOAuthFlow: vi.fn(),
  getAuthStatus: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('../../hub/hub-ipc', () => ({
  clearHubTokenCache: vi.fn(),
}))

const mockDeleteFilesByPrefix = vi.fn(async (..._args: unknown[]) => ({ attempted: 0, failed: 0 }))
const mockDeleteFilesByExactName = vi.fn(async (..._args: unknown[]) => ({ attempted: 0, failed: 0 }))
const mockDeleteFile = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../google-drive', () => ({
  deleteFilesByPrefix: (...args: unknown[]) => mockDeleteFilesByPrefix(...args),
  deleteFilesByExactName: (...args: unknown[]) => mockDeleteFilesByExactName(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  driveFileName: (syncUnit: string) => `${syncUnit.replaceAll('/', '_')}.enc`,
}))

const mockCancelPendingChanges = vi.fn()
const mockIsSyncInProgress = vi.fn(() => false)
const mockAssertSyncAllowed = vi.fn(async () => {})
const mockForgetChangeStateCache = vi.fn()
const mockAssertNoLocalPasswordChange = vi.fn(async () => {})
const mockGetPasswordChangeLockStatus = vi.fn(async (): Promise<unknown> => null)
const mockReleasePasswordChangeLocks = vi.fn(async (): Promise<void> => {})
const mockReplacePasswordAndValidate = vi.fn(async (_password: string): Promise<void> => {})
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
vi.mock('../sync-service', () => ({
  executeAnalyticsSync: vi.fn(),
  executeSync: vi.fn(),
  hasPendingChanges: vi.fn(),
  cancelPendingChanges: (...args: unknown[]) => mockCancelPendingChanges(...args),
  isSyncInProgress: () => mockIsSyncInProgress(),
  notifyChange: vi.fn(),
  setProgressCallback: vi.fn(),
  setupBeforeQuitHandler: vi.fn(),
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  collectAllSyncUnits: vi.fn(async () => []),
  bundleSyncUnit: vi.fn(),
  readIndexFile: vi.fn(),
  resetPasswordCheckCache: () => mockResetPasswordCheckCache(),
  forgetCreatedSyncFormatMarker: () => mockForgetCreatedSyncFormatMarker(),
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
  setPasswordAndValidate: vi.fn(),
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
vi.mock('../../typing-analytics/typing-analytics-service', () => ({ deleteAllTypingForKeyboard: vi.fn(async () => {}) }))

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
import { ipcMain } from 'electron'
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
    mockIsSyncInProgress.mockReturnValue(false)
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
    expect(mockDeleteFile).not.toHaveBeenCalled()
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
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })

  it('SYNC_AUTH_SIGN_OUT forgets the created sync-format marker with the password-check cache', async () => {
    const result = await getHandler(IpcChannels.SYNC_AUTH_SIGN_OUT)(null)

    expect(result).toEqual({ success: true })
    expect(mockResetPasswordCheckCache).toHaveBeenCalledTimes(1)
    expect(mockForgetCreatedSyncFormatMarker).toHaveBeenCalledTimes(1)
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

describe('sync-ipc SYNC_RESET_TARGETS — keyLabels / typingTestTexts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsSyncInProgress.mockReturnValue(false)
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
    mockIsSyncInProgress.mockReturnValue(true)
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true })

    expect(result.success).toBe(false)
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
