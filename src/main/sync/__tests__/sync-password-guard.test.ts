// SPDX-License-Identifier: GPL-2.0-or-later
//
// Every sync entry point stops while a sync password change is in
// progress (a Drive lock from another PC, or a local change state), and
// the password-check is validated again whenever its Drive modifiedTime
// changes. In-memory Drive, real AES-GCM envelopes, real local state files
// in a temp dir; merging and bundling are spies.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DriveFile, ListFilesOptions, UploadedFile } from '../google-drive'
import type { SyncEnvelope, SyncProgress } from '../../../shared/types/sync'

const userDataRef = vi.hoisted(() => ({ dir: '' }))
const appEvents = vi.hoisted(() => ({ handlers: new Map<string, (e: { preventDefault: () => void }) => void>() }))
const mockQuit = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const str = b.toString()
      if (str.startsWith('enc:')) return str.slice(4)
      throw new Error('decrypt failed')
    }),
  },
  app: {
    getPath: () => userDataRef.dir,
    on: (event: string, handler: (e: { preventDefault: () => void }) => void) => {
      appEvents.handlers.set(event, handler)
    },
    quit: mockQuit,
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

// One PBKDF2 iteration instead of 600,000 keeps the real AES-GCM envelope
// code under test while the suite stays fast.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  const pbkdf2 = (
    password: string,
    salt: Buffer,
    _iterations: number,
    keylen: number,
    digest: string,
    callback: (err: Error | null, key: Buffer) => void,
  ): void => actual.pbkdf2(password, salt, 1, keylen, digest, callback)
  return { ...actual, default: { ...actual, pbkdf2 }, pbkdf2 }
})

vi.mock('../../logger', () => ({ log: vi.fn() }))

vi.mock('../google-auth', () => ({
  getAuthStatus: vi.fn(async () => ({ authenticated: true })),
  getAccessToken: vi.fn(async () => 'token'),
}))

vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'hashown'),
}))

vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(async () => ({ autoSync: true })),
}))

const mocks = vi.hoisted(() => ({
  mergeWithRemote: vi.fn(async (..._args: unknown[]) => {}),
  syncOrUpload: vi.fn(async (..._args: unknown[]) => {}),
  mergeDeviceDayBundle: vi.fn(async (..._args: unknown[]) => {}),
  collectAllSyncUnits: vi.fn(async () => ['favorites/tapDance']),
  collectAnalyticsSyncUnitsForUid: vi.fn(async (uid: string) => [`keyboards/${uid}/devices/hashown/days/2026-10-01`]),
}))

vi.mock('../sync-merge-dispatch', () => ({
  mergeWithRemote: mocks.mergeWithRemote,
  syncOrUpload: mocks.syncOrUpload,
  mergeDeviceDayBundle: mocks.mergeDeviceDayBundle,
}))

vi.mock('../sync-bundle', () => ({
  isAnalyticsSyncUnit: (unit: string) => /^keyboards\/[^/]+\/devices\//.test(unit),
  isRunLogSyncUnit: (unit: string) => /^keyboards\/[^/]+\/runs$/.test(unit),
  collectAllSyncUnits: mocks.collectAllSyncUnits,
  collectAnalyticsSyncUnitsForUid: mocks.collectAnalyticsSyncUnitsForUid,
}))

vi.mock('../keyboard-meta', () => ({
  backfillKeyboardMeta: vi.fn(async () => ({ resolved: 0 })),
}))

vi.mock('../pack-gc', () => ({ runPackGcAfterPass: vi.fn(async () => {}) }))

vi.mock('../../key-label-store', () => ({ KEY_LABEL_SYNC_UNIT: 'key-labels' }))
vi.mock('../../typing-test-text-store', () => ({ TYPING_TEST_TEXT_SYNC_UNIT: 'typing-test-texts' }))

vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: () => ({ tombstoneRowsForUidHashInRange: vi.fn() }),
}))

vi.mock('../../typing-analytics/sync-state', () => ({
  loadSyncState: vi.fn(async () => null),
  saveSyncState: vi.fn(async () => {}),
  emptySyncState: (id: string) => ({ _rev: 3, my_device_id: id, uploaded: {}, reconciled_at: {}, last_synced_at: 0 }),
  isReconcilePending: () => false,
}))

// --- In-memory Drive ---

interface MemFile {
  id: string
  name: string
  content: string
  createdTime: string
  modifiedTime: string
}

