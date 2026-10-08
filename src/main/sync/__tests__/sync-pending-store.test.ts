// SPDX-License-Identifier: GPL-2.0-or-later
//
// The pending sync units kept on disk (sync-pending-store.ts) and kept
// apart per Google account (sync-pending-account.ts), on the real
// sync-runtime-state and a temporary userData directory.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

const mockGetAccountSub = vi.fn(async (): Promise<string | null> => null)
const mockSignOut = vi.fn(async (): Promise<void> => {})
vi.mock('../google-auth', () => ({
  getAccountSub: () => mockGetAccountSub(),
  signOut: () => mockSignOut(),
}))

const mockForgetAccountCaches = vi.fn()
vi.mock('../sync-account-caches', () => ({
  forgetAccountCaches: () => mockForgetAccountCaches(),
}))

import {
  syncRuntime,
  markPending,
  settlePending,
  pendingGenerationOf,
  snapshotPendingGenerations,
  cancelPendingChanges,
  copyPendingState,
  restoreCancelledPending,
  claimSyncLock,
  claimSyncLockBy,
  resetSyncRuntimeForTests,
} from '../sync-runtime-state'
import { PENDING_WRITE_DELAY_MS, restorePendingFromDisk, resetPendingStoreForTests } from '../sync-pending-store'
import {
  ACCOUNT_SWITCH_BUSY_MESSAGE,
  ACCOUNT_SWITCH_WAIT_MS,
  AccountSwitchBusyError,
  adoptPendingForSignedInAccount,
  markPendingFor,
  signOutKeepingPending,
  signOutKeepingPendingLocked,
  switchAccountKeepingPending,
} from '../sync-pending-account'

interface PendingFile {
  version: number
  owner: string | null
  units: string[]
  held: Record<string, string[]>
}

const pendingPath = (): string => join(userData, 'local', 'sync-pending.json')

function readFile(): PendingFile {
  return JSON.parse(readFileSync(pendingPath(), 'utf-8')) as PendingFile
}

function writeFile(content: unknown): void {
  mkdirSync(join(userData, 'local'), { recursive: true })
  writeFileSync(pendingPath(), typeof content === 'string' ? content : JSON.stringify(content))
}

function addKeyboardDir(uid: string): void {
  mkdirSync(join(userData, 'sync', 'keyboards', uid), { recursive: true })
}

/** Simulates a restart: the in-memory state is gone, the file stays. */
function restart(): void {
  resetPendingStoreForTests()
  resetSyncRuntimeForTests()
}

/** Restores from the file and lets the write-back run. */
function launch(): void {
  restorePendingFromDisk()
  vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)
}

const active = (): string[] => [...syncRuntime.pendingChanges].sort()
const held = (sub: string): string[] => [...(syncRuntime.heldPending.get(sub) ?? [])].sort()
const pendingState = (): unknown => ({ owner: syncRuntime.pendingOwner, units: active(), held: Object.fromEntries(syncRuntime.heldPending) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  userData = mkdtempSync(join(tmpdir(), 'sync-pending-store-test-'))
  restart()
})

afterEach(() => {
  restart()
  vi.useRealTimers()
  rmSync(userData, { recursive: true, force: true })
})

