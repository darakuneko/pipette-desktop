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

const mockClearAppConfig = vi.fn()
vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  getAppConfigStore: vi.fn(() => ({ clear: mockClearAppConfig })),
  onAppConfigChange: vi.fn(),
}))

vi.mock('../sync-crypto', () => ({
  hasStoredPassword: vi.fn(),
  checkPasswordStrength: vi.fn(),
}))

const mockStartOAuthFlow = vi.fn(async (_switchTokens?: unknown): Promise<void> => {})
const mockGetAuthStatus = vi.fn(async (): Promise<unknown> => ({ authenticated: false }))
vi.mock('../google-auth', () => ({
  startOAuthFlow: (switchTokens?: unknown) => mockStartOAuthFlow(switchTokens),
  getAuthStatus: () => mockGetAuthStatus(),
}))

const mockDeleteFilesByPrefix = vi.fn(async (..._args: unknown[]) => ({ attempted: 0, failed: 0 }))
const mockListFiles = vi.fn(async (_options?: { nameContains?: string }): Promise<Array<{ id: string; name: string; modifiedTime: string }>> => [])
const mockDeleteFilesById = vi.fn(async (ids: readonly string[]): Promise<{ attempted: number; failed: number; firstError?: string }> => ({ attempted: ids.length, failed: 0 }))
vi.mock('../google-drive', async () => {
  // The real name parsers, which the trash index (drive-canonical.ts) uses.
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    deleteFilesByPrefix: (...args: unknown[]) => mockDeleteFilesByPrefix(...args),
    deleteFilesById: (ids: readonly string[]) => mockDeleteFilesById(ids),
    listFiles: (options?: { nameContains?: string }) => mockListFiles(options),
    driveFileName: actual.driveFileName,
    syncUnitFromFileName: actual.syncUnitFromFileName,
    isDataFileName: actual.isDataFileName,
  }
})

const mockListTrashFiles = vi.fn(async (): Promise<unknown[]> => [])
const mockTrashFileKeyboards = vi.fn(async (_ids: readonly string[]): Promise<string[]> => [])
const mockRestoreTrashFile = vi.fn(async (_fileId: string): Promise<void> => {})
const mockDeleteTrashFiles = vi.fn(async (ids: readonly string[]): Promise<unknown> => ({ deleted: [...ids], skipped: [] }))
vi.mock('../sync-trash-manual', () => ({
  listTrashFiles: () => mockListTrashFiles(),
  trashFileKeyboards: (ids: readonly string[]) => mockTrashFileKeyboards(ids),
  restoreTrashFile: (fileId: string) => mockRestoreTrashFile(fileId),
  deleteTrashFiles: (ids: readonly string[]) => mockDeleteTrashFiles(ids),
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
const mockRestorePendingFromDisk = vi.fn()
const mockAdoptPendingForSignedInAccount = vi.fn(async (): Promise<string | null> => null)
const mockSignOutKeepingPending = vi.fn(async (): Promise<void> => {})
const mockSignOutKeepingPendingLocked = vi.fn(async (): Promise<void> => {})
const mockSwitchAccountKeepingPending = vi.fn(async (storeTokens: () => Promise<void>, _newAccountSub: string | null): Promise<void> => storeTokens())
const { MockSyncBlockedError, MockAccountSwitchBusyError } = vi.hoisted(() => ({
  MockSyncBlockedError: class MockSyncBlockedError extends Error {
    readonly reason: string | undefined
    constructor(message: string, reason?: string) {
      super(message)
      this.reason = reason
    }
  },
  MockAccountSwitchBusyError: class MockAccountSwitchBusyError extends Error {
    readonly reason = 'syncBusy' as const
    constructor() {
      super('Cannot switch accounts while sync is in progress. Try again in a moment.')
    }
  },
}))
const mockDeleteDeviceTypingData = vi.fn(async (..._args: unknown[]): Promise<void> => {})
const mockGetCachedSyncFormatStatus = vi.fn((): unknown => null)
const mockRefreshSyncFormatStatus = vi.fn(async (): Promise<unknown> => null)
const mockSetSyncFormatStatusListener = vi.fn()
const mockBroadcastToAllWindows = vi.fn()
vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}))
// The reset lock runs for real on the real sync-runtime-state, so the tests
// below can hold the lock and register analytics writers themselves.
vi.mock('../sync-service', async () => ({
  withResetLock: (await vi.importActual<typeof import('../sync-reset-lock')>('../sync-reset-lock')).withResetLock,
  withResetLockWhenFree: (await vi.importActual<typeof import('../sync-reset-lock')>('../sync-reset-lock')).withResetLockWhenFree,
  DELETE_BUSY_MESSAGE: 'sync.deleteBusy',
  IMPORT_BUSY_MESSAGE: 'sync.importBusy',
  TRASH_BUSY_MESSAGE: 'sync.trashBusy',
  copyPendingState: (await vi.importActual<typeof import('../sync-runtime-state')>('../sync-runtime-state')).copyPendingState,
  restoreCancelledPending: (await vi.importActual<typeof import('../sync-runtime-state')>('../sync-runtime-state')).restoreCancelledPending,
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
  getCachedSyncFormatStatus: () => mockGetCachedSyncFormatStatus(),
  refreshSyncFormatStatus: () => mockRefreshSyncFormatStatus(),
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
  restorePendingFromDisk: () => mockRestorePendingFromDisk(),
  adoptPendingForSignedInAccount: () => mockAdoptPendingForSignedInAccount(),
  signOutKeepingPending: () => mockSignOutKeepingPending(),
  signOutKeepingPendingLocked: () => mockSignOutKeepingPendingLocked(),
  switchAccountKeepingPending: (storeTokens: () => Promise<void>, newAccountSub: string | null) => mockSwitchAccountKeepingPending(storeTokens, newAccountSub),
  getPasswordChangeStatus: vi.fn(),
  getPasswordChangeLockStatus: () => mockGetPasswordChangeLockStatus(),
  releasePasswordChangeLocks: () => mockReleasePasswordChangeLocks(),
  checkPasswordCheckExists: vi.fn(),
  setPasswordAndValidate: (password: string) => mockSetPasswordAndValidate(password),
  replacePasswordAndValidate: (password: string) => mockReplacePasswordAndValidate(password),
  deleteDeviceTypingData: (...args: unknown[]) => mockDeleteDeviceTypingData(...args),
  fetchRemoteTypingDay: vi.fn(),
  hasAnyRemoteTypingData: vi.fn(),
  listRemoteTypingDaysFor: vi.fn(),
  listRemoteTypingHashesForUidFromCloud: vi.fn(),
  listRemoteFileNames: vi.fn(),
  SyncCredentialError: class SyncCredentialError extends Error {},
  SyncBlockedError: MockSyncBlockedError,
  AccountSwitchBusyError: MockAccountSwitchBusyError,
  assertSyncAllowed: () => mockAssertSyncAllowed(),
  forgetChangeStateCache: () => mockForgetChangeStateCache(),
  assertNoLocalPasswordChange: () => mockAssertNoLocalPasswordChange(),
}))

