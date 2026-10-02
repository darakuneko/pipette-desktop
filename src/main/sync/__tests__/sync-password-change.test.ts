// SPDX-License-Identifier: GPL-2.0-or-later
//
// The resumable password change against an in-memory Drive, with the real
// AES-GCM envelope code and the real local state/key files (in a temp dir).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DriveFile, ListFilesOptions, UploadedFile } from '../google-drive'
import type { SyncEnvelope } from '../../../shared/types/sync'

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
  app: { getPath: () => userDataRef.dir },
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

/** Every decrypt attempt as [syncUnit, password], in call order. */
const decryptCalls = vi.hoisted(() => [] as Array<[string, string]>)
vi.mock('../sync-crypto', async () => {
  const actual = await vi.importActual<typeof import('../sync-crypto')>('../sync-crypto')
  return {
    ...actual,
    decrypt: (envelope: SyncEnvelope, password: string): Promise<string> => {
      decryptCalls.push([envelope.syncUnit, password])
      return actual.decrypt(envelope, password)
    },
  }
})

const mockGetAuthStatus = vi.fn(async () => ({ authenticated: true }))
vi.mock('../google-auth', () => ({
  getAuthStatus: () => mockGetAuthStatus(),
  getAccessToken: vi.fn(async () => 'token'),
}))

vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'hash-own'),
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
  /** Called before an upload is applied; throw to fail it. */
  beforeUpload: null as null | ((name: string, existingId: string | undefined) => Promise<void> | void),
  /** Called before a download is served. */
  beforeDownload: null as null | ((id: string) => Promise<void> | void),
  /** Called before a delete is applied; throw to fail it. */
  beforeDelete: null as null | ((id: string) => void),
  /** Called before a full (unfiltered) listing is served. */
  beforeList: null as null | (() => Promise<void> | void),
  /** Called after a raw file (the lock) is created. */
  afterCreate: null as null | ((id: string) => void),
  downloads: [] as string[],
  uploads: [] as string[],
}))

function memFiles(): Map<string, MemFile> {
  return drive.files as Map<string, MemFile>
}

function nextTime(): string {
  drive.clock += 1000
  return new Date(Date.UTC(2026, 9, 2) + drive.clock).toISOString()
}

function addFile(name: string, content: string, createdTime = nextTime()): string {
  const id = `id-${++drive.seq}`
  memFiles().set(id, { id, name, content, createdTime, modifiedTime: createdTime })
  return id
}

vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  const notFound = (id: string): Error => new Error(`Drive download failed: 404 ${id}`)
  return {
    ...actual,
    listFiles: async (options?: ListFilesOptions): Promise<DriveFile[]> => {
      if (!options?.nameContains) await drive.beforeList?.()
      return [...memFiles().values()]
        .filter((f) => !options?.nameContains || f.name.includes(options.nameContains))
        .map(({ id, name, modifiedTime, createdTime }) => ({ id, name, modifiedTime, createdTime }))
    },
    downloadRawFile: async (id: string): Promise<string> => {
      drive.downloads.push(id)
      await drive.beforeDownload?.(id)
      const file = memFiles().get(id)
      if (!file) throw notFound(id)
      return file.content
    },
    downloadFile: async (id: string): Promise<SyncEnvelope> => {
      drive.downloads.push(id)
      await drive.beforeDownload?.(id)
      const file = memFiles().get(id)
      if (!file) throw notFound(id)
      return JSON.parse(file.content) as SyncEnvelope
    },
    uploadFile: async (name: string, envelope: SyncEnvelope, existingId?: string): Promise<UploadedFile> => {
      await drive.beforeUpload?.(name, existingId)
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
      return { id, modifiedTime: memFiles().get(id)!.modifiedTime }
    },
    createRawFile: async (name: string, content: string): Promise<{ id: string }> => {
      const id = addFile(name, content)
      drive.afterCreate?.(id)
      return { id }
    },
    deleteFile: async (id: string): Promise<void> => {
      drive.beforeDelete?.(id)
      memFiles().delete(id)
    },
  }
})

