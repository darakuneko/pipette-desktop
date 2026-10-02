// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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
  app: {
    getPath: () => userDataRef.dir,
  },
}))

vi.mock('../../logger', () => ({ log: vi.fn() }))

import { safeStorage } from 'electron'
import { log } from '../../logger'
import {
  storeChangeKeys,
  retrieveChangeKeys,
  clearChangeKeys,
  readChangeState,
  writeChangeState,
  clearChangeState,
  hasChangeState,
  forgetChangeStateCache,
  type PasswordChangeState,
} from '../sync-password-change-state'

const KEYS = { oldPassword: 'old-pw', newPassword: 'new-pw' }
const KEYS_FILE = 'sync-password-change-keys.enc'
const STATE_FILE = 'sync-password-change.json'

const VALID_STATE: PasswordChangeState = {
  version: 1,
  target: 'new',
  step: 'reencrypting',
  lockId: 'lock-123',
  lockFileId: 'drive-file-1',
  startedAt: 1_700_000_000_000,
}

const INVALID_STATES: Array<[string, unknown]> = [
  ['a non-object', 'string'],
  ['null', null],
  ['an array', [VALID_STATE]],
  ['an unknown version', { ...VALID_STATE, version: 2 }],
  ['an unknown target', { ...VALID_STATE, target: 'both' }],
  ['an unknown step', { ...VALID_STATE, step: 'done' }],
  ['an empty lockId', { ...VALID_STATE, lockId: '' }],
  ['a numeric lockId', { ...VALID_STATE, lockId: 42 }],
  ['a non-string lockFileId', { ...VALID_STATE, lockFileId: 7 }],
  ['an empty lockFileId', { ...VALID_STATE, lockFileId: '' }],
  ['a string startedAt', { ...VALID_STATE, startedAt: '1700000000000' }],
  ['a NaN startedAt', { ...VALID_STATE, startedAt: Number.NaN }],
  ['a negative startedAt', { ...VALID_STATE, startedAt: -1 }],
  ['a missing lockId', { version: 1, target: 'new', step: 'locking', startedAt: 1 }],
]

function authDir(): string {
  return join(userDataRef.dir, 'local', 'auth')
}

async function writeAuthFile(name: string, content: string | Buffer): Promise<void> {
  await mkdir(authDir(), { recursive: true })
  await writeFile(join(authDir(), name), content)
}

/** Turn `name` into a directory so unlink/rm fail with something other than ENOENT. */
async function blockWithDirectory(name: string): Promise<void> {
  await mkdir(join(authDir(), name), { recursive: true })
}