const drive = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  seq: 0,
  clock: 0,
  downloads: [] as string[],
  uploads: [] as string[],
  deletes: [] as string[],
  /** Number of listFiles calls, filtered or not. */
  lists: 0,
  /** While true, files created by uploadFile are left out of listings
   *  (Drive's listing lag); `hidden` holds their ids. */
  hideNew: false,
  hidden: new Set<string>(),
  /** When set, every listing waits for it first. */
  listGate: null as Promise<void> | null,
}))

function memFiles(): Map<string, MemFile> {
  return drive.files as Map<string, MemFile>
}

function nextTime(): string {
  drive.clock += 1000
  return new Date(Date.UTC(2026, 9, 2) + drive.clock).toISOString()
}

function addFile(name: string, content: string): string {
  const id = `id-${++drive.seq}`
  const time = nextTime()
  memFiles().set(id, { id, name, content, createdTime: time, modifiedTime: time })
  return id
}

vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  const notFound = (id: string): Error => new Error(`Drive download failed: 404 ${id}`)
  return {
    ...actual,
    listFiles: async (options?: ListFilesOptions): Promise<DriveFile[]> => {
      drive.lists++
      await drive.listGate
      return [...memFiles().values()]
        .filter((f) => !drive.hidden.has(f.id))
        .filter((f) => !options?.nameContains || f.name.includes(options.nameContains))
        .map(({ id, name, modifiedTime, createdTime }) => ({ id, name, modifiedTime, createdTime }))
    },
    downloadRawFile: async (id: string): Promise<string> => {
      drive.downloads.push(id)
      const file = memFiles().get(id)
      if (!file) throw notFound(id)
      return file.content
    },
    downloadFile: async (id: string): Promise<SyncEnvelope> => {
      drive.downloads.push(id)
      const file = memFiles().get(id)
      if (!file) throw notFound(id)
      return JSON.parse(file.content) as SyncEnvelope
    },
    uploadFile: async (name: string, envelope: SyncEnvelope, existingId?: string): Promise<UploadedFile> => {
      drive.uploads.push(name)
      const content = JSON.stringify(envelope)
      if (existingId) {
        const file = memFiles().get(existingId)
        if (!file) throw new Error(`Drive update failed: 404 ${existingId}`)
        file.content = content
        file.modifiedTime = nextTime()
        return { id: existingId, modifiedTime: file.modifiedTime }
      }
      const id = addFile(name, content)
      if (drive.hideNew) drive.hidden.add(id)
      return { id, modifiedTime: memFiles().get(id)!.modifiedTime }
    },
    createRawFile: async (name: string, content: string): Promise<{ id: string }> => ({ id: addFile(name, content) }),
    deleteFile: async (id: string): Promise<void> => {
      drive.deletes.push(id)
      memFiles().delete(id)
    },
  }
})

import { encrypt, decrypt, storePassword, retrievePasswordResult } from '../sync-crypto'
import { PASSWORD_CHANGE_LOCK_FILE } from '../google-drive'
import { writeChangeState, forgetChangeStateCache } from '../sync-password-change-state'
import { syncRuntime } from '../sync-runtime-state'
import { lockTiming } from '../sync-password-lock'
import { passwordChangeTuning } from '../sync-password-switch'
import { flushPendingChanges, setupBeforeQuitHandler } from '../sync-flush'
import {
  PasswordMismatchError,
  setPasswordAndValidate,
  ensurePasswordCheckValidated,
  validatePasswordCheck,
  passwordCheckTiming,
} from '../sync-password'
import { SyncBlockedError } from '../sync-password-guard'
import {
  _resetForTests,
  executeSync,
  executeAnalyticsSync,
  notifyChange,
  setProgressCallback,
  startPolling,
  waitForPollPassForTests,
  hasAnyRemoteTypingData,
  listRemoteTypingHashesForUidFromCloud,
  listRemoteTypingDaysFor,
  deleteRemoteTypingDay,
  fetchRemoteTypingDay,
  listUndecryptableFiles,
  scanRemoteData,
  fetchRemoteBundle,
  listRemoteFileNames,
  startPasswordChange,
} from '../sync-service'
import { POLL_INTERVAL_MS } from '../sync-runtime-state'

