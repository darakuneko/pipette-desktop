// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused coverage for the SYNC_RESET_TARGETS handler's keyLabels /
// typingTestTexts cases (Task-sync-remote-reset-and-discovery-gaps §A).
// sync-ipc.ts pulls in most of the main process's sync/typing-analytics
// surface, so every dependency is stubbed to a bare vi.fn() — this file
// intentionally does not attempt broader sync-ipc coverage.

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
  resetPasswordCheckCache: vi.fn(),
  listUndecryptableFiles: vi.fn(),
  scanRemoteData: vi.fn(),
  fetchRemoteBundle: vi.fn(),
  changePassword: vi.fn(),
  checkPasswordCheckExists: vi.fn(),
  setPasswordAndValidate: vi.fn(),
  deleteRemoteTypingDay: vi.fn(),
  fetchRemoteTypingDay: vi.fn(),
  hasAnyRemoteTypingData: vi.fn(),
  listRemoteTypingDaysFor: vi.fn(),
  listRemoteTypingHashesForUidFromCloud: vi.fn(),
  listRemoteFileNames: vi.fn(),
  SyncCredentialError: class SyncCredentialError extends Error {},
}))

vi.mock('../../typing-analytics/import-export', () => ({
  exportTypingDataForKeyboard: vi.fn(),
  importTypingDataFiles: vi.fn(),
}))
vi.mock('../../typing-analytics/machine-hash', () => ({ getMachineHash: vi.fn() }))
vi.mock('../../typing-analytics/cache-rebuild', () => ({ ensureCacheIsFresh: vi.fn() }))
vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({ getTypingAnalyticsDB: vi.fn() }))
vi.mock('../../typing-analytics/typing-analytics-service', () => ({ deleteAllTypingForKeyboard: vi.fn() }))

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

describe('sync-ipc SYNC_RESET_TARGETS — keyLabels / typingTestTexts (Task §A)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsSyncInProgress.mockReturnValue(false)
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

  // C1: a rejected Drive delete must surface as a reset failure with a
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
