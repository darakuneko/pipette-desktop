// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sync-format markers (`sync-format-v{n}.json`): every pass that may
// write creates this app's marker before any data, a newer marker stops
// syncing, and smaller markers are removed once ours is listed. In-memory
// Drive, real AES-GCM envelopes; merging and bundling are spies.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DriveFile, ListFilesOptions, UploadedFile } from '../google-drive'
import type { SyncEnvelope, SyncProgress } from '../../../shared/types/sync'

const userDataRef = vi.hoisted(() => ({ dir: '' }))

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
  app: { getPath: () => userDataRef.dir, on: vi.fn(), quit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

// One PBKDF2 iteration keeps the real envelope code while the suite stays fast.
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

const drive = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  seq: 0,
  clock: 0,
  /** Drive writes and data work, in order: `create:<name>`,
   *  `upload:<name>`, `delete:<name>`, `data:<unit>`. */
  events: [] as string[],
  downloads: [] as string[],
  /** While true, files created here are left out of listings (Drive's
   *  listing lag); `hidden` holds their ids. */
  hideNew: false,
  hidden: new Set<string>(),
  createError: null as Error | null,
  /** When set, every createRawFile waits for it first. */
  createGate: null as Promise<void> | null,
  createStarted: 0,
  /** When set, listings whose `nameContains` equals `listGateName`
   *  (undefined: unfiltered listings) wait for it first. */
  listGate: null as Promise<void> | null,
  listGateName: undefined as string | undefined,
  listGateStarted: 0,
  deleteError: null as Error | null,
  listOptions: [] as Array<ListFilesOptions | undefined>,
}))

const mocks = vi.hoisted(() => ({
  mergeWithRemote: vi.fn(async (_file: unknown, unit: string) => {
    drive.events.push(`data:${unit}`)
  }),
  syncOrUpload: vi.fn(async (unit: string) => {
    drive.events.push(`data:${unit}`)
  }),
  mergeDeviceDayBundle: vi.fn(async () => {}),
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
  readKeyboardMetaIndex: vi.fn(async () => ({ entries: [] })),
  getActiveKeyboardMetaMap: vi.fn(() => new Map()),
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

interface MemFile {
  id: string
  name: string
  content: string
  createdTime: string
  modifiedTime: string
}

function memFiles(): Map<string, MemFile> {
  return drive.files as Map<string, MemFile>
}

function addFile(name: string, content: string): string {
  const id = `id-${++drive.seq}`
  drive.clock += 1000
  const time = new Date(Date.UTC(2026, 9, 3) + drive.clock).toISOString()
  memFiles().set(id, { id, name, content, createdTime: time, modifiedTime: time })
  return id
}

function addCreated(name: string, content: string): string {
  const id = addFile(name, content)
  if (drive.hideNew) drive.hidden.add(id)
  return id
}

vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    ...actual,
    listFiles: async (options?: ListFilesOptions): Promise<DriveFile[]> => {
      drive.listOptions.push(options)
      if (drive.listGate && options?.nameContains === drive.listGateName) {
        drive.listGateStarted++
        await drive.listGate
      }
      return [...memFiles().values()]
        .filter((f) => !drive.hidden.has(f.id))
        .filter((f) => !options?.nameContains || f.name.includes(options.nameContains))
        .map(({ id, name, modifiedTime, createdTime }) => ({ id, name, modifiedTime, createdTime }))
    },
    downloadRawFile: async (id: string): Promise<string> => {
      drive.downloads.push(id)
      const file = memFiles().get(id)
      if (!file) throw new Error(`404 ${id}`)
      return file.content
    },
    downloadFile: async (id: string): Promise<SyncEnvelope> => {
      drive.downloads.push(id)
      const file = memFiles().get(id)
      if (!file) throw new Error(`404 ${id}`)
      return JSON.parse(file.content) as SyncEnvelope
    },
    uploadFile: async (name: string, envelope: SyncEnvelope, existingId?: string): Promise<UploadedFile> => {
      drive.events.push(`upload:${name}`)
      if (existingId) {
        const file = memFiles().get(existingId)
        if (!file) throw new Error(`404 ${existingId}`)
        drive.clock += 1000
        file.content = JSON.stringify(envelope)
        file.modifiedTime = new Date(Date.UTC(2026, 9, 3) + drive.clock).toISOString()
        return { id: existingId, modifiedTime: file.modifiedTime }
      }
      const id = addCreated(name, JSON.stringify(envelope))
      return { id, modifiedTime: memFiles().get(id)!.modifiedTime }
    },
    createRawFile: async (name: string, content: string): Promise<{ id: string }> => {
      drive.createStarted++
      await drive.createGate
      if (drive.createError) throw drive.createError
      drive.events.push(`create:${name}`)
      return { id: addCreated(name, content) }
    },
    deleteFile: async (id: string): Promise<void> => {
      if (drive.deleteError) throw drive.deleteError
      drive.events.push(`delete:${memFiles().get(id)?.name ?? id}`)
      memFiles().delete(id)
    },
  }
})