import { encrypt, decrypt, storePassword, retrievePasswordResult } from '../sync-crypto'
import { PASSWORD_CHANGE_LOCK_FILE } from '../google-drive'
import { lockTiming } from '../sync-password-lock'
import {
  storeChangeKeys,
  retrieveChangeKeys,
  readChangeState,
  writeChangeState,
  type PasswordChangeState,
} from '../sync-password-change-state'
import { syncRuntime } from '../sync-runtime-state'
import {
  startPasswordChange,
  resumePasswordChange,
  revertPasswordChange,
  recoverPasswordChangeOnStartup,
  getPasswordChangeStatus,
  deletePasswordChangeUndecryptableFiles,
  abandonPasswordChange,
} from '../sync-password-change'
import { passwordChangeTuning } from '../sync-password-switch'

const OLD = 'old-password'
const NEW = 'new-password'
const PC_NAME = 'password-check.enc'
const PC_PAYLOAD = JSON.stringify({ type: 'password-check', version: 1 })
const DATA = [
  { name: 'favorites_tapDance.enc', unit: 'favorites/tapDance', plain: '{"td":1}' },
  { name: 'favorites_macro.enc', unit: 'favorites/macro', plain: '{"m":2}' },
  { name: 'keyboards_uid1_settings.enc', unit: 'keyboards/uid1/settings', plain: '{"s":3}' },
]

async function seedEncrypted(name: string, unit: string, plain: string, password: string): Promise<string> {
  return addFile(name, JSON.stringify(await encrypt(plain, password, unit)))
}

async function seedDrive(password = OLD): Promise<{ pcId: string; dataIds: string[] }> {
  const pcId = await seedEncrypted(PC_NAME, 'password-check', PC_PAYLOAD, password)
  const dataIds: string[] = []
  for (const d of DATA) dataIds.push(await seedEncrypted(d.name, d.unit, d.plain, password))
  return { pcId, dataIds }
}

function lockText(lockId: string, machineHash = 'hash-other'): string {
  return JSON.stringify({ type: 'password-change-lock', version: 1, lockId, machineHash, startedAt: '2026-10-02T09:00:00.000Z' })
}

/** Plaintext of `id` decrypted with `password`, or null when it does not open. */
async function openWith(id: string, password: string): Promise<string | null> {
  const file = memFiles().get(id)
  if (!file) return null
  try {
    return await decrypt(JSON.parse(file.content) as SyncEnvelope, password)
  } catch {
    return null
  }
}

function lockFiles(): MemFile[] {
  return [...memFiles().values()].filter((f) => f.name === PASSWORD_CHANGE_LOCK_FILE)
}

async function storedPassword(): Promise<string | null> {
  const result = await retrievePasswordResult()
  return result.ok ? result.password : null
}

async function expectAllOn(ids: string[], password: string): Promise<void> {
  for (const [i, id] of ids.entries()) {
    expect(await openWith(id, password)).toBe(DATA[i].plain)
  }
}

async function expectNoLocalChange(): Promise<void> {
  expect(await readChangeState()).toEqual({ kind: 'none' })
  expect((await retrieveChangeKeys()).ok).toBe(false)
}

/** Fails the first upload of `name` with a transfer error. */
function failFirstUploadOf(name: string): void {
  let failed = false
  drive.beforeUpload = (uploadName) => {
    if (uploadName === name && !failed) {
      failed = true
      throw new Error('Drive update failed: 503')
    }
  }
}