const OLD = 'old-password'
const NEW = 'new-password'
const PC_NAME = 'password-check.enc'
const PC_PAYLOAD = JSON.stringify({ type: 'password-check', version: 1 })
const TYPING_DAY = { uid: 'uid1', hash: 'hashother', day: '2026-10-01' }
const TYPING_DAY_FILE = `keyboards_${TYPING_DAY.uid}_devices_${TYPING_DAY.hash}_days_${TYPING_DAY.day}.enc`

async function seedEncrypted(name: string, unit: string, plain: string, password: string): Promise<string> {
  return addFile(name, JSON.stringify(await encrypt(plain, password, unit)))
}

let pcId = ''

async function seedDrive(): Promise<void> {
  pcId = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, OLD)
  await seedEncrypted('favorites_tapDance.enc', 'favorites/tapDance', '{"td":1}', OLD)
  await seedEncrypted('i18n_index.enc', 'i18n/index', '{"i":1}', OLD)
  await seedEncrypted(TYPING_DAY_FILE, 'keyboards/uid1/devices/hashother/days/2026-10-01', '{"type":"typing-analytics-device"}', OLD)
}

function seedForeignLock(): void {
  addFile(
    PASSWORD_CHANGE_LOCK_FILE,
    JSON.stringify({ type: 'password-change-lock', version: 1, lockId: 'other', machineHash: 'hash-other', startedAt: '2026-10-02T09:00:00.000Z' }),
  )
}

async function seedLocalChange(): Promise<void> {
  await writeChangeState({ version: 1, target: 'new', step: 'reencrypting', lockId: 'mine', startedAt: 1 })
}