import { encrypt, storePassword, retrievePasswordResult, clearPassword } from '../sync-crypto'
import { isDataFileName, parseSyncFormatFileName, syncFormatFileName } from '../google-drive'
import { syncRuntime, POLL_INTERVAL_MS } from '../sync-runtime-state'
import { flushPendingChanges } from '../sync-flush'
import { setPasswordAndValidate } from '../sync-password'
import { assertSyncAllowed } from '../sync-password-guard'
import { lockTiming } from '../sync-password-lock'
import { writeChangeState, storeChangeKeys, readChangeState } from '../sync-password-change-state'
import {
  ensureSyncFormatMarker,
  forgetCreatedSyncFormatMarker,
  syncFormatGeneration,
  getSyncFormatStatus,
  requiredSyncFormat,
  syncFormatTiming,
} from '../sync-format'
import { SYNC_FORMAT_VERSION } from '../../../shared/constants/sync-format'
import {
  _resetForTests,
  executeSync,
  executeAnalyticsSync,
  setProgressCallback,
  startPolling,
  waitForPollPassForTests,
  scanRemoteData,
  listUndecryptableFiles,
  listRemoteFileNames,
  startPasswordChange,
  resumePasswordChange,
  revertPasswordChange,
  abandonPasswordChange,
  deletePasswordChangeUndecryptableFiles,
  recoverPasswordChangeOnStartup,
  fetchRemoteTypingDay,
} from '../sync-service'

const PASSWORD = 'password'
const OWN = syncFormatFileName(SYNC_FORMAT_VERSION)
const OLDER = syncFormatFileName(SYNC_FORMAT_VERSION - 1)
const NEWER = syncFormatFileName(SYNC_FORMAT_VERSION + 1)

function markerContent(version: number): string {
  return JSON.stringify({ type: 'sync-format', version })
}

function seedMarker(version: number): string {
  return addFile(syncFormatFileName(version), markerContent(version))
}

async function seedEncrypted(name: string, unit: string, plain: string): Promise<string> {
  return addFile(name, JSON.stringify(await encrypt(plain, PASSWORD, unit)))
}

function markerNames(): string[] {
  return [...memFiles().values()].map((f) => f.name).filter((name) => parseSyncFormatFileName(name) !== null).sort()
}

function creates(): number {
  return drive.events.filter((e) => e === `create:${OWN}`).length
}

/** The marker create comes first, and before any data work or upload. */
function expectMarkerFirst(): void {
  expect(drive.events[0]).toBe(`create:${OWN}`)
  expect(drive.events.slice(1).some((e) => e === `create:${OWN}`)).toBe(false)
}

function expectNoDataWork(): void {
  expect(drive.events.filter((e) => e.startsWith('data:') || e.startsWith('upload:'))).toEqual([])
}

async function runPoll(): Promise<void> {
  vi.useFakeTimers()
  startPolling()
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  await waitForPollPassForTests()
}

let progress: SyncProgress[] = []