describe('writing the pending state', () => {
  beforeEach(() => {
    launch()
  })

  it('writes the units marked pending once the write delay passes, in one write', () => {
    markPending('favorites/tapDance')
    markPending('favorites/macro')
    expect(readFile().units).toEqual([])

    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    expect(readFile()).toEqual({ version: 1, owner: null, units: ['favorites/tapDance', 'favorites/macro'], held: {} })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules no write when a unit already pending changes again', () => {
    markPending('favorites/tapDance')
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)
    const generation = pendingGenerationOf('favorites/tapDance')

    markPending('favorites/tapDance')

    expect(vi.getTimerCount()).toBe(0)
    expect(pendingGenerationOf('favorites/tapDance')).toBeGreaterThan(generation)
  })

  it('writes a settled unit out of the file', () => {
    markPending('favorites/tapDance')
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    settlePending('favorites/tapDance', pendingGenerationOf('favorites/tapDance'))
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    expect(readFile().units).toEqual([])
  })

  it('writes again after the directory is removed', () => {
    rmSync(join(userData, 'local'), { recursive: true, force: true })

    markPending('favorites/tapDance')
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    expect(readFile().units).toEqual(['favorites/tapDance'])
  })

  it('writes a cancel of several prefixes at once, held units of other accounts included', () => {
    syncRuntime.heldPending.set('account-a', new Set(['keyboards/uid1/settings', 'favorites/macro']))
    syncRuntime.heldPending.set('account-b', new Set(['themes/index']))
    markPending('keyboards/uid1/snapshots')
    markPending('favorites/tapDance')
    markPending('i18n/index')

    cancelPendingChanges(['keyboards/uid1/', 'themes/', 'i18n/'])

    expect(readFile()).toEqual({
      version: 1,
      owner: null,
      units: ['favorites/tapDance'],
      held: { 'account-a': ['favorites/macro'] },
    })
    expect(held('account-a')).toEqual(['favorites/macro'])
    expect(syncRuntime.heldPending.has('account-b')).toBe(false)
  })

  it('cancels everything, held units included, without prefixes', () => {
    syncRuntime.heldPending.set('account-a', new Set(['favorites/macro']))
    markPending('favorites/tapDance')

    cancelPendingChanges()

    expect(readFile()).toEqual({ version: 1, owner: null, units: [], held: {} })
    expect(syncRuntime.heldPending.size).toBe(0)
  })

  it('writes nothing when no unit matches', () => {
    markPending('favorites/tapDance')
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)
    rmSync(pendingPath())

    cancelPendingChanges(['keyboards/'])
    cancelPendingChanges([])

    expect(existsSync(pendingPath())).toBe(false)
    expect(active()).toEqual(['favorites/tapDance'])
  })

  it('writes anyway when asked to, so a disk failure shows before a reset removes anything', () => {
    rmSync(pendingPath())
    mkdirSync(join(pendingPath(), 'blocker'), { recursive: true })

    expect(() => cancelPendingChanges(['keyboards/'])).not.toThrow()
    expect(() => cancelPendingChanges(['keyboards/'], { writeAlways: true })).toThrow()
  })

  it('throws and keeps the pending state when a cancel cannot be written', () => {
    markPending('keyboards/uid1/settings')
    const generation = pendingGenerationOf('keyboards/uid1/settings')
    syncRuntime.heldPending.set('account-a', new Set(['keyboards/uid1/snapshots']))
    rmSync(pendingPath())
    // A non-empty directory in the file's place makes the rename fail.
    mkdirSync(join(pendingPath(), 'blocker'), { recursive: true })

    expect(() => cancelPendingChanges(['keyboards/uid1/'])).toThrow()

    expect(active()).toEqual(['keyboards/uid1/settings'])
    expect(pendingGenerationOf('keyboards/uid1/settings')).toBe(generation)
    expect(held('account-a')).toEqual(['keyboards/uid1/snapshots'])
    expect(readdirSync(join(userData, 'local')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes again after a failed write, even for a unit already pending', () => {
    markPending('favorites/tapDance')
    rmSync(pendingPath())
    const blocker = join(pendingPath(), 'blocker')
    mkdirSync(blocker, { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    rmSync(pendingPath(), { recursive: true })
    markPending('favorites/tapDance')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    expect(readFile().units).toEqual(['favorites/tapDance'])
    // Written again, a unit already pending schedules nothing.
    markPending('favorites/tapDance')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a cancelled unit out after a restart', () => {
    addKeyboardDir('uid1')
    markPending('keyboards/uid1/settings')
    markPending('favorites/tapDance')
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    cancelPendingChanges(['keyboards/uid1/'])
    restart()
    launch()

    expect(active()).toEqual(['favorites/tapDance'])
  })
})

describe('putting the pending state back', () => {
  it('puts back the cancelled active units with their generations and the held units, and writes them', () => {
    const original = { version: 1, owner: 'account-a', units: ['favorites/tapDance', 'keyboards/uid1/settings'], held: { 'account-b': ['favorites/macro', 'keyboards/uid1/snapshots'] } }
    addKeyboardDir('uid1')
    writeFile(original)
    launch()
    const generations = snapshotPendingGenerations()
    const copy = copyPendingState()

    cancelPendingChanges(['favorites/'], { writeAlways: true })
    expect(readFile()).toEqual({ version: 1, owner: 'account-a', units: ['keyboards/uid1/settings'], held: { 'account-b': ['keyboards/uid1/snapshots'] } })

    restoreCancelledPending(copy)

    expect(active()).toEqual(['favorites/tapDance', 'keyboards/uid1/settings'])
    expect(snapshotPendingGenerations()).toEqual(generations)
    expect(held('account-b')).toEqual(['favorites/macro', 'keyboards/uid1/snapshots'])
    expect(syncRuntime.pendingOwner).toBe('account-a')
    const file = readFile()
    expect({ ...file, units: [...file.units].sort(), held: { 'account-b': [...file.held['account-b']].sort() } }).toEqual(original)
  })

  it('keeps units marked after the copy, with their newer generation', () => {
    writeFile({ version: 1, owner: 'account-a', units: ['favorites/tapDance', 'favorites/macro'], held: {} })
    launch()
    const copy = copyPendingState()

    cancelPendingChanges(['favorites/'], { writeAlways: true })
    markPending('favorites/macro')
    markPending('favorites/combo')
    const newer = pendingGenerationOf('favorites/macro')

    restoreCancelledPending(copy)

    expect(active()).toEqual(['favorites/combo', 'favorites/macro', 'favorites/tapDance'])
    expect(pendingGenerationOf('favorites/macro')).toBe(newer)
    expect(pendingGenerationOf('favorites/tapDance')).toBe(copy.generations.get('favorites/tapDance'))
    expect([...readFile().units].sort()).toEqual(['favorites/combo', 'favorites/macro', 'favorites/tapDance'])
  })
})

describe('waiting for the sync lock', () => {
  it('refuses a lock held with no pass to wait for', async () => {
    syncRuntime.isSyncing = true

    await expect(claimSyncLockBy(Date.now() + 1000)).rejects.toThrow()
  })

  it('gives up at the deadline and takes the lock once it is free in time', async () => {
    const releasePass = claimSyncLock()
    const giveUp = claimSyncLockBy(Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await giveUp).toBeNull()

    const waiting = claimSyncLockBy(Date.now() + 1000)
    releasePass()
    const release = await waiting
    expect(release).toBeTypeOf('function')
    release?.()
  })
})

describe('without a restore (persistence not registered)', () => {
  it('writes nothing for a change, a settle, a cancel or a runtime reset', () => {
    markPending('favorites/tapDance')
    settlePending('favorites/tapDance', pendingGenerationOf('favorites/tapDance'))
    markPending('favorites/macro')
    cancelPendingChanges()
    resetSyncRuntimeForTests()
    vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)

    expect(existsSync(pendingPath())).toBe(false)
  })
})

describe('restoring the pending state at startup', () => {
  it('restores nothing from a missing file', () => {
    launch()

    expect(pendingState()).toEqual({ owner: null, units: [], held: {} })
  })

  it.each([
    ['corrupt JSON', '{"version":1,'],
    ['another version', { version: 2, owner: null, units: ['favorites/tapDance'], held: {} }],
    ['units that are not a list', { version: 1, owner: null, units: 'favorites/tapDance', held: {} }],
    ['a non-object', [1, 2]],
  ])('restores nothing from %s', (_name, content) => {
    writeFile(content)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    launch()
    warn.mockRestore()

    expect(pendingState()).toEqual({ owner: null, units: [], held: {} })
  })

  it('drops units with an unsafe segment', () => {
    writeFile({
      version: 1,
      owner: null,
      units: ['favorites/tapDance', 'favorites/../x', 'favorites//macro', '', 7, 'meta/keyboard-names', 'a\\b'],
      held: {},
    })

    launch()

    expect(active()).toEqual(['favorites/tapDance', 'meta/keyboard-names'])
  })

  it('drops the units of a keyboard whose directory is gone, keeps the others, and writes the drop back', () => {
    addKeyboardDir('uid1')
    writeFile({
      version: 1,
      owner: 'account-a',
      units: ['keyboards/uid1/settings', 'keyboards/uid2/settings', 'keyboards/uid2/devices/h/days/2026-10-01', 'favorites/tapDance'],
      held: { 'account-b': ['keyboards/uid2/snapshots', 'keyboards/uid1/snapshots'], 'account-c': ['keyboards/uid2/settings'] },
    })

    launch()

    expect(readFile()).toEqual({
      version: 1,
      owner: 'account-a',
      units: ['keyboards/uid1/settings', 'favorites/tapDance'],
      held: { 'account-b': ['keyboards/uid1/snapshots'] },
    })
  })

  it.skipIf(process.getuid?.() === 0)('leaves a file it cannot read as it is and keeps the changes in memory', () => {
    const content = JSON.stringify({ version: 1, owner: 'account-a', units: ['favorites/tapDance'], held: {} })
    writeFile(content)
    chmodSync(pendingPath(), 0o000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      launch()
      markPending('favorites/macro')
      vi.advanceTimersByTime(PENDING_WRITE_DELAY_MS)
      cancelPendingChanges()

      expect(warn).toHaveBeenCalled()
      chmodSync(pendingPath(), 0o600)
      expect(readFileSync(pendingPath(), 'utf-8')).toBe(content)
    } finally {
      chmodSync(pendingPath(), 0o600)
      warn.mockRestore()
    }
  })

  it.skipIf(process.getuid?.() === 0)('refuses a reset\'s cancel while the file cannot be read', () => {
    writeFile({ version: 1, owner: null, units: ['favorites/tapDance'], held: {} })
    chmodSync(pendingPath(), 0o000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      launch()
      markPending('favorites/macro')

      expect(() => cancelPendingChanges(['favorites/'], { writeAlways: true })).toThrow(/cannot be read/)
      expect(active()).toEqual(['favorites/macro'])
      expect(() => cancelPendingChanges(['favorites/'])).not.toThrow()
    } finally {
      chmodSync(pendingPath(), 0o600)
      warn.mockRestore()
    }
  })

  it('reads an owner that is not a string as none', () => {
    writeFile({ version: 1, owner: 42, units: ['favorites/tapDance'], held: [] })

    launch()

    expect(pendingState()).toEqual({ owner: null, units: ['favorites/tapDance'], held: {} })
  })

  it('joins the restored units to those already pending', () => {
    writeFile({ version: 1, owner: 'account-a', units: ['favorites/tapDance'], held: { 'account-b': ['favorites/macro'] } })
    markPending('meta/keyboard-names')

    launch()

    expect(active()).toEqual(['favorites/tapDance', 'meta/keyboard-names'])
    expect(syncRuntime.pendingOwner).toBe('account-a')
    expect(held('account-b')).toEqual(['favorites/macro'])
  })
})

describe('the account the pending units belong to', () => {
  function startWith(file: Omit<PendingFile, 'version'>): void {
    writeFile({ version: 1, ...file })
    launch()
  }

  async function signInAs(sub: string | null): Promise<string | null> {
    mockGetAccountSub.mockResolvedValueOnce(sub)
    return adoptPendingForSignedInAccount()
  }

  describe('handing the units to the signed-in account', () => {
    it('holds units changed under another account for it', async () => {
      startWith({ owner: 'account-a', units: ['favorites/tapDance'], held: {} })

      expect(await signInAs('account-b')).toBe('account-b')

      expect(active()).toEqual([])
      expect(readFile()).toEqual({ version: 1, owner: 'account-b', units: [], held: { 'account-a': ['favorites/tapDance'] } })
    })

    it('gives units changed while signed out to the signed-in account', async () => {
      startWith({ owner: null, units: ['favorites/tapDance'], held: {} })

      await signInAs('account-b')

      expect(active()).toEqual(['favorites/tapDance'])
      expect(readFile().owner).toBe('account-b')
    })

    it('makes the units held for the signed-in account active again', async () => {
      startWith({ owner: 'account-b', units: ['favorites/macro'], held: { 'account-a': ['favorites/tapDance'] } })

      await signInAs('account-a')

      expect(pendingState()).toEqual({ owner: 'account-a', units: ['favorites/tapDance'], held: { 'account-b': new Set(['favorites/macro']) } })
      expect(readFile()).toEqual({ version: 1, owner: 'account-a', units: ['favorites/tapDance'], held: { 'account-b': ['favorites/macro'] } })
    })

    it('writes nothing when the units already belong to the signed-in account', async () => {
      startWith({ owner: 'account-a', units: ['favorites/tapDance'], held: {} })
      rmSync(pendingPath())

      await signInAs('account-a')

      expect(existsSync(pendingPath())).toBe(false)
      expect(active()).toEqual(['favorites/tapDance'])
    })

    it('changes nothing when the account carries no id or nobody is signed in', async () => {
      startWith({ owner: 'account-a', units: ['favorites/tapDance'], held: { 'account-b': ['favorites/macro'] } })
      rmSync(pendingPath())

      expect(await signInAs(null)).toBeNull()

      expect(existsSync(pendingPath())).toBe(false)
      expect(syncRuntime.pendingOwner).toBe('account-a')
      expect(active()).toEqual(['favorites/tapDance'])
    })
  })

  describe('switching to a new sign-in', () => {
    const blockWrites = (): void => {
      rmSync(pendingPath(), { force: true })
      mkdirSync(join(pendingPath(), 'blocker'), { recursive: true })
    }

    it('stores the new tokens only after the running pass ends, holding the lock, then hands the units over', async () => {
      startWith({ owner: 'account-a', units: ['favorites/tapDance'], held: {} })
      const releasePass = claimSyncLock()
      let lockedWhileStoring = false
      const storeTokens = vi.fn(async () => {
        lockedWhileStoring = syncRuntime.isSyncing
      })

      const switching = switchAccountKeepingPending(storeTokens, 'account-b')
      await Promise.resolve()
      expect(storeTokens).not.toHaveBeenCalled()
      expect(syncRuntime.accountSwitching).toBe(true)

      releasePass()
      await switching

      expect(lockedWhileStoring).toBe(true)
      expect(syncRuntime.isSyncing).toBe(false)
      expect(syncRuntime.accountSwitching).toBe(false)
      expect(held('account-a')).toEqual(['favorites/tapDance'])
      expect(readFile().owner).toBe('account-b')
    })

    it('forgets the previous account\'s caches after storing the tokens, before releasing the lock', async () => {
      startWith({ owner: 'account-a', units: [], held: {} })
      let lockedWhileForgetting = false
      mockForgetAccountCaches.mockImplementationOnce(() => {
        lockedWhileForgetting = syncRuntime.isSyncing
      })
      const storeTokens = vi.fn(async () => {})

      await switchAccountKeepingPending(storeTokens, 'account-b')

      expect(mockForgetAccountCaches).toHaveBeenCalledTimes(1)
      expect(storeTokens.mock.invocationCallOrder[0]).toBeLessThan(mockForgetAccountCaches.mock.invocationCallOrder[0])
      expect(lockedWhileForgetting).toBe(true)
    })

    it('waits for an analytics sync and a remote day fetch to finish', async () => {
      startWith({ owner: null, units: [], held: {} })
      syncRuntime.analyticsSyncingUids.add('uid1')
      syncRuntime.remoteTypingDayFetches.set('uid2', 1)
      const storeTokens = vi.fn(async () => {})

      const switching = switchAccountKeepingPending(storeTokens, 'account-b')
      await vi.advanceTimersByTimeAsync(500)
      expect(storeTokens).not.toHaveBeenCalled()

      syncRuntime.analyticsSyncingUids.clear()
      syncRuntime.remoteTypingDayFetches.clear()
      await vi.advanceTimersByTimeAsync(200)
      await switching

      expect(storeTokens).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['a pass holds the sync lock', () => {
        claimSyncLock()
      }],
      ['an analytics sync runs', () => {
        syncRuntime.analyticsSyncingUids.add('uid1')
      }],
    ])('fails without storing the tokens when %s past the wait', async (_name, busy) => {
      startWith({ owner: 'account-a', units: ['favorites/tapDance'], held: {} })
      busy()
      const storeTokens = vi.fn(async () => {})

      const switching = switchAccountKeepingPending(storeTokens, 'account-b')
      const rejected = expect(switching).rejects.toThrow(ACCOUNT_SWITCH_BUSY_MESSAGE)
      await vi.advanceTimersByTimeAsync(ACCOUNT_SWITCH_WAIT_MS)
      await rejected
      await expect(switching).rejects.toMatchObject({ reason: 'syncBusy' })
      await expect(switching).rejects.toBeInstanceOf(AccountSwitchBusyError)

      expect(storeTokens).not.toHaveBeenCalled()
      expect(mockForgetAccountCaches).not.toHaveBeenCalled()
      expect(syncRuntime.accountSwitching).toBe(false)
      expect(active()).toEqual(['favorites/tapDance'])
      expect(syncRuntime.pendingOwner).toBe('account-a')
    })

    it('refuses a second switch while one is waiting', async () => {
      startWith({ owner: null, units: [], held: {} })
      const releasePass = claimSyncLock()
      const first = switchAccountKeepingPending(async () => {}, 'account-b')
      const second = vi.fn(async () => {})

      await expect(switchAccountKeepingPending(second, 'account-c')).rejects.toBeInstanceOf(AccountSwitchBusyError)

      releasePass()
      await first
      expect(second).not.toHaveBeenCalled()
    })

    it('gives ownerless units to the account still signed in before its tokens are replaced', async () => {
      startWith({ owner: null, units: [], held: {} })
      markPending('favorites/tapDance')
      mockGetAccountSub.mockResolvedValueOnce('account-a')

      await switchAccountKeepingPending(async () => {}, 'account-b')

      expect(held('account-a')).toEqual(['favorites/tapDance'])
      expect(active()).toEqual([])
    })

    it('fails without storing the tokens, and keeps the pending state, when the hand-over cannot be written', async () => {
      startWith({ owner: 'account-a', units: ['favorites/tapDance'], held: {} })
      const generation = pendingGenerationOf('favorites/tapDance')
      blockWrites()
      const storeTokens = vi.fn(async () => {})

      await expect(switchAccountKeepingPending(storeTokens, 'account-b')).rejects.toThrow()

      expect(storeTokens).not.toHaveBeenCalled()
      expect(mockForgetAccountCaches).not.toHaveBeenCalled()
      expect(syncRuntime.pendingOwner).toBe('account-a')
      expect(active()).toEqual(['favorites/tapDance'])
      expect(pendingGenerationOf('favorites/tapDance')).toBe(generation)
      expect(syncRuntime.heldPending.size).toBe(0)
    })

    it('fails without storing the tokens when the ownerless units cannot be given to the old account', async () => {
      startWith({ owner: null, units: [], held: {} })
      markPending('favorites/tapDance')
      mockGetAccountSub.mockResolvedValueOnce('account-a')
      blockWrites()
      const storeTokens = vi.fn(async () => {})

      await expect(switchAccountKeepingPending(storeTokens, 'account-b')).rejects.toThrow()

      expect(storeTokens).not.toHaveBeenCalled()
      expect(syncRuntime.pendingOwner).toBeNull()
      expect(active()).toEqual(['favorites/tapDance'])
    })

    it('releases the lock when the tokens cannot be stored', async () => {
      startWith({ owner: null, units: [], held: {} })

      await expect(switchAccountKeepingPending(async () => {
        throw new Error('keychain')
      }, 'account-b')).rejects.toThrow('keychain')

      expect(mockForgetAccountCaches).not.toHaveBeenCalled()
      expect(syncRuntime.isSyncing).toBe(false)
      expect(syncRuntime.accountSwitching).toBe(false)
    })
  })

  describe('marking a unit pending for the account a pass ran as', () => {
    beforeEach(() => {
      startWith({ owner: 'account-b', units: [], held: {} })
    })

    it('marks it pending when that account is still the owner, or the pass ran as nobody known', () => {
      markPendingFor('account-b', 'favorites/tapDance')
      markPendingFor(null, 'favorites/macro')

      expect(active()).toEqual(['favorites/macro', 'favorites/tapDance'])
    })

    it('holds it for that account when another account has signed in since', () => {
      markPendingFor('account-a', 'favorites/tapDance')

      expect(active()).toEqual([])
      expect(readFile().held).toEqual({ 'account-a': ['favorites/tapDance'] })
    })
  })

  describe('signing out', () => {
    beforeEach(() => {
      startWith({ owner: 'account-a', units: [], held: {} })
    })

    it('holds the account\'s units, keeps them in the file, then removes the tokens', async () => {
      markPending('favorites/tapDance')
      let heldBeforeSignOut = false
      mockSignOut.mockImplementationOnce(async () => {
        heldBeforeSignOut = held('account-a').length === 1
      })

      await signOutKeepingPending()

      expect(heldBeforeSignOut).toBe(true)
      expect(mockSignOut).toHaveBeenCalledTimes(1)
      expect(mockForgetAccountCaches).toHaveBeenCalledTimes(1)
      expect(mockSignOut.mock.invocationCallOrder[0]).toBeLessThan(mockForgetAccountCaches.mock.invocationCallOrder[0])
      expect(active()).toEqual([])
      expect(readFile()).toEqual({ version: 1, owner: null, units: [], held: { 'account-a': ['favorites/tapDance'] } })
    })

    it('signs out only after the running pass ends, holding the lock', async () => {
      markPending('favorites/tapDance')
      const releasePass = claimSyncLock()
      let lockedWhileSigningOut = false
      mockSignOut.mockImplementationOnce(async () => {
        lockedWhileSigningOut = syncRuntime.isSyncing
      })

      const signingOut = signOutKeepingPending()
      await Promise.resolve()
      expect(mockSignOut).not.toHaveBeenCalled()
      expect(active()).toEqual(['favorites/tapDance'])

      releasePass()
      await signingOut

      expect(lockedWhileSigningOut).toBe(true)
      expect(held('account-a')).toEqual(['favorites/tapDance'])
    })

    it('signs out anyway once the wait runs out, holding the units first', async () => {
      markPending('favorites/tapDance')
      claimSyncLock()

      const signingOut = signOutKeepingPending()
      await vi.advanceTimersByTimeAsync(ACCOUNT_SWITCH_WAIT_MS)
      await signingOut

      expect(mockSignOut).toHaveBeenCalledTimes(1)
      expect(held('account-a')).toEqual(['favorites/tapDance'])
      expect(syncRuntime.accountSwitching).toBe(false)
    })

    it('keeps the tokens and reports an error when the hold cannot be written', async () => {
      markPending('favorites/tapDance')
      rmSync(pendingPath(), { force: true })
      mkdirSync(join(pendingPath(), 'blocker'), { recursive: true })

      await expect(signOutKeepingPending()).rejects.toThrow()

      expect(mockSignOut).not.toHaveBeenCalled()
      expect(mockForgetAccountCaches).not.toHaveBeenCalled()
      expect(syncRuntime.pendingOwner).toBe('account-a')
      expect(active()).toEqual(['favorites/tapDance'])
    })

    it('holds ownerless units for the account still signed in (no pass handed them over yet)', async () => {
      syncRuntime.pendingOwner = null
      markPending('favorites/tapDance')
      mockGetAccountSub.mockResolvedValueOnce('account-a')

      await signOutKeepingPendingLocked()
      expect(mockForgetAccountCaches).toHaveBeenCalledTimes(1)
      mockGetAccountSub.mockResolvedValueOnce('account-b')
      await adoptPendingForSignedInAccount()

      expect(active()).toEqual([])
      expect(held('account-a')).toEqual(['favorites/tapDance'])
    })

    it('makes a settle of a pass still running with the old account do nothing', async () => {
      markPending('favorites/tapDance')
      const generations = snapshotPendingGenerations()

      await signOutKeepingPending()
      markPending('favorites/tapDance')
      settlePending('favorites/tapDance', generations.get('favorites/tapDance') ?? 0)

      expect(active()).toEqual(['favorites/tapDance'])
      expect(held('account-a')).toEqual(['favorites/tapDance'])
    })

    it('gives changes made while signed out to the next account, and holds the previous account\'s for it', async () => {
      markPending('favorites/tapDance')
      await signOutKeepingPending()
      markPending('favorites/macro')

      await signInAs('account-b')

      expect(active()).toEqual(['favorites/macro'])
      expect(held('account-a')).toEqual(['favorites/tapDance'])

      await signOutKeepingPending()
      await signInAs('account-a')

      expect(active()).toEqual(['favorites/tapDance'])
      expect(held('account-b')).toEqual(['favorites/macro'])
    })

    it('only removes the tokens when nothing is owned', async () => {
      await signOutKeepingPending()
      rmSync(pendingPath())

      await signOutKeepingPending()

      expect(existsSync(pendingPath())).toBe(false)
      expect(mockSignOut).toHaveBeenCalledTimes(2)
    })
  })
})