const mockImportTypingDataFiles = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ imported: 0, rejections: [] }))
vi.mock('../../typing-analytics/import-export', () => ({
  exportTypingDataForKeyboard: vi.fn(),
  importTypingDataFiles: (...args: unknown[]) => mockImportTypingDataFiles(...args),
}))
vi.mock('../../typing-analytics/machine-hash', () => ({ getMachineHash: vi.fn() }))
vi.mock('../../typing-analytics/deleted-ranges-apply', () => ({
  prepareOwnDeletedRangesReapply: vi.fn(),
}))
vi.mock('../../typing-analytics/cache-rebuild', () => ({ ensureCacheIsFresh: vi.fn() }))
vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({ getTypingAnalyticsDB: vi.fn() }))
const mockDeleteAllTypingForKeyboard = vi.fn(async (_uid: string, _cutoffMs: number, _scope: 'own' | 'all'): Promise<void> => {})
const mockDeleteTypingDailySummaries = vi.fn(async (_uid: string, _dates: string[], _cutoffMs?: number): Promise<void> => {})
const mockListTypingKeyboards = vi.fn((): Array<{ uid: string }> => [])
vi.mock('../../typing-analytics/typing-analytics-service', () => ({
  deleteAllTypingForKeyboard: (...args: [string, number, 'own' | 'all']) => mockDeleteAllTypingForKeyboard(...args),
  deleteTypingDailySummaries: (...args: [string, string[], number?]) => mockDeleteTypingDailySummaries(...args),
  listTypingKeyboards: () => mockListTypingKeyboards(),
  runOnFlushChain: async (task: () => Promise<void>) => { await task() },
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
import { dialog, ipcMain } from 'electron'
import { onAppConfigChange } from '../../app-config'
import { IpcChannels } from '../../../shared/ipc/channels'
import { KEY_LABEL_SYNC_UNIT } from '../../key-label-store'
import { TYPING_TEST_TEXT_SYNC_UNIT } from '../../typing-test-text-store'
import { prepareOwnDeletedRangesReapply } from '../../typing-analytics/deleted-ranges-apply'

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
    expect(mockListFiles).not.toHaveBeenCalled()
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
    expect(mockCancelPendingChanges).toHaveBeenCalledWith(['keyboards/uid1/'], { writeAlways: true })
    expect(mockDeleteAllTypingForKeyboard).toHaveBeenCalledWith('uid1', expect.any(Number), 'all')
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
  })

  it('RESET_KEYBOARD_DATA resets locally but skips the remote delete when Drive needs a newer app', async () => {
    mockAssertSyncAllowed.mockRejectedValue(new MockSyncBlockedError('sync.updateRequired', 'updateRequired'))

    const result = await getHandler(IpcChannels.RESET_KEYBOARD_DATA)(null, 'uid1')

    expect(result.success).toBe(true)
    expect(mockCancelPendingChanges).toHaveBeenCalledWith(['keyboards/uid1/'], { writeAlways: true })
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

  it('SYNC_AUTH_START returns the busy refusal with its reason', async () => {
    mockSwitchAccountKeepingPending.mockRejectedValueOnce(new MockAccountSwitchBusyError())
    mockStartOAuthFlow.mockImplementationOnce(async (switchTokens) => {
      await (switchTokens as (store: () => Promise<void>, sub: string | null) => Promise<void>)(async () => {}, 'account-b')
    })

    const result = await getHandler(IpcChannels.SYNC_AUTH_START)(null)

    expect(result).toEqual({
      success: false,
      error: 'Cannot switch accounts while sync is in progress. Try again in a moment.',
      reason: 'syncBusy',
    })
    expect(mockStartPollingIfAutoSync).not.toHaveBeenCalled()
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

  it('RESET_LOCAL_TARGETS signs out, holding the pending changes, before it removes local/auth', async () => {
    const { rm } = await import('node:fs/promises')

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: false, appSettings: true })

    expect(result.success).toBe(true)
    const authRemoval = vi.mocked(rm).mock.calls.findIndex(([path]) => String(path).endsWith('auth'))
    expect(mockSignOutKeepingPendingLocked.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(rm).mock.invocationCallOrder[authRemoval])
    expect(mockSignOutKeepingPending).not.toHaveBeenCalled()
  })

  it('RESET_LOCAL_TARGETS signs out right after the cancel, and stops polling only then, before removing or clearing anything', async () => {
    const { rm } = await import('node:fs/promises')

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: true, appSettings: true })

    expect(result.success).toBe(true)
    const signOut = mockSignOutKeepingPendingLocked.mock.invocationCallOrder[0]
    expect(mockCancelPendingChanges.mock.invocationCallOrder[0]).toBeLessThan(signOut)
    expect(signOut).toBeLessThan(mockStopPolling.mock.invocationCallOrder[0])
    expect(signOut).toBeLessThan(Math.min(...vi.mocked(rm).mock.invocationCallOrder))
    expect(signOut).toBeLessThan(mockClearAppConfig.mock.invocationCallOrder[0])
    expect(signOut).toBeLessThan(mockDeleteAllTypingForKeyboard.mock.invocationCallOrder[0] ?? Infinity)
  })

  it('RESET_LOCAL_TARGETS removes nothing and keeps polling when the sign-out fails', async () => {
    const { rm } = await import('node:fs/promises')
    mockSignOutKeepingPendingLocked.mockRejectedValueOnce(new Error('EACCES: sync-pending.json'))

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: true, appSettings: true })

    expect(result).toEqual({ success: false, error: 'EACCES: sync-pending.json' })
    expect(rm).not.toHaveBeenCalled()
    expect(mockClearAppConfig).not.toHaveBeenCalled()
    expect(mockStopPolling).not.toHaveBeenCalled()
    expect(mockDeleteAllTypingForKeyboard).not.toHaveBeenCalled()
    expect(mockForgetChangeStateCache).not.toHaveBeenCalled()
    expect(mockCancelPendingChanges).toHaveBeenCalledTimes(1)
  })

  it('RESET_LOCAL_TARGETS puts back the pending units its cancel removed when the sign-out fails', async () => {
    const actual = await vi.importActual<typeof import('../sync-runtime-state')>('../sync-runtime-state')
    resetSyncRuntimeForTests()
    syncRuntime.pendingOwner = 'account-a'
    actual.markPending('favorites/tapDance')
    actual.markPending('keyboards/uid1/settings')
    actual.markPending('i18n/index')
    syncRuntime.heldPending.set('account-b', new Set(['favorites/macro', 'keyboards/uid2/settings', 'themes/index']))
    const pendingState = (): unknown => ({
      owner: syncRuntime.pendingOwner,
      generations: [...syncRuntime.pendingGeneration].sort(),
      active: [...syncRuntime.pendingChanges].sort(),
      held: [...syncRuntime.heldPending].map(([sub, units]) => [sub, [...units].sort()]),
    })
    const before = pendingState()
    mockCancelPendingChanges.mockImplementationOnce((prefixes?: readonly string[], options?: { writeAlways?: boolean }) =>
      actual.cancelPendingChanges(prefixes, options))
    let activeAtSignOut: string[] = []
    mockSignOutKeepingPendingLocked.mockImplementationOnce(async () => {
      activeAtSignOut = [...syncRuntime.pendingChanges]
      throw new Error('EACCES: sync-pending.json')
    })

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: true, appSettings: true })

    expect(result).toEqual({ success: false, error: 'EACCES: sync-pending.json' })
    expect(activeAtSignOut).toEqual(['i18n/index'])
    expect(pendingState()).toEqual(before)
    resetSyncRuntimeForTests()
  })

  it('RESET_LOCAL_TARGETS keeps a unit saved during the failing sign-out when it puts the cancelled units back', async () => {
    const actual = await vi.importActual<typeof import('../sync-runtime-state')>('../sync-runtime-state')
    resetSyncRuntimeForTests()
    syncRuntime.pendingOwner = 'account-a'
    actual.markPending('favorites/tapDance')
    actual.markPending('favorites/macro')
    const tapDanceGeneration = actual.pendingGenerationOf('favorites/tapDance')
    mockCancelPendingChanges.mockImplementationOnce((prefixes?: readonly string[], options?: { writeAlways?: boolean }) =>
      actual.cancelPendingChanges(prefixes, options))
    let savedGeneration = 0
    mockSignOutKeepingPendingLocked.mockImplementationOnce(async () => {
      // A local save while the sign-out awaits.
      actual.markPending('favorites/macro')
      actual.markPending('favorites/combo')
      savedGeneration = actual.pendingGenerationOf('favorites/macro')
      throw new Error('EACCES: sync-pending.json')
    })

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: true, appSettings: true })

    expect(result.success).toBe(false)
    expect([...syncRuntime.pendingChanges].sort()).toEqual(['favorites/combo', 'favorites/macro', 'favorites/tapDance'])
    expect(actual.pendingGenerationOf('favorites/macro')).toBe(savedGeneration)
    expect(actual.pendingGenerationOf('favorites/tapDance')).toBe(tapDanceGeneration)
    resetSyncRuntimeForTests()
  })

  it('RESET_LOCAL_TARGETS without app settings stays signed in', async () => {
    await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: true, appSettings: false })

    expect(mockSignOutKeepingPendingLocked).not.toHaveBeenCalled()
  })

  it('RESET_LOCAL_TARGETS cancels the pending changes of every target in one call', async () => {
    await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: false, favorites: true, appSettings: false, themePacks: true })

    expect(mockCancelPendingChanges).toHaveBeenCalledTimes(1)
    expect(mockCancelPendingChanges).toHaveBeenCalledWith(['favorites/', TYPING_TEST_TEXT_SYNC_UNIT, KEY_LABEL_SYNC_UNIT, 'themes/'], { writeAlways: true })
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
    // Setup schedules a flush for the restored changes.
    mockScheduleFlushIfPending.mockClear()
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

  it('SYNC_AUTH_SIGN_OUT signs out holding the pending changes, then stops polling', async () => {
    const result = await getHandler(IpcChannels.SYNC_AUTH_SIGN_OUT)(null)

    expect(result).toEqual({ success: true })
    expect(mockSignOutKeepingPending).toHaveBeenCalledTimes(1)
    expect(mockSignOutKeepingPending.mock.invocationCallOrder[0])
      .toBeLessThan(mockStopPolling.mock.invocationCallOrder[0])
  })

  it('SYNC_AUTH_SIGN_OUT keeps polling when the sign-out fails', async () => {
    mockSignOutKeepingPending.mockRejectedValueOnce(new Error('EACCES: sync-pending.json'))

    const result = await getHandler(IpcChannels.SYNC_AUTH_SIGN_OUT)(null)

    expect(result).toEqual({ success: false, error: 'EACCES: sync-pending.json' })
    expect(mockStopPolling).not.toHaveBeenCalled()
  })

  it('SYNC_AUTH_START stores the new tokens through the pending account switch, then schedules a flush', async () => {
    const result = await getHandler(IpcChannels.SYNC_AUTH_START)(null)

    expect(result).toEqual({ success: true })
    expect(mockStartOAuthFlow).toHaveBeenCalledWith(expect.any(Function))
    const switchTokens = mockStartOAuthFlow.mock.calls[0][0] as (store: () => Promise<void>, sub: string | null) => Promise<void>
    const store = vi.fn(async () => {})
    await switchTokens(store, 'account-b')
    expect(mockSwitchAccountKeepingPending).toHaveBeenCalledWith(store, 'account-b')
    expect(mockScheduleFlushIfPending).toHaveBeenCalledTimes(1)
  })
})