async function seedInvalidLocalChange(): Promise<void> {
  const dir = join(userDataRef.dir, 'local', 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sync-password-change.json'), 'not json')
  forgetChangeStateCache()
}

/** Re-encrypts the password-check with `password`, as another PC finishing a change would. */
async function rewritePasswordCheck(password: string): Promise<void> {
  const file = memFiles().get(pcId)!
  file.content = JSON.stringify(await encrypt(PC_PAYLOAD, password, 'password-check'))
  file.modifiedTime = nextTime()
}

function resetDriveLog(): void {
  drive.downloads = []
  drive.uploads = []
  drive.deletes = []
  drive.lists = 0
}

function expectNoDataWork(): void {
  expect(drive.uploads).toEqual([])
  expect(drive.deletes).toEqual([])
  expect(mocks.mergeWithRemote).not.toHaveBeenCalled()
  expect(mocks.syncOrUpload).not.toHaveBeenCalled()
  expect(mocks.mergeDeviceDayBundle).not.toHaveBeenCalled()
}

let progress: SyncProgress[] = []

describe('sync password-change guard', () => {
  beforeEach(async () => {
    userDataRef.dir = await mkdtemp(join(tmpdir(), 'pipette-guard-'))
    memFiles().clear()
    drive.seq = 0
    drive.clock = 0
    drive.hideNew = false
    drive.hidden.clear()
    drive.listGate = null
    resetDriveLog()
    _resetForTests()
    progress = []
    setProgressCallback((p) => progress.push(p))
    vi.clearAllMocks()
    appEvents.handlers.clear()
    passwordChangeTuning.chunkSize = 50
    passwordChangeTuning.maxPasses = 3
    vi.spyOn(lockTiming, 'sleep').mockResolvedValue(undefined)
    await storePassword(OLD)
    await seedDrive()
    resetDriveLog()
  })

  afterEach(async () => {
    _resetForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await rm(userDataRef.dir, { recursive: true, force: true })
  })

  const blockers = [
    { name: 'a lock from another PC', reason: 'blockedByOtherDevice', seed: async () => seedForeignLock() },
    { name: 'a local change state', reason: 'blockedLocal', seed: seedLocalChange },
    { name: 'an unreadable local change state', reason: 'blockedLocal', seed: seedInvalidLocalChange },
  ] as const

  describe.each(blockers)('with $name', ({ reason, seed }) => {
    const key = `sync.passwordChange.${reason}`

    beforeEach(async () => {
      await seed()
      resetDriveLog()
    })

    afterEach(() => {
      // A local change is known without Drive, so nothing is even listed.
      if (reason === 'blockedLocal') expect(drive.lists).toBe(0)
    })

    it.each([
      ['download', 'all'],
      ['upload', 'all'],
      ['download', 'favorites'],
      ['upload', { keyboard: 'uid1' }],
      ['download', 'packs'],
    ] as const)('executeSync(%s, %j) is skipped with the reason', async (direction, scope) => {
      const result = await executeSync(direction, scope)

      expect(result).toEqual({ status: 'skipped', skipReason: reason })
      expect(progress.at(-1)).toMatchObject({ direction, status: 'error', message: key })
      expect(syncRuntime.isSyncing).toBe(false)
      expectNoDataWork()
    })

    it('flushPendingChanges keeps the pending changes and reports the reason', async () => {
      syncRuntime.pendingChanges.add('favorites/tapDance')

      await flushPendingChanges()

      expect([...syncRuntime.pendingChanges]).toEqual(['favorites/tapDance'])
      expect(progress.at(-1)).toMatchObject({ direction: 'upload', status: 'error', message: key })
      expect(syncRuntime.isSyncing).toBe(false)
      expectNoDataWork()
    })

    it('polling merges nothing', async () => {
      vi.useFakeTimers()
      syncRuntime.lastKnownRemoteState.set('unrelated.enc', 'x')

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()

      expect(progress.at(-1)).toMatchObject({ status: 'error', message: key })
      expectNoDataWork()
    })

    it('executeAnalyticsSync returns false', async () => {
      expect(await executeAnalyticsSync('uid1')).toBe(false)
      expectNoDataWork()
    })

    it('the Sync > Typing cloud reads and the remote day delete do nothing', async () => {
      expect(await hasAnyRemoteTypingData()).toBe(false)
      expect(await listRemoteTypingHashesForUidFromCloud('uid1')).toEqual([])
      expect(await listRemoteTypingDaysFor('uid1', 'hashother')).toEqual([])
      expect(await deleteRemoteTypingDay('uid1', 'hashother', '2026-10-01')).toBe(false)
      expect(await fetchRemoteTypingDay('uid1', 'hashother', '2026-10-01')).toBe(false)
      expect(drive.downloads).toEqual([])
      expectNoDataWork()
    })

    it('the Cloud Data scans are refused and the import listing falls back to local', async () => {
      await expect(listUndecryptableFiles()).rejects.toThrow(SyncBlockedError)
      await expect(scanRemoteData()).rejects.toThrow(key)
      await expect(fetchRemoteBundle('favorites/tapDance')).rejects.toThrow(key)
      expect(await listRemoteFileNames()).toBeNull()
      expect(drive.downloads).toEqual([])
      expectNoDataWork()
    })

    it('setPasswordAndValidate is refused before the password is stored', async () => {
      await expect(setPasswordAndValidate(NEW)).rejects.toThrow(key)

      const stored = await retrievePasswordResult()
      expect(stored.ok && stored.password).toBe(OLD)
      expectNoDataWork()
    })
  })

  it('a change notified during a blocked flush leaves a single retry timer', async () => {
    await seedLocalChange()
    vi.useFakeTimers()
    syncRuntime.pendingChanges.add('favorites/tapDance')

    const flushing = flushPendingChanges()
    notifyChange('favorites/macro')
    await flushing

    expect(vi.getTimerCount()).toBe(1)
  })

  describe('password change vs analytics sync', () => {
    it('a password change is refused while an analytics sync runs', async () => {
      let open!: () => void
      drive.listGate = new Promise((resolve) => { open = resolve })
      const analytics = executeAnalyticsSync('uid1')
      await vi.waitFor(() => expect(drive.lists).toBeGreaterThan(0))

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.changePasswordInProgress')

      open()
      expect(await analytics).toBe(true)
    })

    it('no analytics sync starts while a password change runs', async () => {
      let open!: () => void
      drive.listGate = new Promise((resolve) => { open = resolve })
      const change = startPasswordChange(NEW)

      expect(await executeAnalyticsSync('uid1')).toBe(false)

      open()
      await change
      expect(mocks.syncOrUpload).not.toHaveBeenCalled()
    })
  })

  describe('before-quit', () => {
    it('does not flush pending changes while a local change exists, and still quits', async () => {
      await seedLocalChange()
      setupBeforeQuitHandler()
      syncRuntime.pendingChanges.add('favorites/tapDance')
      const preventDefault = vi.fn()

      appEvents.handlers.get('before-quit')!({ preventDefault })
      await vi.waitFor(() => expect(mockQuit).toHaveBeenCalled())

      expect(preventDefault).toHaveBeenCalled()
      expect(drive.lists).toBe(0)
      expectNoDataWork()
    })

    it('flushes when no change is in progress', async () => {
      setupBeforeQuitHandler()
      syncRuntime.pendingChanges.add('favorites/tapDance')

      appEvents.handlers.get('before-quit')!({ preventDefault: vi.fn() })
      await vi.waitFor(() => expect(mockQuit).toHaveBeenCalled())

      expect(mocks.syncOrUpload).toHaveBeenCalledWith('favorites/tapDance', OLD, expect.any(Array))
    })
  })

  it('a password change of our own is not blocked by its own lock and state', async () => {
    await startPasswordChange(NEW)

    const stored = await retrievePasswordResult()
    expect(stored.ok && stored.password).toBe(NEW)
    expect([...memFiles().values()].some((f) => f.name === PASSWORD_CHANGE_LOCK_FILE)).toBe(false)
    // The finished change leaves nothing behind, so syncing works again.
    expect(await executeSync('download', 'favorites')).toEqual({ status: 'completed' })
  })

  it('a lock is only a block while it is listed', async () => {
    expect((await executeSync('upload', 'favorites')).status).toBe('completed')
    seedForeignLock()
    expect((await executeSync('upload', 'favorites')).skipReason).toBe('blockedByOtherDevice')
  })

  describe('password-check creation and choice', () => {
    const creates = (): number => drive.uploads.filter((name) => name === PC_NAME).length

    beforeEach(() => {
      memFiles().delete(pcId)
    })

    it('two passes that both see it missing create it once', async () => {
      await Promise.all([ensurePasswordCheckValidated(OLD, []), ensurePasswordCheckValidated(OLD, [])])

      expect(creates()).toBe(1)
    })

    it('a pass with a different password does not share the creation of another', async () => {
      const results = await Promise.allSettled([
        ensurePasswordCheckValidated(OLD, []),
        ensurePasswordCheckValidated(NEW, []),
      ])

      expect(results[0].status).toBe('fulfilled')
      expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(PasswordMismatchError) })
      expect(creates()).toBe(1)
    })

    it('a recently created password-check still has to open with the password', async () => {
      await ensurePasswordCheckValidated(OLD, [])

      await expect(ensurePasswordCheckValidated(NEW, [])).rejects.toThrow(PasswordMismatchError)
      await ensurePasswordCheckValidated(OLD, [])
      expect(creates()).toBe(1)
    })

    it('validates again when the chosen password-check is a different file with the same modifiedTime', async () => {
      const other = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, NEW)
      const chosen = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, OLD)
      await ensurePasswordCheckValidated(OLD, [memFiles().get(chosen)!])

      memFiles().get(other)!.modifiedTime = memFiles().get(chosen)!.modifiedTime
      await expect(
        ensurePasswordCheckValidated(OLD, [memFiles().get(chosen)!, memFiles().get(other)!]),
      ).rejects.toThrow(PasswordMismatchError)
    })

    it('forgets the created file after a while, so one deleted elsewhere is created again', async () => {
      let now = 1_000_000
      vi.spyOn(passwordCheckTiming, 'now').mockImplementation(() => now)

      await ensurePasswordCheckValidated(OLD, [])
      now += passwordCheckTiming.createdMemoryMs - 1
      await ensurePasswordCheckValidated(OLD, [])
      expect(creates()).toBe(1)

      now += 2
      await ensurePasswordCheckValidated(OLD, [])
      expect(creates()).toBe(2)
    })

    it('with two password-checks, validates the newest one', async () => {
      const older = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, NEW)
      const newer = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, OLD)
      const listing = (): DriveFile[] => [...memFiles().values()].filter((f) => f.id === older || f.id === newer)

      await validatePasswordCheck(OLD, listing())
      expect(drive.downloads).toEqual([newer])

      memFiles().get(older)!.modifiedTime = nextTime()
      await expect(validatePasswordCheck(OLD, listing())).rejects.toThrow(PasswordMismatchError)
    })

    it('with two equally new password-checks, validates the smallest id', async () => {
      const first = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, OLD)
      const second = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, NEW)
      memFiles().get(second)!.modifiedTime = memFiles().get(first)!.modifiedTime

      await validatePasswordCheck(OLD, [memFiles().get(second)!, memFiles().get(first)!])
      expect(drive.downloads).toEqual([first])
    })

    it('a finished password change leaves a single password-check', async () => {
      await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, OLD)
      await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, OLD)

      await startPasswordChange(NEW)

      const checks = [...memFiles().values()].filter((f) => f.name === PC_NAME)
      expect(checks).toHaveLength(1)
      expect(await decrypt(JSON.parse(checks[0].content) as SyncEnvelope, NEW)).toBe(PC_PAYLOAD)
    })
  })

  describe('password-check re-validation', () => {
    it('creates one password-check while the listing does not show it yet', async () => {
      memFiles().delete(pcId)
      drive.hideNew = true
      const creates = (): number => drive.uploads.filter((name) => name === PC_NAME).length

      await setPasswordAndValidate(OLD)
      expect(creates()).toBe(1)

      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()
      expect((await executeSync('upload', 'favorites')).status).toBe('completed')
      expect(await executeAnalyticsSync('uid1')).toBe(true)
      vi.useFakeTimers()
      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(creates()).toBe(1)
      expect(mocks.syncOrUpload).toHaveBeenCalled()

      // Once listed, the created file is the validated one: no download.
      drive.hidden.clear()
      resetDriveLog()
      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()
      expect(drive.uploads.filter((name) => name === PC_NAME)).toEqual([])
      expect([...syncRuntime.pendingChanges]).toEqual([])
    })

    it('flush validates once, skips the check while its modifiedTime is unchanged, and stops on a rewritten one', async () => {
      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()
      expect(mocks.syncOrUpload).toHaveBeenCalledTimes(1)
      expect(drive.downloads).toEqual([pcId])

      resetDriveLog()
      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()
      expect(mocks.syncOrUpload).toHaveBeenCalledTimes(2)
      expect(drive.downloads).toEqual([])

      await rewritePasswordCheck(NEW)
      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()

      expect(drive.downloads).toEqual([pcId])
      expect(mocks.syncOrUpload).toHaveBeenCalledTimes(2)
      expect(progress.at(-1)).toMatchObject({ status: 'error', message: 'sync.passwordMismatch' })
      expect([...syncRuntime.pendingChanges]).toEqual(['favorites/tapDance'])
      expect(drive.uploads).toEqual([])
    })

    it('a scoped executeSync hits PasswordMismatch after another PC changed the password', async () => {
      expect((await executeSync('upload', 'favorites')).status).toBe('completed')
      vi.clearAllMocks()

      await rewritePasswordCheck(NEW)

      await expect(executeSync('upload', 'favorites')).rejects.toThrow(PasswordMismatchError)
      expectNoDataWork()
    })

    it('polling stops merging after the password-check is rewritten', async () => {
      vi.useFakeTimers()
      syncRuntime.lastKnownRemoteState.set('unrelated.enc', 'x')
      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mocks.mergeWithRemote).toHaveBeenCalled()
      vi.clearAllMocks()

      await rewritePasswordCheck(NEW)
      memFiles().get([...memFiles().keys()].find((id) => memFiles().get(id)!.name === 'favorites_tapDance.enc')!)!.modifiedTime = nextTime()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()

      expectNoDataWork()
    })

    it('executeAnalyticsSync validates the password-check', async () => {
      expect(await executeAnalyticsSync('uid1')).toBe(true)
      expect(drive.downloads).toContain(pcId)
      expect(mocks.syncOrUpload).toHaveBeenCalled()
      vi.clearAllMocks()
      resetDriveLog()

      expect(await executeAnalyticsSync('uid1')).toBe(true)
      expect(drive.downloads).not.toContain(pcId)
      vi.clearAllMocks()

      await rewritePasswordCheck(NEW)
      expect(await executeAnalyticsSync('uid1')).toBe(false)
      expectNoDataWork()
    })

    it('fetchRemoteTypingDay validates the password-check', async () => {
      await rewritePasswordCheck(NEW)

      await expect(fetchRemoteTypingDay(TYPING_DAY.uid, TYPING_DAY.hash, TYPING_DAY.day)).rejects.toThrow(PasswordMismatchError)
      expect(mocks.mergeDeviceDayBundle).not.toHaveBeenCalled()
    })

    it('fetchRemoteTypingDay merges with a matching password-check', async () => {
      expect(await fetchRemoteTypingDay(TYPING_DAY.uid, TYPING_DAY.hash, TYPING_DAY.day)).toBe(true)
      expect(mocks.mergeDeviceDayBundle).toHaveBeenCalledTimes(1)
    })
  })
})