describe('sync-format markers', () => {
  beforeEach(async () => {
    userDataRef.dir = await mkdtemp(join(tmpdir(), 'pipette-format-'))
    memFiles().clear()
    drive.seq = 0
    drive.clock = 0
    drive.hideNew = false
    drive.hidden.clear()
    drive.createError = null
    drive.createGate = null
    drive.createStarted = 0
    drive.listGate = null
    drive.listGateName = undefined
    drive.listGateStarted = 0
    drive.deleteError = null
    _resetForTests()
    progress = []
    setProgressCallback((p) => progress.push(p))
    vi.clearAllMocks()
    vi.spyOn(lockTiming, 'sleep').mockResolvedValue(undefined)
    await storePassword(PASSWORD)
    await seedEncrypted('password-check.enc', 'password-check', JSON.stringify({ type: 'password-check', version: 1 }))
    await seedEncrypted('favorites_tapDance.enc', 'favorites/tapDance', '{"td":1}')
    drive.events = []
    drive.downloads = []
    drive.listOptions = []
  })

  afterEach(async () => {
    _resetForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await rm(userDataRef.dir, { recursive: true, force: true })
  })

  describe('names', () => {
    it('parses only exact sync-format-v{n}.json names', () => {
      expect(parseSyncFormatFileName('sync-format-v1.json')).toBe(1)
      expect(parseSyncFormatFileName('sync-format-v12.json')).toBe(12)
      expect(parseSyncFormatFileName('sync-format-v0.json')).toBe(0)
      for (const name of [
        'sync-format-v.json',
        'sync-format-v1.json.enc',
        'x-sync-format-v1.json',
        'sync-format-v1a.json',
        'sync-format-v-1.json',
        'sync-format-v1.5.json',
        'sync-format-v99999999999999999999.json',
      ]) {
        expect(parseSyncFormatFileName(name)).toBeNull()
      }
    })

    it('the required version is the largest listed marker, null without one', () => {
      const file = (name: string): DriveFile => ({ id: name, name, modifiedTime: 'm' })
      expect(requiredSyncFormat([])).toBeNull()
      expect(requiredSyncFormat([file('favorites_tapDance.enc'), file('sync-format-v.json')])).toBeNull()
      expect(requiredSyncFormat([file('sync-format-v1.json'), file('sync-format-v3.json'), file('sync-format-v2.json')])).toBe(3)
    })

    it('markers are not data files', () => {
      expect(isDataFileName(OWN)).toBe(false)
      expect(isDataFileName(NEWER)).toBe(false)
      expect(isDataFileName('sync-format-v1.json.enc')).toBe(true)
    })
  })

  describe('raising before data is written', () => {
    it.each([
      ['upload', 'all'],
      ['download', 'all'],
      ['upload', 'favorites'],
      ['download', 'packs'],
    ] as const)('executeSync(%s, %j) creates the marker first', async (direction, scope) => {
      expect((await executeSync(direction, scope)).status).toBe('completed')

      expectMarkerFirst()
      expect(markerNames()).toEqual([OWN])
      expect(JSON.parse(memFiles().get([...memFiles().values()].find((f) => f.name === OWN)!.id)!.content)).toEqual({
        type: 'sync-format',
        version: SYNC_FORMAT_VERSION,
      })
    })

    it('the auto-sync flush creates the marker first', async () => {
      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()

      expectMarkerFirst()
      expect(drive.events).toContain('data:favorites/tapDance')
    })

    it('polling creates the marker, also on the first poll that only records state', async () => {
      await runPoll()

      expect(drive.events).toEqual([`create:${OWN}`])
    })

    it('the analytics sync creates the marker first from its narrow listings', async () => {
      expect(await executeAnalyticsSync('uid1')).toBe(true)

      expectMarkerFirst()
      expect(drive.events).toContain('data:keyboards/uid1/devices/hashown/days/2026-10-01')
      expect(drive.listOptions.some((o) => o === undefined)).toBe(false)
    })

    it('setting the password creates the marker before the password-check', async () => {
      memFiles().clear()
      await clearPassword()

      await setPasswordAndValidate(PASSWORD)

      expect(drive.events).toEqual([`create:${OWN}`, 'upload:password-check.enc'])
    })

    it('a pass with our marker listed creates nothing', async () => {
      seedMarker(SYNC_FORMAT_VERSION)

      await executeSync('upload', 'all')

      expect(creates()).toBe(0)
      expect(markerNames()).toEqual([OWN])
    })

    it('the read-only scans do not create the marker', async () => {
      await scanRemoteData()
      await listUndecryptableFiles()
      await listRemoteFileNames()

      expect(creates()).toBe(0)
    })
  })

  describe('a failed marker create', () => {
    beforeEach(() => {
      drive.createError = new Error('Drive upload failed: 503')
    })

    it('stops executeSync with an error before any data', async () => {
      await expect(executeSync('upload', 'all')).rejects.toThrow('503')

      expect(progress.at(-1)).toMatchObject({ status: 'error', message: 'Drive upload failed: 503' })
      expect(syncRuntime.isSyncing).toBe(false)
      expectNoDataWork()
    })

    it('stops the flush with an error and keeps the pending changes', async () => {
      syncRuntime.pendingChanges.add('favorites/tapDance')

      await flushPendingChanges()

      expect(progress.at(-1)).toMatchObject({ direction: 'upload', status: 'error', message: 'Drive upload failed: 503' })
      expect([...syncRuntime.pendingChanges]).toEqual(['favorites/tapDance'])
      expectNoDataWork()
    })

    it('stops polling and the analytics sync before any data', async () => {
      syncRuntime.lastKnownRemoteState.set('unrelated.enc', 'x')
      expect(await executeAnalyticsSync('uid1')).toBe(false)
      await runPoll()

      expectNoDataWork()
    })

    it('refuses to set the password and keeps none stored', async () => {
      memFiles().clear()
      await clearPassword()

      await expect(setPasswordAndValidate(PASSWORD)).rejects.toThrow('503')

      expect((await retrievePasswordResult()).ok).toBe(false)
      expectNoDataWork()
    })

    it('the next pass creates it', async () => {
      await expect(executeSync('upload', 'all')).rejects.toThrow()
      drive.createError = null

      expect((await executeSync('upload', 'all')).status).toBe('completed')
      expect(markerNames()).toEqual([OWN])
    })
  })

  describe('listing lag', () => {
    beforeEach(() => {
      drive.hideNew = true
    })

    it('a marker this process created is not created again while listings miss it', async () => {
      await executeSync('upload', 'all')
      syncRuntime.pendingChanges.add('favorites/tapDance')
      await flushPendingChanges()
      expect(await executeAnalyticsSync('uid1')).toBe(true)
      await executeSync('download', 'favorites')

      expect(creates()).toBe(1)
    })

    it('is created again once the memory expires (a marker deleted elsewhere)', async () => {
      let now = 1_000_000
      vi.spyOn(syncFormatTiming, 'now').mockImplementation(() => now)

      await executeSync('upload', 'all')
      now += syncFormatTiming.createdMemoryMs - 1
      await executeSync('upload', 'all')
      expect(creates()).toBe(1)

      now += 2
      await executeSync('upload', 'all')
      expect(creates()).toBe(2)
    })

    it('passes that see it missing at the same time create it once', async () => {
      await Promise.all([ensureSyncFormatMarker([], syncFormatGeneration()), ensureSyncFormatMarker([], syncFormatGeneration()), ensureSyncFormatMarker([], syncFormatGeneration())])

      expect(creates()).toBe(1)
    })
  })

  describe('cleanup of smaller markers', () => {
    it('keeps a smaller marker while our own is not listed yet, then deletes it', async () => {
      seedMarker(SYNC_FORMAT_VERSION - 1)
      drive.hideNew = true

      await executeSync('upload', 'all')
      await executeSync('upload', 'all')
      expect(markerNames()).toEqual([OLDER, OWN])
      expect(drive.events.some((e) => e.startsWith('delete:'))).toBe(false)

      drive.hidden.clear()
      await executeSync('upload', 'all')
      expect(markerNames()).toEqual([OWN])
      expect(drive.events).toContain(`delete:${OLDER}`)
    })

    it('deletes every smaller marker and never ours or a larger one', async () => {
      for (const name of [OLDER, OWN, NEWER, 'sync-format-v0.json']) addFile(name, '{}')
      const listing = [...memFiles().values()].map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }))

      await ensureSyncFormatMarker(listing, syncFormatGeneration())

      expect(markerNames()).toEqual([OWN, NEWER].sort())
      expect(creates()).toBe(0)
    })

    it('a failed delete does not stop the pass', async () => {
      seedMarker(SYNC_FORMAT_VERSION - 1)
      seedMarker(SYNC_FORMAT_VERSION)
      drive.deleteError = new Error('Drive delete failed: 500')

      expect((await executeSync('upload', 'all')).status).toBe('completed')
      expect(drive.events).toContain('data:favorites/tapDance')
    })
  })

  describe('a newer marker', () => {
    beforeEach(() => {
      seedMarker(SYNC_FORMAT_VERSION + 1)
    })

    it('blocks without creating or deleting any marker', async () => {
      expect(await executeSync('upload', 'all')).toEqual({ status: 'skipped', skipReason: 'updateRequired' })
      expect(progress.at(-1)).toMatchObject({ status: 'error', message: 'sync.updateRequired' })
      expect(markerNames()).toEqual([NEWER])
      expect(drive.events).toEqual([])
    })

    it('blocks the entry points that only have narrow listings (resets, file deletes)', async () => {
      await expect(assertSyncAllowed()).rejects.toThrow('sync.updateRequired')
    })

    it('refuses to start a password change', async () => {
      await expect(startPasswordChange('another-password')).rejects.toThrow('sync.updateRequired')

      const stored = await retrievePasswordResult()
      expect(stored.ok && stored.password).toBe(PASSWORD)
      expect(drive.events).toEqual([])
    })

    it('our own marker next to it does not lift the block', async () => {
      seedMarker(SYNC_FORMAT_VERSION)

      expect((await executeSync('download', 'all')).skipReason).toBe('updateRequired')
    })
  })

  describe('the scans', () => {
    it('never download a marker', async () => {
      const marker = seedMarker(SYNC_FORMAT_VERSION)

      await scanRemoteData()
      expect(await listUndecryptableFiles()).toEqual([])
      expect(drive.downloads).not.toContain(marker)
      expect([...((await listRemoteFileNames()) ?? [])]).not.toContain(OWN)
    })
  })

  describe('password change', () => {
    const NEW_PASSWORD = 'new-password'

    async function seedChange(step: 'reencrypting' | 'committing' | 'cleanup'): Promise<void> {
      await writeChangeState({ version: 1, target: 'new', step, lockId: 'mine', startedAt: 1 })
      await storeChangeKeys({ oldPassword: PASSWORD, newPassword: NEW_PASSWORD })
    }

    it('creates our marker before re-encrypting anything', async () => {
      await startPasswordChange(NEW_PASSWORD)

      const markerAt = drive.events.indexOf(`create:${OWN}`)
      const firstUpload = drive.events.findIndex((e) => e.startsWith('upload:'))
      expect(markerAt).toBeGreaterThanOrEqual(0)
      expect(firstUpload).toBeGreaterThan(markerAt)
      expect(markerNames()).toEqual([OWN])
    })

    it('a failed marker create re-encrypts nothing', async () => {
      drive.createError = new Error('Drive upload failed: 503')

      await expect(startPasswordChange(NEW_PASSWORD)).rejects.toThrow('503')

      expect(drive.events.filter((e) => e.startsWith('upload:'))).toEqual([])
    })

    describe('with a newer marker on Drive', () => {
      beforeEach(() => {
        seedMarker(SYNC_FORMAT_VERSION + 1)
      })

      it.each([
        ['resume', () => resumePasswordChange()],
        ['revert', () => revertPasswordChange()],
        ['delete undecryptable files', () => deletePasswordChangeUndecryptableFiles(['id-2'])],
      ])('%s is refused before taking a lock or writing', async (_name, run) => {
        await seedChange('reencrypting')

        await expect(run()).rejects.toThrow('sync.updateRequired')

        expect(drive.events).toEqual([])
        expect((await readChangeState()).kind).toBe('ok')
      })

      it('resuming at committing is refused', async () => {
        await seedChange('committing')

        await expect(resumePasswordChange()).rejects.toThrow('sync.updateRequired')
        expect(drive.events).toEqual([])
      })

      it('the startup finish of a committing change stops and keeps the state', async () => {
        await seedChange('committing')

        expect(await recoverPasswordChangeOnStartup()).toBe('failed')

        expect(drive.events).toEqual([])
        expect((await readChangeState()).kind).toBe('ok')
      })

      it('abandon and the cleanup step still run, so a change can always be left', async () => {
        await seedChange('cleanup')
        expect(await recoverPasswordChangeOnStartup()).toBe('completed')
        expect((await readChangeState()).kind).toBe('none')

        await seedChange('reencrypting')
        await abandonPasswordChange()
        expect((await readChangeState()).kind).toBe('none')
      })
    })
  })

  describe('password-check creation on read paths', () => {
    const DAY_FILE = 'keyboards_uid1_devices_hashother_days_2026-10-01.enc'

    beforeEach(async () => {
      memFiles().delete([...memFiles().values()].find((f) => f.name === 'password-check.enc')!.id)
      await seedEncrypted(DAY_FILE, 'keyboards/uid1/devices/hashother/days/2026-10-01', '{"type":"typing-analytics-device"}')
      drive.events = []
    })

    it.each([
      ['scanRemoteData', () => scanRemoteData()],
      ['fetchRemoteTypingDay', () => fetchRemoteTypingDay('uid1', 'hashother', '2026-10-01')],
    ])('%s creates our marker before the password-check', async (_name, run) => {
      await run()

      expect(drive.events).toEqual([`create:${OWN}`, 'upload:password-check.enc'])
    })

    it.each([
      ['scanRemoteData', () => scanRemoteData()],
      ['fetchRemoteTypingDay', () => fetchRemoteTypingDay('uid1', 'hashother', '2026-10-01')],
    ])('%s creates no password-check when the marker cannot be created', async (_name, run) => {
      drive.createError = new Error('Drive upload failed: 503')

      await expect(run()).rejects.toThrow('503')

      expect(drive.events).toEqual([])
    })

    it('a marker this pass already created is not listed again', async () => {
      drive.hideNew = true
      await executeSync('upload', 'all')

      expect(creates()).toBe(1)
      expect(drive.events).toContain('upload:password-check.enc')
    })
  })

  it('sign-out forgets the created marker, so the next account gets its own', async () => {
    drive.hideNew = true
    await executeSync('upload', 'all')
    forgetCreatedSyncFormatMarker()
    await executeSync('upload', 'all')

    expect(creates()).toBe(2)
  })

  it('a create that finishes after sign-out is not remembered for the next account', async () => {
    drive.hideNew = true
    let open!: () => void
    drive.createGate = new Promise((resolve) => { open = resolve })

    const pass = executeSync('upload', 'all')
    await vi.waitFor(() => expect(drive.createStarted).toBe(1))
    forgetCreatedSyncFormatMarker()
    open()
    await pass

    expect(syncRuntime.syncFormatMarkerCreatedAt).toBeNull()
    await executeSync('upload', 'all')
    expect(creates()).toBe(2)
  })

  describe('a listing that returns after sign-out', () => {
    function holdListings(name: string | undefined): () => void {
      let open!: () => void
      drive.listGate = new Promise((resolve) => { open = resolve })
      drive.listGateName = name
      return open
    }

    it('does not remember our marker as seen (sync pass listing)', async () => {
      seedMarker(SYNC_FORMAT_VERSION)
      const open = holdListings(undefined)

      const pass = executeSync('upload', 'all')
      await vi.waitFor(() => expect(drive.listGateStarted).toBe(1))
      forgetCreatedSyncFormatMarker()
      open()
      await pass

      expect(syncRuntime.syncFormatMarkerSeenAt).toBeNull()
    })

    it('does not remember our marker as seen (markers-only listing before a password-check create)', async () => {
      seedMarker(SYNC_FORMAT_VERSION)
      memFiles().delete([...memFiles().values()].find((f) => f.name === 'password-check.enc')!.id)
      const open = holdListings('sync-format-v')

      const scan = scanRemoteData()
      await vi.waitFor(() => expect(drive.listGateStarted).toBe(1))
      forgetCreatedSyncFormatMarker()
      open()
      await scan

      expect(syncRuntime.syncFormatMarkerSeenAt).toBeNull()
      expect(drive.events).toEqual(['upload:password-check.enc'])
    })
  })

  describe('getSyncFormatStatus', () => {
    it.each([
      [[], { required: null, supported: SYNC_FORMAT_VERSION, updateRequired: false }],
      [[SYNC_FORMAT_VERSION - 1, SYNC_FORMAT_VERSION], { required: SYNC_FORMAT_VERSION, supported: SYNC_FORMAT_VERSION, updateRequired: false }],
      [[SYNC_FORMAT_VERSION, SYNC_FORMAT_VERSION + 1], { required: SYNC_FORMAT_VERSION + 1, supported: SYNC_FORMAT_VERSION, updateRequired: true }],
    ])('with markers %j', async (versions, expected) => {
      for (const version of versions) seedMarker(version)

      expect(await getSyncFormatStatus()).toEqual(expected)
      expect(drive.listOptions).toEqual([{ nameContains: 'sync-format-v' }])
    })
  })
})