describe('sync-ipc restoring the pending changes at startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restores them before registering any handler, then schedules a flush', () => {
    setupSyncIpc()

    expect(mockRestorePendingFromDisk.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ipcMain.handle).mock.invocationCallOrder[0])
    expect(mockRestorePendingFromDisk.mock.invocationCallOrder[0])
      .toBeLessThan(mockScheduleFlushIfPending.mock.invocationCallOrder[0])
  })

  it('hands the restored changes to the stored sign-in once', () => {
    setupSyncIpc()

    expect(mockAdoptPendingForSignedInAccount).toHaveBeenCalledTimes(1)
    expect(mockRestorePendingFromDisk.mock.invocationCallOrder[0])
      .toBeLessThan(mockAdoptPendingForSignedInAccount.mock.invocationCallOrder[0])
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
    expect(mockListFiles).toHaveBeenCalledWith({ nameContains: `${KEY_LABEL_SYNC_UNIT}.enc` })
    expect(mockCancelPendingChanges).toHaveBeenCalledWith([KEY_LABEL_SYNC_UNIT], { writeAlways: true })
  })

  it('deletes every copy of the exact name and its trash files, and nothing else', async () => {
    mockListFiles.mockResolvedValueOnce([
      { id: 'a', name: 'key-labels.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      { id: 'b', name: 'key-labels.enc', modifiedTime: '2025-01-02T00:00:00.000Z' },
      { id: 't', name: 'key-labels.enc.trash.100.50.t', modifiedTime: 'm' },
      // The id in the name is another file's: not a trash file.
      { id: 'forged', name: 'key-labels.enc.trash.100.50.t', modifiedTime: 'm' },
      { id: 'longer', name: 'key-labels.enc.bak', modifiedTime: 'm' },
    ])

    const result = await getResetTargetsHandler()(null, { keyboards: false, favorites: false, keyLabels: true })

    expect(result.success).toBe(true)
    expect([...mockDeleteFilesById.mock.calls[0][0]].sort()).toEqual(['a', 'b', 't'])
  })

  it('deletes the exact typing-test-texts remote file and cancels its pending changes', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, typingTestTexts: true })

    expect(result.success).toBe(true)
    expect(mockListFiles).toHaveBeenCalledWith({ nameContains: `${TYPING_TEST_TEXT_SYNC_UNIT}.enc` })
    expect(mockCancelPendingChanges).toHaveBeenCalledWith([TYPING_TEST_TEXT_SYNC_UNIT], { writeAlways: true })
  })

  it.each([
    ['SYNC_RESET_TARGETS', IpcChannels.SYNC_RESET_TARGETS, { keyboards: ['uid1'], favorites: false }],
    ['RESET_KEYBOARD_DATA', IpcChannels.RESET_KEYBOARD_DATA, 'uid1'],
    ['RESET_LOCAL_TARGETS', IpcChannels.RESET_LOCAL_TARGETS, { keyboards: true, favorites: false, appSettings: false }],
  ])('%s deletes nothing and releases the lock when the cancelled pending state cannot be written', async (_name, channel, arg) => {
    const { rm } = await import('node:fs/promises')
    mockCancelPendingChanges.mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })

    const result = await getHandler(channel)(null, arg)

    expect(result).toEqual({ success: false, error: 'ENOSPC' })
    expect(mockDeleteFilesByPrefix).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
    expect(syncRuntime.isSyncing).toBe(false)
  })

  it('rejects a non-boolean keyLabels target', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: 'yes' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/keyLabels must be boolean/)
    expect(mockListFiles).not.toHaveBeenCalled()
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

    expect(result).toEqual({ success: false, error: 'sync.resetBusy' })
    expect(mockListFiles).not.toHaveBeenCalled()
  })

  it('handles both keyLabels and typingTestTexts selected together', async () => {
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true, typingTestTexts: true })

    expect(result.success).toBe(true)
    expect(mockListFiles).toHaveBeenCalledWith({ nameContains: `${KEY_LABEL_SYNC_UNIT}.enc` })
    expect(mockListFiles).toHaveBeenCalledWith({ nameContains: `${TYPING_TEST_TEXT_SYNC_UNIT}.enc` })
  })

  // A rejected Drive delete must surface as a reset failure with a
  // unit-name-only message — not be silently discarded by the
  // underlying Promise.allSettled inside deleteMatchingFiles.
  it('reports failure with a unit-name-only message when a delete batch had a rejection', async () => {
    mockDeleteFilesById.mockResolvedValueOnce({ attempted: 1, failed: 1 })
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/keyLabels/)
    // Unit-name-only: no raw filename/content in the surfaced message.
    expect(result.error).not.toMatch(/\.enc/)
  })

  it('still attempts every requested target even when an earlier one failed', async () => {
    mockDeleteFilesById.mockResolvedValueOnce({ attempted: 1, failed: 1 })
    const handler = getResetTargetsHandler()

    const result = await handler(null, { keyboards: false, favorites: false, keyLabels: true, typingTestTexts: true })

    expect(result.success).toBe(false)
    expect(mockListFiles).toHaveBeenCalledWith({ nameContains: `${KEY_LABEL_SYNC_UNIT}.enc` })
    expect(mockListFiles).toHaveBeenCalledWith({ nameContains: `${TYPING_TEST_TEXT_SYNC_UNIT}.enc` })
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

    it('a successful sign-in checks Drive again', async () => {
      const result = await getHandler(IpcChannels.SYNC_AUTH_START)(null)

      expect(result).toEqual({ success: true })
      expect(mockRefreshSyncFormatStatus).toHaveBeenCalledTimes(1)
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

  const busy = 'sync.resetBusy'
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
    ['SYNC_DELETE_FILES', IpcChannels.SYNC_DELETE_FILES, ['id-1'], 'sync.deleteBusy',
      (gate) => mockAssertSyncAllowed.mockImplementationOnce(() => gate.promise)],
    ['SYNC_RESTORE_TRASH', IpcChannels.SYNC_RESTORE_TRASH, 'trash-1', 'sync.trashBusy',
      (gate) => mockRestoreTrashFile.mockImplementationOnce(() => gate.promise)],
    ['SYNC_DELETE_TRASH', IpcChannels.SYNC_DELETE_TRASH, ['trash-1'], 'sync.trashBusy',
      (gate) => mockDeleteTrashFiles.mockImplementationOnce(async (ids) => {
        await gate.promise
        return { deleted: [...ids], skipped: [] }
      })],
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
    // The trash handlers look up their files' keyboards before taking the lock.
    await vi.waitFor(() => expect(syncRuntime.isSyncing).toBe(true))
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

  it('the trash actions are refused while a sync holds the lock, without touching Drive', async () => {
    const releaseLock = claimSyncLock()

    const restore = await getHandler(IpcChannels.SYNC_RESTORE_TRASH)(null, 'trash-1')
    const remove = await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, ['trash-1'])
    releaseLock()

    expect(restore).toEqual({ success: false, error: 'sync.trashBusy' })
    expect(remove).toEqual({ success: false, error: 'sync.trashBusy' })
    expect(mockRestoreTrashFile).not.toHaveBeenCalled()
    expect(mockDeleteTrashFiles).not.toHaveBeenCalled()
  })

  it('the trash actions lock the keyboards their files belong to', async () => {
    mockTrashFileKeyboards.mockResolvedValue(['uid1'])
    syncRuntime.analyticsSyncingUids.add('uid1')

    const restore = await getHandler(IpcChannels.SYNC_RESTORE_TRASH)(null, 'trash-1')
    const remove = await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, ['trash-1'])

    expect(restore).toEqual({ success: false, error: 'sync.trashBusy' })
    expect(remove).toEqual({ success: false, error: 'sync.trashBusy' })
    expect(mockRestoreTrashFile).not.toHaveBeenCalled()
    expect(mockDeleteTrashFiles).not.toHaveBeenCalled()
    expect(mockTrashFileKeyboards).toHaveBeenCalledWith(['trash-1'])

    let held: unknown = null
    mockRestoreTrashFile.mockImplementationOnce(async () => {
      held = syncRuntime.resetKeyboards
    })
    syncRuntime.analyticsSyncingUids.clear()
    expect((await getHandler(IpcChannels.SYNC_RESTORE_TRASH)(null, 'trash-1')).success).toBe(true)
    expect(held).toEqual(new Set(['uid1']))
    mockTrashFileKeyboards.mockResolvedValue([])
  })

  it('the trash actions on global units are not held up by a keyboard\'s analytics sync', async () => {
    syncRuntime.analyticsSyncingUids.add('uid1')

    expect((await getHandler(IpcChannels.SYNC_RESTORE_TRASH)(null, 'trash-1')).success).toBe(true)
    expect((await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, ['trash-1'])).success).toBe(true)
    syncRuntime.analyticsSyncingUids.clear()
  })

  it('the trash actions release the lock and return the refusal when they throw', async () => {
    mockRestoreTrashFile.mockRejectedValueOnce(new MockSyncBlockedError('sync.updateRequired', 'updateRequired'))
    mockDeleteTrashFiles.mockRejectedValueOnce(new Error('sync.trash.notFound'))

    expect(await getHandler(IpcChannels.SYNC_RESTORE_TRASH)(null, 'trash-1')).toEqual({ success: false, error: 'sync.updateRequired' })
    expect(await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, ['trash-1'])).toEqual({ success: false, error: 'sync.trash.notFound' })
    expect(syncRuntime.isSyncing).toBe(false)
  })

  it('the trash handlers pass results through and validate their arguments', async () => {
    mockListTrashFiles.mockResolvedValueOnce([{ fileId: 't' }])
    mockDeleteTrashFiles.mockResolvedValueOnce({ deleted: [], skipped: ['t'] })

    expect(await getHandler(IpcChannels.SYNC_LIST_TRASH)(null)).toEqual({ success: true, files: [{ fileId: 't' }] })
    expect(await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, ['t'])).toEqual({ success: true, deleted: [], skipped: ['t'] })
    expect(await getHandler(IpcChannels.SYNC_RESTORE_TRASH)(null, 42)).toEqual({ success: false, error: 'Invalid file ID' })
    expect(await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, [])).toEqual({ success: false, error: 'No files specified' })
    expect(await getHandler(IpcChannels.SYNC_DELETE_TRASH)(null, [1])).toEqual({ success: false, error: 'Invalid file ID' })
    expect(mockRestoreTrashFile).not.toHaveBeenCalled()
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

  it('RESET_LOCAL_TARGETS cancels, clears the typing analytics of every local and cached keyboard, cancels again, then removes them', async () => {
    const { rm } = await import('node:fs/promises')
    mockListLocalKeyboardUids.mockResolvedValueOnce(new Set(['uid1', 'uid2']))
    mockListTypingKeyboards.mockReturnValueOnce([{ uid: 'uid2' }, { uid: 'uid3' }])

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: false, appSettings: false })

    expect(result.success).toBe(true)
    expect(mockDeleteAllTypingForKeyboard.mock.calls.map(([uid, , scope]) => [uid, scope])).toEqual([['uid1', 'all'], ['uid2', 'all'], ['uid3', 'all']])
    const firstCleanup = mockDeleteAllTypingForKeyboard.mock.invocationCallOrder[0]
    const lastCleanup = mockDeleteAllTypingForKeyboard.mock.invocationCallOrder.at(-1) ?? Infinity
    const [firstCancel, secondCancel] = mockCancelPendingChanges.mock.invocationCallOrder
    expect(mockCancelPendingChanges.mock.calls).toEqual([[['keyboards/'], { writeAlways: true }], [['keyboards/']]])
    expect(firstCancel).toBeLessThan(firstCleanup)
    expect(lastCleanup).toBeLessThan(secondCancel)
    expect(secondCancel).toBeLessThan(vi.mocked(rm).mock.invocationCallOrder[0])
  })

  it('RESET_LOCAL_TARGETS leaves the typing analytics alone when the cancel cannot be written', async () => {
    mockCancelPendingChanges.mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })

    const result = await getHandler(IpcChannels.RESET_LOCAL_TARGETS)(null, { keyboards: true, favorites: false, appSettings: false })

    expect(result).toEqual({ success: false, error: 'ENOSPC' })
    expect(mockDeleteAllTypingForKeyboard).not.toHaveBeenCalled()
  })

  it('RESET_KEYBOARD_DATA cancels before and after the typing-analytics cleanup, and keeps the analytics when the cancel cannot be written', async () => {
    const handler = getHandler(IpcChannels.RESET_KEYBOARD_DATA)
    expect((await handler(null, 'uid1')).success).toBe(true)
    const [firstCancel, secondCancel] = mockCancelPendingChanges.mock.invocationCallOrder
    const cleanup = mockDeleteAllTypingForKeyboard.mock.invocationCallOrder[0]
    expect(firstCancel).toBeLessThan(cleanup)
    expect(cleanup).toBeLessThan(secondCancel)

    mockDeleteAllTypingForKeyboard.mockClear()
    mockCancelPendingChanges.mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })
    const result = await handler(null, 'uid1')

    expect(result.success).toBe(false)
    expect(mockDeleteAllTypingForKeyboard).not.toHaveBeenCalled()
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