describe('sync-password-change-state', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    userDataRef.dir = await mkdtemp(join(tmpdir(), 'sync-password-change-state-'))
  })

  afterEach(async () => {
    await rm(userDataRef.dir, { recursive: true, force: true })
  })

  describe('change keys', () => {
    it('stores both keys in one encrypted file and retrieves them', async () => {
      await storeChangeKeys(KEYS)

      expect(await retrieveChangeKeys()).toEqual({ ok: true, keys: KEYS })
      expect(await readdir(authDir())).toEqual([KEYS_FILE])
      expect(safeStorage.encryptString).toHaveBeenCalledTimes(1)
    })

    it('reports a missing file', async () => {
      expect(await retrieveChangeKeys()).toEqual({ ok: false, reason: 'noPasswordFile' })
    })

    it('reports an undecryptable file', async () => {
      await writeAuthFile(KEYS_FILE, Buffer.from('garbage'))

      expect(await retrieveChangeKeys()).toEqual({ ok: false, reason: 'decryptFailed' })
    })

    it('reports the keystore as unavailable when it cannot decrypt yet', async () => {
      await storeChangeKeys(KEYS)
      vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => {
        throw new Error('keyring locked')
      })
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)

      expect(await retrieveChangeKeys()).toEqual({ ok: false, reason: 'keystoreUnavailable' })
    })

    it.each<[string, string]>([
      ['not JSON', 'enc:{nope'],
      ['a JSON array', `enc:${JSON.stringify([KEYS])}`],
      ['a missing newPassword', `enc:${JSON.stringify({ oldPassword: 'old-pw' })}`],
      ['a non-string oldPassword', `enc:${JSON.stringify({ ...KEYS, oldPassword: 1 })}`],
      ['an empty newPassword', `enc:${JSON.stringify({ ...KEYS, newPassword: '' })}`],
    ])('reports invalid content for %s', async (_label, content) => {
      await writeAuthFile(KEYS_FILE, content)

      expect(await retrieveChangeKeys()).toEqual({ ok: false, reason: 'invalidContent' })
    })

    it('storeChangeKeys throws and writes nothing when safeStorage is unavailable', async () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)

      await expect(storeChangeKeys(KEYS)).rejects.toThrow('not available')
      expect(await retrieveChangeKeys()).toEqual({ ok: false, reason: 'noPasswordFile' })
    })

    it.each<[string, unknown]>([
      ['an empty oldPassword', { ...KEYS, oldPassword: '' }],
      ['an empty newPassword', { ...KEYS, newPassword: '' }],
      ['a non-string newPassword', { ...KEYS, newPassword: 1 }],
    ])('storeChangeKeys throws for %s and leaves the existing file unchanged', async (_label, value) => {
      await storeChangeKeys(KEYS)
      vi.mocked(safeStorage.encryptString).mockClear()

      await expect(storeChangeKeys(value as typeof KEYS)).rejects.toThrow()
      expect(safeStorage.encryptString).not.toHaveBeenCalled()
      expect(await retrieveChangeKeys()).toEqual({ ok: true, keys: KEYS })
    })

    it('clearChangeKeys removes the file and is idempotent', async () => {
      await storeChangeKeys(KEYS)
      await clearChangeKeys()

      expect(await readdir(authDir())).toEqual([])
      await expect(clearChangeKeys()).resolves.toBeUndefined()
    })

    it('clearChangeKeys rethrows errors other than ENOENT', async () => {
      await blockWithDirectory(KEYS_FILE)

      await expect(clearChangeKeys()).rejects.toThrow()
    })
  })

  describe('change state file', () => {
    it('round-trips a state through write and read', async () => {
      await writeChangeState(VALID_STATE)

      expect(await readChangeState()).toEqual({ kind: 'ok', state: VALID_STATE })
      expect(await readdir(authDir())).toEqual([STATE_FILE])
    })

    it('round-trips a state without lockFileId', async () => {
      const { lockFileId: _omit, ...withoutFileId } = VALID_STATE
      const state: PasswordChangeState = { ...withoutFileId, target: 'old', step: 'locking' }
      await writeChangeState(state)

      expect(await readChangeState()).toEqual({ kind: 'ok', state })
    })

    it('drops unknown keys instead of rejecting the file', async () => {
      await writeAuthFile(STATE_FILE, JSON.stringify({ ...VALID_STATE, extra: true }))

      expect(await readChangeState()).toEqual({ kind: 'ok', state: VALID_STATE })
    })

    it('reports none without a warning when the file is missing', async () => {
      expect(await readChangeState()).toEqual({ kind: 'none' })
      expect(log).not.toHaveBeenCalled()
    })

    it('reports invalid and warns when the JSON is malformed', async () => {
      await writeAuthFile(STATE_FILE, '{not json')

      expect(await readChangeState()).toEqual({ kind: 'invalid' })
      expect(log).toHaveBeenCalledWith('warn', expect.any(String))
    })

    it('reports invalid and warns when the file cannot be read', async () => {
      await blockWithDirectory(STATE_FILE)

      expect(await readChangeState()).toEqual({ kind: 'invalid' })
      expect(log).toHaveBeenCalledWith('warn', expect.any(String))
    })

    it.each(INVALID_STATES)('reports invalid and warns for %s on read', async (_label, value) => {
      await writeAuthFile(STATE_FILE, JSON.stringify(value))

      expect(await readChangeState()).toEqual({ kind: 'invalid' })
      expect(log).toHaveBeenCalledWith('warn', expect.any(String))
    })

    it.each(INVALID_STATES)('writeChangeState throws for %s and writes nothing', async (_label, value) => {
      await expect(writeChangeState(value as PasswordChangeState)).rejects.toThrow()
      expect(await readChangeState()).toEqual({ kind: 'none' })
    })

    it('clearChangeState removes the file and is idempotent', async () => {
      await writeChangeState(VALID_STATE)
      await clearChangeState()

      expect(await readChangeState()).toEqual({ kind: 'none' })
      await expect(clearChangeState()).resolves.toBeUndefined()
    })

    it('clearChangeState is a no-op when the auth directory does not exist', async () => {
      await expect(clearChangeState()).resolves.toBeUndefined()
    })

    it('clearChangeState rethrows errors other than ENOENT', async () => {
      await blockWithDirectory(STATE_FILE)

      await expect(clearChangeState()).rejects.toThrow()
    })
  })

  describe('hasChangeState', () => {
    const statePath = (): string => join(userDataRef.dir, 'local', 'auth', STATE_FILE)

    it('follows writeChangeState and clearChangeState', async () => {
      expect(await hasChangeState()).toBe(false)
      await writeChangeState(VALID_STATE)
      expect(await hasChangeState()).toBe(true)
      await clearChangeState()
      expect(await hasChangeState()).toBe(false)
    })

    it('counts an unreadable state file as a change in progress', async () => {
      await mkdir(join(userDataRef.dir, 'local', 'auth'), { recursive: true })
      await writeFile(statePath(), '{broken')
      forgetChangeStateCache()

      expect(await hasChangeState()).toBe(true)
    })

    it('keeps its answer until the cache is forgotten', async () => {
      expect(await hasChangeState()).toBe(false)
      await mkdir(join(userDataRef.dir, 'local', 'auth'), { recursive: true })
      await writeFile(statePath(), JSON.stringify(VALID_STATE))

      expect(await hasChangeState()).toBe(false)
      forgetChangeStateCache()
      expect(await hasChangeState()).toBe(true)
    })

    it('does not keep a read that overlapped a write', async () => {
      const overlapping = hasChangeState()
      await writeChangeState(VALID_STATE)
      await overlapping

      expect(await hasChangeState()).toBe(true)
    })
  })
})