describe('sync-password-change', () => {
  beforeEach(async () => {
    userDataRef.dir = await mkdtemp(join(tmpdir(), 'pipette-pwchange-'))
    memFiles().clear()
    drive.seq = 0
    drive.clock = 0
    drive.beforeUpload = null
    drive.beforeDownload = null
    drive.afterCreate = null
    drive.beforeList = null
    drive.beforeDelete = null
    decryptCalls.length = 0
    drive.downloads = []
    drive.uploads = []
    syncRuntime.isSyncing = false
    syncRuntime.isQuitting = false
    syncRuntime.validatedPasswordCheck = null
    syncRuntime.passwordChangeUndecryptable = null
    syncRuntime.passwordChangeLockLost = false
    passwordChangeTuning.chunkSize = 50
    passwordChangeTuning.maxPasses = 3
    mockGetAuthStatus.mockResolvedValue({ authenticated: true })
    vi.spyOn(lockTiming, 'sleep').mockResolvedValue(undefined)
    await storePassword(OLD)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(userDataRef.dir, { recursive: true, force: true })
  })

  describe('startPasswordChange', () => {
    it('re-encrypts every file, the password-check and the stored password, then cleans up', async () => {
      const { pcId, dataIds } = await seedDrive()

      await startPasswordChange(NEW)

      await expectAllOn(dataIds, NEW)
      expect(await openWith(pcId, NEW)).toBe(PC_PAYLOAD)
      expect(await storedPassword()).toBe(NEW)
      expect(lockFiles()).toEqual([])
      expect(syncRuntime.isSyncing).toBe(false)
      await expectNoLocalChange()
      expect(await getPasswordChangeStatus()).toEqual({ kind: 'none' })
    })

    it('keeps the envelope syncUnit when re-encrypting', async () => {
      const { dataIds } = await seedDrive()

      await startPasswordChange(NEW)

      const envelope = JSON.parse(memFiles().get(dataIds[2])!.content) as SyncEnvelope
      expect(envelope.syncUnit).toBe('keyboards/uid1/settings')
    })

    it('creates the password-check when Drive has none', async () => {
      const ids: string[] = []
      for (const d of DATA) ids.push(await seedEncrypted(d.name, d.unit, d.plain, OLD))

      await startPasswordChange(NEW)

      const pc = [...memFiles().values()].find((f) => f.name === PC_NAME)
      expect(pc).toBeDefined()
      expect(await openWith(pc!.id, NEW)).toBe(PC_PAYLOAD)
      await expectAllOn(ids, NEW)
    })

    it('rejects the current password', async () => {
      await seedDrive()
      await expect(startPasswordChange(OLD)).rejects.toThrow('sync.samePassword')
      await expectNoLocalChange()
    })

    it('rejects while a sync is running', async () => {
      syncRuntime.isSyncing = true
      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.changePasswordInProgress')
      expect(syncRuntime.isSyncing).toBe(true)
    })

    it('rejects when a change is already in progress locally', async () => {
      await writeChangeState({ version: 1, target: 'new', step: 'reencrypting', lockId: 'l', lockFileId: 'x', startedAt: 1 })
      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.alreadyInProgress')
    })

    it('requires Google sign-in', async () => {
      mockGetAuthStatus.mockResolvedValue({ authenticated: false })
      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.changePasswordError.unauthenticated')
    })

    it('rejects when the password-check does not open with the current password', async () => {
      const { dataIds } = await seedDrive('someone-else')
      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordMismatch')
      expect(drive.uploads).toEqual([])
      expect(await openWith(dataIds[0], 'someone-else')).toBe(DATA[0].plain)
      await expectNoLocalChange()
    })

    it('stops and cleans up when another machine already holds the lock', async () => {
      const { dataIds } = await seedDrive()
      const foreign = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('foreign'))

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.locked')

      expect(lockFiles().map((f) => f.id)).toEqual([foreign])
      await expectAllOn(dataIds, OLD)
      expect(await storedPassword()).toBe(OLD)
      await expectNoLocalChange()
      expect(syncRuntime.isSyncing).toBe(false)
    })

    it('stops and cleans up when it loses a lock race', async () => {
      const { dataIds } = await seedDrive()
      let foreign = ''
      drive.afterCreate = () => {
        // A peer whose lock Drive created a moment earlier.
        foreign = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('peer'), '2026-10-01T00:00:00.000Z')
      }

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.lost')

      expect(lockFiles().map((f) => f.id)).toEqual([foreign])
      await expectAllOn(dataIds, OLD)
      await expectNoLocalChange()
    })

    it('keeps the state on a transfer failure, and resume completes the change', async () => {
      const { pcId, dataIds } = await seedDrive()
      failFirstUploadOf(DATA[1].name)

      await expect(startPasswordChange(NEW)).rejects.toThrow('Drive update failed: 503')

      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state).toMatchObject({ target: 'new', step: 'reencrypting' })
      expect(lockFiles()).toHaveLength(1)
      expect(await storedPassword()).toBe(OLD)
      expect(await openWith(pcId, OLD)).toBe(PC_PAYLOAD)
      expect(await openWith(dataIds[1], OLD)).toBe(DATA[1].plain)
      expect(syncRuntime.isSyncing).toBe(false)
      const status = await getPasswordChangeStatus()
      expect(status).toMatchObject({ kind: 'inProgress', target: 'new', step: 'reencrypting' })
      expect(JSON.stringify(status)).not.toContain(NEW)
      expect(status).not.toHaveProperty('lockId')

      await resumePasswordChange()

      await expectAllOn(dataIds, NEW)
      expect(await openWith(pcId, NEW)).toBe(PC_PAYLOAD)
      expect(await storedPassword()).toBe(NEW)
      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
    })

    it('holds isSyncing until every started worker has settled', async () => {
      await seedDrive()
      let releaseSlow!: () => void
      const slow = new Promise<void>((resolve) => {
        releaseSlow = resolve
      })
      let slowDone = false
      drive.beforeUpload = async (name) => {
        if (name === DATA[0].name) throw new Error('Drive update failed: 500')
        if (name === DATA[1].name) {
          await slow
          slowDone = true
        }
      }

      let settled = false
      const run = startPasswordChange(NEW).then(
        () => {
          settled = true
        },
        (err: unknown) => {
          settled = true
          throw err
        },
      )
      await vi.waitFor(() => expect(drive.downloads.length).toBeGreaterThanOrEqual(DATA.length + 1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      expect(syncRuntime.isSyncing).toBe(true)

      releaseSlow()
      await expect(run).rejects.toThrow('Drive update failed: 500')
      expect(slowDone).toBe(true)
      expect(syncRuntime.isSyncing).toBe(false)
    })

    it('starts no new work once the app is quitting and keeps the state', async () => {
      passwordChangeTuning.chunkSize = 100
      const ids: string[] = []
      for (let i = 0; i < 25; i++) ids.push(await seedEncrypted(`favorites_f${i}.enc`, `favorites/f${i}`, `{"i":${i}}`, OLD))
      drive.beforeDownload = (id) => {
        if (ids.includes(id)) syncRuntime.isQuitting = true
      }

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.interrupted')

      expect(drive.downloads.filter((id) => ids.includes(id)).length).toBeLessThan(ids.length)
      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
      expect(await storedPassword()).toBe(OLD)
      expect(syncRuntime.isSyncing).toBe(false)
    })

    /** Starts a change whose lock is removed (as another PC's "release lock"
     *  would) during the first upload, so the run stops with `lockLost`. */
    async function startAndLoseLock(): Promise<{ dataIds: string[] }> {
      passwordChangeTuning.chunkSize = 1
      const seeded = await seedDrive()
      let removed = false
      drive.beforeUpload = () => {
        if (removed) return
        removed = true
        for (const lock of lockFiles()) memFiles().delete(lock.id)
      }
      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.lockLost')
      return seeded
    }

    it('stops writing but keeps the keys and state when the lock disappears mid-run', async () => {
      const { dataIds } = await startAndLoseLock()

      // Only the first chunk ran.
      expect(drive.uploads).toEqual([DATA[0].name])
      expect(await openWith(dataIds[1], OLD)).toBe(DATA[1].plain)
      expect(await storedPassword()).toBe(OLD)
      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
      expect((await retrieveChangeKeys()).ok).toBe(true)
      expect(await getPasswordChangeStatus()).toMatchObject({ kind: 'inProgress', step: 'reencrypting', lockLost: true })
    })

    it('resume takes a new lock when no other lock exists and finishes', async () => {
      const { dataIds } = await startAndLoseLock()

      await resumePasswordChange()

      await expectAllOn(dataIds, NEW)
      expect(await storedPassword()).toBe(NEW)
      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
      expect(await getPasswordChangeStatus()).toEqual({ kind: 'none' })
    })

    it('resume fails with locked when another machine holds the lock now', async () => {
      const { dataIds } = await startAndLoseLock()
      const foreign = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('foreign'))

      await expect(resumePasswordChange()).rejects.toThrow('sync.passwordChange.locked')

      expect(lockFiles().map((f) => f.id)).toEqual([foreign])
      expect(await openWith(dataIds[1], OLD)).toBe(DATA[1].plain)
      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
    })

    it('checks the lock on a pass that skips every file', async () => {
      const ids = [await seedEncrypted(DATA[0].name, DATA[0].unit, DATA[0].plain, OLD)]
      drive.beforeUpload = () => {
        // After the only conversion, a peer replaces our lock with its own.
        for (const lock of lockFiles()) memFiles().delete(lock.id)
        addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('foreign'))
      }

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.lockLost')

      expect(await openWith(ids[0], NEW)).toBe(DATA[0].plain)
      expect(await storedPassword()).toBe(OLD)
    })

    it('keeps the locking state when its lost lock cannot be confirmed deleted', async () => {
      await seedDrive()
      drive.afterCreate = () => {
        addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('peer'), '2026-10-01T00:00:00.000Z')
      }
      drive.beforeDelete = () => {
        throw new Error('Drive delete failed: 503')
      }

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.lost')

      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('locking')
      expect(lockFiles()).toHaveLength(2)
    })

    it('writes no state when the keys cannot be stored', async () => {
      await seedDrive()
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)

      await expect(startPasswordChange(NEW)).rejects.toThrow()

      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
      await expectNoLocalChange()
      expect(lockFiles()).toEqual([])
    })

    it('stops before committing when a file opens with neither key; deleting it lets resume finish', async () => {
      const { pcId, dataIds } = await seedDrive()
      const strayId = await seedEncrypted('favorites_combo.enc', 'favorites/combo', '{}', 'third')

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.undecryptable')

      expect(await openWith(pcId, OLD)).toBe(PC_PAYLOAD)
      expect(await storedPassword()).toBe(OLD)
      expect(await openWith(strayId, 'third')).toBe('{}')
      expect(await getPasswordChangeStatus()).toMatchObject({
        kind: 'inProgress',
        step: 'reencrypting',
        undecryptable: [{ id: strayId, name: 'favorites_combo.enc' }],
      })

      const result = await deletePasswordChangeUndecryptableFiles([strayId, dataIds[0], 'missing'])
      expect(result).toEqual({ deleted: [strayId], skipped: [dataIds[0], 'missing'] })
      expect(memFiles().has(strayId)).toBe(false)
      expect(memFiles().has(dataIds[0])).toBe(true)
      expect(await getPasswordChangeStatus()).not.toHaveProperty('undecryptable')

      await resumePasswordChange()
      await expectAllOn(dataIds, NEW)
      expect(await storedPassword()).toBe(NEW)
      await expectNoLocalChange()
    })

    it('fails and keeps the state when files keep changing after the pass limit', async () => {
      passwordChangeTuning.maxPasses = 2
      const { dataIds } = await seedDrive()
      // Another machine keeps writing one file back with the old password.
      drive.beforeList = async () => {
        const file = memFiles().get(dataIds[0])!
        file.content = JSON.stringify(await encrypt(DATA[0].plain, OLD, DATA[0].unit))
        file.modifiedTime = nextTime()
      }

      await expect(startPasswordChange(NEW)).rejects.toThrow('sync.passwordChange.notConverged')
      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
      expect(await storedPassword()).toBe(OLD)
    })
  })

  describe('pass efficiency', () => {
    const countDownloads = (id: string): number => drive.downloads.filter((d) => d === id).length

    it('does not download a file again while its modifiedTime is unchanged', async () => {
      const { dataIds } = await seedDrive()

      await startPasswordChange(NEW)

      for (const id of dataIds) expect(countDownloads(id)).toBe(1)
      await expectAllOn(dataIds, NEW)
    })

    it('re-checks and converts a file a peer rewrote between passes', async () => {
      passwordChangeTuning.chunkSize = 1
      const { dataIds } = await seedDrive()
      let rewritten = false
      drive.beforeUpload = async (name) => {
        if (name !== DATA[2].name || rewritten) return
        rewritten = true
        const file = memFiles().get(dataIds[0])!
        file.content = JSON.stringify(await encrypt(DATA[0].plain, OLD, DATA[0].unit))
        file.modifiedTime = nextTime()
      }

      await startPasswordChange(NEW)

      expect(countDownloads(dataIds[0])).toBe(2)
      expect(countDownloads(dataIds[1])).toBe(1)
      await expectAllOn(dataIds, NEW)
      expect(await storedPassword()).toBe(NEW)
    })

    it('tries the password-check key first on a fresh start, so each file costs one decrypt', async () => {
      await seedDrive()

      await startPasswordChange(NEW)

      for (const d of DATA) {
        expect(decryptCalls.filter(([unit]) => unit === d.unit)).toEqual([[d.unit, OLD]])
      }
    })

    it('tries the target key first when the password-check is already on it', async () => {
      const { pcId, dataIds } = await seedDrive()
      memFiles().get(pcId)!.content = JSON.stringify(await encrypt(PC_PAYLOAD, NEW, 'password-check'))
      for (const [i, d] of DATA.entries()) {
        memFiles().get(dataIds[i])!.content = JSON.stringify(await encrypt(d.plain, NEW, d.unit))
      }
      await storeChangeKeys({ oldPassword: OLD, newPassword: NEW })
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await writeChangeState({ version: 1, target: 'new', step: 'reencrypting', lockId: 'own-lock', lockFileId, startedAt: 1 })

      await resumePasswordChange()

      for (const d of DATA) {
        expect(decryptCalls.filter(([unit]) => unit === d.unit)).toEqual([[d.unit, NEW]])
      }
    })
  })

  describe('resume / revert', () => {
    async function halfConverted(): Promise<{ pcId: string; dataIds: string[] }> {
      const seeded = await seedDrive()
      failFirstUploadOf(DATA[2].name)
      await expect(startPasswordChange(NEW)).rejects.toThrow('503')
      drive.beforeUpload = null
      return seeded
    }

    it('reverts a half-converted Drive to the old password', async () => {
      const { pcId, dataIds } = await halfConverted()
      expect(await openWith(dataIds[0], NEW)).toBe(DATA[0].plain)

      await revertPasswordChange()

      await expectAllOn(dataIds, OLD)
      expect(await openWith(pcId, OLD)).toBe(PC_PAYLOAD)
      expect(await storedPassword()).toBe(OLD)
      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
    })

    it('resume continues a revert that was interrupted', async () => {
      const { dataIds } = await halfConverted()
      failFirstUploadOf(DATA[0].name)
      await expect(revertPasswordChange()).rejects.toThrow('503')
      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state).toMatchObject({ target: 'old', step: 'reencrypting' })

      await resumePasswordChange()

      await expectAllOn(dataIds, OLD)
      expect(await storedPassword()).toBe(OLD)
      await expectNoLocalChange()
    })

    it('accepts a password-check that already opens with the new key', async () => {
      const { pcId, dataIds } = await halfConverted()
      memFiles().get(pcId)!.content = JSON.stringify(await encrypt(PC_PAYLOAD, NEW, 'password-check'))

      await resumePasswordChange()

      await expectAllOn(dataIds, NEW)
      expect(await storedPassword()).toBe(NEW)
    })

    it('refuses to run when the password-check opens with neither key', async () => {
      const { pcId } = await halfConverted()
      memFiles().get(pcId)!.content = JSON.stringify(await encrypt(PC_PAYLOAD, 'third', 'password-check'))

      await expect(resumePasswordChange()).rejects.toThrow('sync.passwordMismatch')
      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
    })

    it('does not revert once committing has started', async () => {
      await storeChangeKeys({ oldPassword: OLD, newPassword: NEW })
      await writeChangeState({ version: 1, target: 'new', step: 'committing', lockId: 'l', lockFileId: 'x', startedAt: 1 })
      await expect(revertPasswordChange()).rejects.toThrow('sync.passwordChange.wrongStep')
    })

    it('falls back to reencrypting when the pre-commit check finds a file neither key opens', async () => {
      const { pcId, dataIds } = await seedDrive()
      for (const [i, d] of DATA.entries()) {
        memFiles().get(dataIds[i])!.content = JSON.stringify(await encrypt(d.plain, NEW, d.unit))
      }
      const strayId = await seedEncrypted('favorites_combo.enc', 'favorites/combo', '{}', 'third')
      await storeChangeKeys({ oldPassword: OLD, newPassword: NEW })
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await writeChangeState({ version: 1, target: 'new', step: 'committing', lockId: 'own-lock', lockFileId, startedAt: 1 })

      await expect(resumePasswordChange()).rejects.toThrow('sync.passwordChange.undecryptable')

      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
      expect(await openWith(pcId, OLD)).toBe(PC_PAYLOAD)
      expect(await deletePasswordChangeUndecryptableFiles([strayId])).toEqual({ deleted: [strayId], skipped: [] })

      await resumePasswordChange()

      await expectAllOn(dataIds, NEW)
      expect(await storedPassword()).toBe(NEW)
      await expectNoLocalChange()
    })

    it('resumes the cleanup step without the keys', async () => {
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await writeChangeState({ version: 1, target: 'new', step: 'cleanup', lockId: 'own-lock', lockFileId, startedAt: 1 })

      await resumePasswordChange()

      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
    })

    it('abandons a change stuck in locking without the keys', async () => {
      addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await writeChangeState({ version: 1, target: 'new', step: 'locking', lockId: 'own-lock', startedAt: 1 })

      await expect(resumePasswordChange()).rejects.toThrow('sync.passwordChange.notStarted')

      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
    })

    it('refuses resume / revert when no change is in progress', async () => {
      await expect(resumePasswordChange()).rejects.toThrow('sync.passwordChange.notInProgress')
      await expect(revertPasswordChange()).rejects.toThrow('sync.passwordChange.notInProgress')
    })

    it('refuses to delete files outside the re-encrypting step', async () => {
      await expect(deletePasswordChangeUndecryptableFiles(['x'])).rejects.toThrow('sync.passwordChange.notInProgress')
    })
  })

  describe('abandonPasswordChange', () => {
    it('releases the lock and forgets the change without the keys, leaving Drive data as it is', async () => {
      const { pcId, dataIds } = await seedDrive()
      const foreign = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('foreign'), '2026-10-03T00:00:00.000Z')
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await writeChangeState({ version: 1, target: 'new', step: 'reencrypting', lockId: 'own-lock', lockFileId, startedAt: 1 })

      await abandonPasswordChange()

      expect(lockFiles().map((f) => f.id)).toEqual([foreign])
      await expectNoLocalChange()
      await expectAllOn(dataIds, OLD)
      expect(await openWith(pcId, OLD)).toBe(PC_PAYLOAD)
      expect(await storedPassword()).toBe(OLD)
    })

    it('finds its lock by lockId when the file id was never saved', async () => {
      addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await storeChangeKeys({ oldPassword: OLD, newPassword: NEW })
      await writeChangeState({ version: 1, target: 'new', step: 'locking', lockId: 'own-lock', startedAt: 1 })

      await abandonPasswordChange()

      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
    })

    it('still forgets the change when the lock cannot be released', async () => {
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await writeChangeState({ version: 1, target: 'new', step: 'reencrypting', lockId: 'own-lock', lockFileId, startedAt: 1 })
      drive.beforeDelete = () => {
        throw new Error('Drive delete failed: 503')
      }

      await abandonPasswordChange()

      await expectNoLocalChange()
    })

    it('clears an unreadable state file', async () => {
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(join(userDataRef.dir, 'local', 'auth'), { recursive: true })
      await writeFile(join(userDataRef.dir, 'local', 'auth', 'sync-password-change.json'), '{broken')

      await abandonPasswordChange()

      await expectNoLocalChange()
    })

    it('refuses when no change is in progress', async () => {
      await expect(abandonPasswordChange()).rejects.toThrow('sync.passwordChange.notInProgress')
    })
  })

  describe('recoverPasswordChangeOnStartup', () => {
    async function seedLocal(state: Omit<PasswordChangeState, 'version' | 'lockId' | 'startedAt'>): Promise<void> {
      await storeChangeKeys({ oldPassword: OLD, newPassword: NEW })
      await writeChangeState({ version: 1, lockId: 'own-lock', startedAt: 1, ...state })
    }

    it('does nothing without a state file', async () => {
      expect(await recoverPasswordChangeOnStartup()).toBe('none')
    })

    it('removes keys left without a state file', async () => {
      await storeChangeKeys({ oldPassword: OLD, newPassword: NEW })

      expect(await recoverPasswordChangeOnStartup()).toBe('none')

      expect((await retrieveChangeKeys()).ok).toBe(false)
    })

    it('reports an unreadable state file and leaves Drive alone', async () => {
      const { dataIds } = await seedDrive()
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(join(userDataRef.dir, 'local', 'auth'), { recursive: true })
      await writeFile(join(userDataRef.dir, 'local', 'auth', 'sync-password-change.json'), '{broken')

      expect(await recoverPasswordChangeOnStartup()).toBe('invalid')
      expect(await getPasswordChangeStatus()).toEqual({ kind: 'invalid' })
      expect(drive.uploads).toEqual([])
      await expectAllOn(dataIds, OLD)
    })

    it('verifies every data file before finishing a change that stopped while committing', async () => {
      const { pcId } = await seedDrive()
      const dataIds: string[] = []
      // DATA[2] stays on the old key, as if a peer wrote it back.
      for (const d of DATA.slice(0, 2)) {
        const file = [...memFiles().values()].find((f) => f.name === d.name)!
        file.content = JSON.stringify(await encrypt(d.plain, NEW, d.unit))
        dataIds.push(file.id)
      }
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      dataIds.push([...memFiles().values()].find((f) => f.name === DATA[2].name)!.id)
      await seedLocal({ target: 'new', step: 'committing', lockFileId })

      expect(await recoverPasswordChangeOnStartup()).toBe('completed')

      await expectAllOn(dataIds, NEW)
      expect(await openWith(pcId, NEW)).toBe(PC_PAYLOAD)
      expect(await storedPassword()).toBe(NEW)
      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
      expect(syncRuntime.isSyncing).toBe(false)
    })

    it('finishes the cleanup step', async () => {
      await seedDrive(NEW)
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await seedLocal({ target: 'new', step: 'cleanup', lockFileId })

      expect(await recoverPasswordChangeOnStartup()).toBe('completed')
      expect(lockFiles()).toEqual([])
      await expectNoLocalChange()
    })

    it('removes its own lock when the change stopped while locking', async () => {
      const foreign = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('foreign'))
      addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await seedLocal({ target: 'new', step: 'locking' })

      expect(await recoverPasswordChangeOnStartup()).toBe('abandoned')

      expect(lockFiles().map((f) => f.id)).toEqual([foreign])
      await expectNoLocalChange()
      expect(await storedPassword()).toBe(OLD)
    })

    it('waits for the user while re-encrypting and the lock is still held', async () => {
      const { dataIds } = await seedDrive()
      const lockFileId = addFile(PASSWORD_CHANGE_LOCK_FILE, lockText('own-lock', 'hash-own'))
      await seedLocal({ target: 'new', step: 'reencrypting', lockFileId })

      expect(await recoverPasswordChangeOnStartup()).toBe('awaitingUser')

      expect(drive.uploads).toEqual([])
      await expectAllOn(dataIds, OLD)
      expect((await readChangeState()).kind).toBe('ok')
    })

    it('keeps the local state and reports it when the lock is gone', async () => {
      await seedDrive()
      await seedLocal({ target: 'new', step: 'reencrypting', lockFileId: 'gone' })

      expect(await recoverPasswordChangeOnStartup()).toBe('lockLost')

      const read = await readChangeState()
      expect(read.kind === 'ok' && read.state.step).toBe('reencrypting')
      expect((await retrieveChangeKeys()).ok).toBe(true)
      expect(await getPasswordChangeStatus()).toMatchObject({ kind: 'inProgress', lockLost: true })
    })

    it('reports missing keys in the status', async () => {
      await writeChangeState({ version: 1, target: 'new', step: 'reencrypting', lockId: 'l', lockFileId: 'x', startedAt: 5 })
      expect(await getPasswordChangeStatus()).toEqual({
        kind: 'keysUnavailable',
        reason: 'noPasswordFile',
        target: 'new',
        step: 'reencrypting',
        startedAt: 5,
      })
    })
  })
})