describe('sync-ipc typing-data deletes and import wait for the sync lock', () => {
  async function turns(count = 5): Promise<void> {
    for (let i = 0; i < count; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  // Each delete handler, its arguments, and the delete it runs.
  const deletes: Array<[string, string, unknown[], ReturnType<typeof vi.fn>]> = [
    ['TYPING_ANALYTICS_DELETE_ITEMS', IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS, ['uid1', ['2026-10-01']], mockDeleteTypingDailySummaries],
    ['TYPING_ANALYTICS_DELETE_ALL', IpcChannels.TYPING_ANALYTICS_DELETE_ALL, ['uid1'], mockDeleteAllTypingForKeyboard],
    ['TYPING_ANALYTICS_DELETE_DEVICE_DATA', IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA, ['uid1', 'hash1', ['2026-10-01', '2026-10-02']], mockDeleteDeviceTypingData],
    ['TYPING_ANALYTICS_DELETE_DEVICE_DATA (all)', IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA, ['uid1', 'hash1', 'all'], mockDeleteDeviceTypingData],
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    resetSyncRuntimeForTests()
    setupSyncIpc()
  })

  it.each(deletes)('%s waits for a pass holding the lock, then deletes holding it for its keyboard', async (_name, channel, args, remove) => {
    remove.mockImplementationOnce(async () => {
      expect(syncRuntime.isSyncing).toBe(true)
      expect(syncRuntime.resetKeyboards).toEqual(new Set(['uid1']))
    })
    const releasePoll = claimSyncLock({ waitable: true })

    const result = getHandler(channel)(null, ...args)
    await turns()
    expect(remove).not.toHaveBeenCalled()
    releasePoll()

    expect(await result).toEqual({ success: true })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0].slice(0, args.length)).toEqual(args)
    expect(syncRuntime.isSyncing).toBe(false)
    expect(syncRuntime.resetKeyboards).toBeNull()
  })

  it.each(deletes)('%s returns the delete busy key when the lock is still held after the wait', async (_name, channel, args, remove) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const release = claimSyncLock()
      const result = getHandler(channel)(null, ...args)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(await result).toEqual({ success: false, error: 'sync.deleteBusy' })
      expect(remove).not.toHaveBeenCalled()
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TYPING_ANALYTICS_DELETE_DEVICE_DATA passes the time the call came in as the cutoff', async () => {
    const before = Date.now()
    expect(await getHandler(IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA)(null, 'uid1', 'hash1', 'all')).toEqual({ success: true })
    const cutoff = mockDeleteDeviceTypingData.mock.calls[0][3] as number
    expect(cutoff).toBeGreaterThanOrEqual(before)
    expect(cutoff).toBeLessThanOrEqual(Date.now())
  })

  it('TYPING_ANALYTICS_DELETE_DEVICE_DATA does nothing for no dates', async () => {
    expect(await getHandler(IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA)(null, 'uid1', 'hash1', [])).toEqual({ success: true })
    expect(mockDeleteDeviceTypingData).not.toHaveBeenCalled()
  })

  it('TYPING_ANALYTICS_DELETE_ALL removes only this device\'s rows', async () => {
    expect(await getHandler(IpcChannels.TYPING_ANALYTICS_DELETE_ALL)(null, 'uid1')).toEqual({ success: true })
    expect(mockDeleteAllTypingForKeyboard).toHaveBeenCalledWith('uid1', expect.any(Number), 'own')
  })

  it.each(deletes)('%s releases the lock when the delete throws', async (_name, channel, args, remove) => {
    remove.mockRejectedValueOnce(new Error('EBUSY'))

    expect(await getHandler(channel)(null, ...args)).toEqual({ success: false, error: 'EBUSY' })
    expect(syncRuntime.isSyncing).toBe(false)
    expect(syncRuntime.resetKeyboards).toBeNull()
  })

  it.each([
    ['an invalid uid', IpcChannels.TYPING_ANALYTICS_DELETE_ALL, ['../x'], 'Invalid uid'],
    ['an invalid date', IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS, ['uid1', ['2026-10-01', 'x']], 'Invalid dates'],
    ['an invalid device', IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA, ['uid1', '../h', ['2026-10-01']], 'Invalid device'],
    ['an invalid device date', IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA, ['uid1', 'hash1', ['2026-02-30']], 'Invalid dates'],
    ['a device target that is neither dates nor all', IpcChannels.TYPING_ANALYTICS_DELETE_DEVICE_DATA, ['uid1', 'hash1', 'everything'], 'Invalid dates'],
  ])('refuses %s before taking the lock', async (_name, channel, args, error) => {
    const release = claimSyncLock()

    expect(await getHandler(channel)(null, ...args)).toEqual({ success: false, error })
    release()
    expect(mockDeleteAllTypingForKeyboard).not.toHaveBeenCalled()
    expect(mockDeleteTypingDailySummaries).not.toHaveBeenCalled()
    expect(mockDeleteDeviceTypingData).not.toHaveBeenCalled()
  })

  it('TYPING_ANALYTICS_IMPORT shows the file dialog without the lock and imports holding it for every keyboard', async () => {
    vi.mocked(dialog.showOpenDialog).mockImplementationOnce(async () => {
      expect(syncRuntime.isSyncing).toBe(false)
      return { canceled: false, filePaths: ['/tmp/day.jsonl'] }
    })
    mockImportTypingDataFiles.mockImplementationOnce(async () => {
      expect(syncRuntime.isSyncing).toBe(true)
      expect(syncRuntime.resetKeyboards).toBe('all')
      return { imported: 0, rejections: [] }
    })

    const result = await getHandler(IpcChannels.TYPING_ANALYTICS_IMPORT)(null)

    expect(result).toEqual({ success: true, result: { imported: 0, rejections: [] }, cancelled: false })
    expect(mockImportTypingDataFiles).toHaveBeenCalledTimes(1)
    expect(mockImportTypingDataFiles.mock.calls[0][2]).toMatchObject({ runExclusive: expect.any(Function) })
    expect(syncRuntime.isSyncing).toBe(false)
  })

  it('TYPING_ANALYTICS_IMPORT has each replaced file marked again with this device\'s deleted ranges', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/day.jsonl'] })

    await getHandler(IpcChannels.TYPING_ANALYTICS_IMPORT)(null)

    expect(mockImportTypingDataFiles.mock.calls[0][2]).toMatchObject({ prepareReplace: prepareOwnDeletedRangesReapply })
  })

  it('TYPING_ANALYTICS_IMPORT returns the import busy key when the lock is still held after the wait', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/day.jsonl'] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const release = claimSyncLock()
      const result = getHandler(IpcChannels.TYPING_ANALYTICS_IMPORT)(null)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(await result).toEqual({ success: false, error: 'sync.importBusy' })
      expect(mockImportTypingDataFiles).not.toHaveBeenCalled()
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TYPING_ANALYTICS_IMPORT reports a cancelled dialog without taking the lock', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const release = claimSyncLock()

    const result = await getHandler(IpcChannels.TYPING_ANALYTICS_IMPORT)(null)
    release()

    expect(result).toEqual({ success: true, result: { imported: 0, rejections: [] }, cancelled: true })
    expect(mockImportTypingDataFiles).not.toHaveBeenCalled()
  })

  it.each([
    ['TYPING_ANALYTICS_DELETE_ITEMS', IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS, ['uid1', ['2026-10-01']], mockDeleteTypingDailySummaries],
    ['TYPING_ANALYTICS_DELETE_ALL', IpcChannels.TYPING_ANALYTICS_DELETE_ALL, ['uid1'], mockDeleteAllTypingForKeyboard],
  ])('%s passes the time the handler was called as the cutoff, not the time it got the lock', async (_name, channel, args, remove) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      vi.setSystemTime(1_000_000)
      const releasePoll = claimSyncLock({ waitable: true })
      const result = getHandler(channel)(null, ...args)
      await vi.advanceTimersByTimeAsync(5_000)
      releasePoll()

      expect(await result).toEqual({ success: true })
      expect(remove.mock.calls[0][args.length]).toBe(1_000_000)
    } finally {
      vi.useRealTimers()
    }
  })
})
