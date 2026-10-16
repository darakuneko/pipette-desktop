// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the sync password change of the Rust backend
// (src-tauri/crates/pipette-sync/src/password/{change,switch,lock,
// lock_release,state}.rs and scan.rs). Runs the Electron main process's
// sync-password-change.ts, sync-password-switch.ts, sync-password-lock.ts,
// sync-password-lock-release.ts and sync-scan.ts in the sync fixture
// harness (setup.ts) over scenarios of steps, against an in-memory Drive
// that behaves as the Rust `InMemoryDrive` of pipette-drive does (ids
// `fake-1`, `fake-2`, …; every write one second after the one before from
// 2026-01-01T00:00:00.000Z, the create time set once; `nameContains`
// matches the start of a name). Files are converted one at a time
// (`SYNC_CONCURRENCY` 1), so the order of the Drive requests is fixed.
//
// Records, for each step, its result or error message, the Drive requests
// it sent (with the bytes of each lock and marker it created) and the
// waits of the lock's re-lists, the state file's bytes after it, whether
// the change keys read, and the stored password; and, for each scenario,
// the files left on Drive with the password that opens each one.
//
// Writes src-tauri/crates/pipette-sync/tests/fixtures/ts_password_change.json.
//
// Run: pnpm run generate:sync-fixtures

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { FIXED_NOW, resetHarness, seedUserData } from './harness'
import type { SyncEnvelope } from '../../src/shared/types/sync'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_password_change.json')

const CLOCK_START_MS = Date.UTC(2026, 0, 1)
const MACHINE_HASH = 'golden-hash'

interface MemFile {
  id: string
  name: string
  modifiedTime: string
  createdTime: string
  content: string
}

type Action = 'quit' | 'deleteLocks'

/** The in-memory Drive (see the header) and what the scenario does to it. */
const drive = vi.hoisted(() => ({
  files: [] as MemFile[],
  nextId: 1,
  clockMs: 0,
  hideNew: false,
  hidden: new Set<string>(),
  failNext: new Set<string>(),
  /** After this many more updates, `action` runs. */
  afterUpdates: null as { count: number; action: Action } | null,
  events: [] as string[],
}))

const stored = vi.hoisted(() => ({ password: null as string | null }))
const auth = vi.hoisted(() => ({ signedIn: true }))
const quit = vi.hoisted(() => ({ request: null as (() => void) | null }))

function tick(): string {
  drive.clockMs = drive.clockMs === 0 ? CLOCK_START_MS : drive.clockMs + 1000
  return new Date(drive.clockMs).toISOString()
}

function driveError(label: string, status: number, message: string, reason: string): Error {
  const body = `{"error":{"code":${status},"message":"${message}","errors":[{"reason":"${reason}","message":"${message}"}]}}`
  return new Error(`Drive ${label} failed: ${status} ${body}`)
}

function failIfDue(op: string, label: string): void {
  if (drive.failNext.delete(op)) throw driveError(label, 400, 'Injected failure', 'backendError')
}

function findFile(id: string, label: string): MemFile {
  const file = drive.files.find((f) => f.id === id)
  if (!file) throw driveError(label, 404, `File not found: ${id}.`, 'notFound')
  return file
}

function createFile(name: string, content: string): MemFile {
  const now = tick()
  const file = { id: `fake-${drive.nextId++}`, name, modifiedTime: now, createdTime: now, content }
  drive.files.push(file)
  if (drive.hideNew) drive.hidden.add(file.id)
  return file
}

function runAfterUpdate(): void {
  const due = drive.afterUpdates
  if (!due) return
  due.count -= 1
  if (due.count > 0) return
  drive.afterUpdates = null
  if (due.action === 'quit') quit.request?.()
  else drive.files = drive.files.filter((f) => f.name !== 'password-change-lock.json')
}

vi.mock('../../src/main/sync/google-drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/google-drive')>()
  const download = async (id: string): Promise<string> => {
    drive.events.push(`download:${id}`)
    failIfDue('download', 'download')
    return findFile(id, 'download').content
  }
  return {
    ...actual,
    listFiles: async (options?: { nameContains?: string }) => {
      drive.events.push(`list:${options?.nameContains ?? '*'}`)
      failIfDue('list', 'list')
      return drive.files
        .filter((f) => !drive.hidden.has(f.id) && (options?.nameContains === undefined || f.name.startsWith(options.nameContains)))
        .map(({ id, name, modifiedTime, createdTime }) => ({ id, name, modifiedTime, createdTime }))
    },
    downloadRawFile: download,
    downloadFile: async (id: string) => JSON.parse(await download(id)) as SyncEnvelope,
    uploadFile: async (name: string, envelope: SyncEnvelope, existingFileId?: string) => {
      if (existingFileId) {
        drive.events.push(`update:${existingFileId}`)
        failIfDue('update', 'update')
        const file = findFile(existingFileId, 'update')
        file.content = JSON.stringify(envelope)
        file.modifiedTime = tick()
        runAfterUpdate()
        return { id: file.id, modifiedTime: file.modifiedTime }
      }
      drive.events.push(`create:${name}`)
      failIfDue('create', 'upload')
      const file = createFile(name, JSON.stringify(envelope))
      return { id: file.id, modifiedTime: file.modifiedTime }
    },
    createRawFile: async (name: string, content: string) => {
      drive.events.push(`createRaw:${name} ${content}`)
      failIfDue('create', 'upload')
      return { id: createFile(name, content).id }
    },
    deleteFile: async (id: string) => {
      drive.events.push(`delete:${id}`)
      failIfDue('delete', 'delete')
      drive.files = drive.files.filter((f) => f.id !== id)
    },
    renameFile: async (id: string, name: string) => {
      drive.events.push(`rename:${id} ${name}`)
      failIfDue('rename', 'rename')
      const file = drive.files.find((f) => f.id === id)
      if (!file) return null
      file.name = name
      file.modifiedTime = tick()
      return { id, name, modifiedTime: file.modifiedTime }
    },
  }
})

vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: auth.signedIn }),
  getAccessToken: async () => 'fixture-token',
  getAccountSub: async () => null,
}))

vi.mock('../../src/main/sync/sync-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/sync-crypto')>()
  return {
    ...actual,
    retrievePasswordResult: async () =>
      stored.password === null ? { ok: false, reason: 'noPasswordFile' } : { ok: true, password: stored.password },
    storePassword: async (password: string) => {
      stored.password = password
    },
    clearPassword: async () => {
      stored.password = null
    },
  }
})

// One file at a time, so the requests come in one order.
vi.mock('../../src/main/sync/sync-runtime-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/sync/sync-runtime-state')>()),
  SYNC_CONCURRENCY: 1,
}))

vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: async () => MACHINE_HASH }))

vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

import { decrypt, encrypt } from '../../src/main/sync/sync-crypto'
import {
  abandonPasswordChange,
  deletePasswordChangeUndecryptableFiles,
  getPasswordChangeStatus,
  recoverPasswordChangeOnStartup,
  resumePasswordChange,
  revertPasswordChange,
  startPasswordChange,
} from '../../src/main/sync/sync-password-change'
import { passwordChangeTuning } from '../../src/main/sync/sync-password-switch'
import { lockTiming } from '../../src/main/sync/sync-password-lock'
import { getPasswordChangeLockStatus, releasePasswordChangeLocks } from '../../src/main/sync/sync-password-lock-release'
import { clearChangeKeys, forgetChangeStateCache, retrieveChangeKeys, storeChangeKeys } from '../../src/main/sync/sync-password-change-state'
import { listUndecryptableFiles } from '../../src/main/sync/sync-scan'
import { resetPasswordCheckCache } from '../../src/main/sync/sync-password'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { resetSyncRuntimeForTests, syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'

type Seed =
  | { unit: string; password: string }
  | { passwordCheck: string }
  | { name: string; raw: string }
  | { lock: string; machineHash?: string }

type Step =
  | { op: 'start'; password: string }
  | { op: 'resume' }
  | { op: 'revert' }
  | { op: 'abandon' }
  | { op: 'deleteUndecryptable'; ids: string[] }
  | { op: 'recover' }
  | { op: 'status' }
  | { op: 'lockStatus' }
  | { op: 'release' }
  | { op: 'listUndecryptable' }
  | { op: 'seed'; files: Seed[] }
  | { op: 'stored'; password: string | null }
  | { op: 'signedIn'; value: boolean }
  | { op: 'localState'; content: string | null }
  | { op: 'keys'; old: string; new: string }
  | { op: 'clearKeys' }
  | { op: 'failNext'; what: 'list' | 'download' | 'create' | 'update' | 'rename' | 'delete' }
  | { op: 'hideNew'; on: boolean }
  | { op: 'afterUpdates'; count: number; action: Action }
  | { op: 'chunkSize'; size: number }
  | { op: 'restart' }

interface Scenario {
  name: string
  /** The passwords a file left on Drive is tried with. */
  passwords: string[]
  steps: Step[]
}

const data = (unit: string, password: string): Seed => ({ unit, password })
const pc = (password: string): Seed => ({ passwordCheck: password })
const ownLock = (lockId = 'lock-1'): Seed => ({ lock: lockId })
const otherLock = (): Seed => ({ lock: 'lock-other', machineHash: 'other-hash' })
const state = (step: string, lockFileId?: string, target = 'new'): string =>
  JSON.stringify({ version: 1, target, step, lockId: 'lock-1', ...(lockFileId ? { lockFileId } : {}), startedAt: FIXED_NOW })

const A = 'favorites/macro'
const B = 'keyboards/kb1/settings'
const C = 'key-labels'
const OLD_NEW = ['old', 'new', 'other']

const SCENARIOS: Scenario[] = [
  {
    name: 'a change re-encrypts every file, the password-check and the stored password',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'old'), data(B, 'old')] },
      { op: 'start', password: 'new' },
      { op: 'status' },
      { op: 'lockStatus' },
    ],
  },
  {
    name: 'a change creates the password-check when Drive has none',
    passwords: OLD_NEW,
    steps: [{ op: 'stored', password: 'old' }, { op: 'seed', files: [data(A, 'old')] }, { op: 'start', password: 'new' }],
  },
  {
    name: 'a change is refused before any lock',
    passwords: OLD_NEW,
    steps: [
      { op: 'start', password: 'new' },
      { op: 'stored', password: 'old' },
      { op: 'signedIn', value: false },
      { op: 'start', password: 'new' },
      { op: 'signedIn', value: true },
      { op: 'seed', files: [pc('old')] },
      { op: 'start', password: 'old' },
      { op: 'stored', password: 'typo' },
      { op: 'start', password: 'new' },
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [{ name: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, raw: '{}' }] },
      { op: 'start', password: 'new' },
      { op: 'localState', content: state('reencrypting') },
      { op: 'start', password: 'new' },
    ],
  },
  {
    name: "another machine's lock stops the change and it is forgotten",
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), otherLock()] },
      { op: 'start', password: 'new' },
      { op: 'status' },
      { op: 'lockStatus' },
    ],
  },
  {
    name: 'a failed upload leaves the change for the next launch to resume',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'old'), data(B, 'old')] },
      { op: 'failNext', what: 'update' },
      { op: 'start', password: 'new' },
      { op: 'status' },
      { op: 'restart' },
      { op: 'recover' },
      { op: 'resume' },
      { op: 'status' },
    ],
  },
  {
    name: 'quitting stops at a batch boundary and the next launch resumes',
    passwords: OLD_NEW,
    steps: [
      { op: 'chunkSize', size: 1 },
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'old'), data(B, 'old'), data(C, 'old')] },
      { op: 'afterUpdates', count: 1, action: 'quit' },
      { op: 'start', password: 'new' },
      { op: 'restart' },
      { op: 'recover' },
      { op: 'resume' },
    ],
  },
  {
    name: 'a lost Drive lock stops the run and a resume takes a new one',
    passwords: OLD_NEW,
    steps: [
      { op: 'chunkSize', size: 1 },
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'old'), data(B, 'old')] },
      { op: 'afterUpdates', count: 1, action: 'deleteLocks' },
      { op: 'start', password: 'new' },
      { op: 'status' },
      { op: 'restart' },
      { op: 'recover' },
      { op: 'status' },
      { op: 'resume' },
    ],
  },
  {
    name: "another machine's lock after ours was lost stops a resume",
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'new'), otherLock()] },
      { op: 'keys', old: 'old', new: 'new' },
      { op: 'localState', content: state('reencrypting', 'fake-9') },
      { op: 'resume' },
      { op: 'status' },
      { op: 'abandon' },
      { op: 'status' },
    ],
  },
  {
    name: 'a revert turns a half-converted Drive back to the old password',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'new'), data(B, 'old'), ownLock()] },
      { op: 'keys', old: 'old', new: 'new' },
      { op: 'localState', content: state('reencrypting', 'fake-4') },
      { op: 'revert' },
      { op: 'revert' },
    ],
  },
  {
    name: 'a file neither password opens stops the change until it is deleted',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'old'), data(B, 'other')] },
      { op: 'start', password: 'new' },
      { op: 'status' },
      { op: 'deleteUndecryptable', ids: ['fake-3', 'fake-2', 'fake-1', 'missing'] },
      { op: 'status' },
      { op: 'resume' },
    ],
  },
  {
    name: 'the startup recovery finishes a commit',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'new'), data(B, 'old'), ownLock()] },
      { op: 'keys', old: 'old', new: 'new' },
      { op: 'localState', content: state('committing', 'fake-4') },
      { op: 'recover' },
    ],
  },
  {
    name: 'the startup recovery finishes the cleanup and abandons a change still locking',
    passwords: OLD_NEW,
    steps: [
      { op: 'seed', files: [ownLock('lock-0')] },
      { op: 'localState', content: JSON.stringify({ version: 1, target: 'new', step: 'cleanup', lockId: 'lock-0', lockFileId: 'fake-1', startedAt: 5 }) },
      { op: 'recover' },
      { op: 'seed', files: [otherLock(), ownLock()] },
      { op: 'keys', old: 'old', new: 'new' },
      { op: 'localState', content: state('locking') },
      { op: 'recover' },
      { op: 'status' },
    ],
  },
  {
    name: 'keys without a state are removed at startup and an unreadable state is only reported',
    passwords: OLD_NEW,
    steps: [
      { op: 'keys', old: 'old', new: 'new' },
      { op: 'recover' },
      { op: 'localState', content: 'not json' },
      { op: 'recover' },
      { op: 'status' },
      { op: 'resume' },
      { op: 'abandon' },
      { op: 'status' },
    ],
  },
  {
    name: 'a change whose keys cannot be read waits and can be abandoned',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'new'), ownLock()] },
      { op: 'localState', content: state('reencrypting', 'fake-3') },
      { op: 'recover' },
      { op: 'status' },
      { op: 'resume' },
      { op: 'revert' },
      { op: 'deleteUndecryptable', ids: ['fake-2'] },
      { op: 'localState', content: state('committing', 'fake-3') },
      { op: 'recover' },
      { op: 'abandon' },
      { op: 'status' },
    ],
  },
  {
    name: 'copies sharing one name go to trash and every file is re-encrypted',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old'), data(A, 'old'), data(A, 'old'), data(B, 'old')] },
      { op: 'start', password: 'new' },
    ],
  },
  {
    name: 'a lock that never shows in the listings is lost',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old')] },
      { op: 'hideNew', on: true },
      { op: 'start', password: 'new' },
      { op: 'hideNew', on: false },
      { op: 'status' },
    ],
  },
  {
    name: 'a failed lock create forgets the change',
    passwords: OLD_NEW,
    steps: [
      { op: 'stored', password: 'old' },
      { op: 'seed', files: [pc('old')] },
      { op: 'failNext', what: 'create' },
      { op: 'start', password: 'new' },
      { op: 'status' },
    ],
  },
  {
    name: 'the lock status and the release of every lock',
    passwords: OLD_NEW,
    steps: [
      { op: 'lockStatus' },
      { op: 'seed', files: [{ name: 'password-change-lock.json', raw: 'garbage' }, otherLock()] },
      { op: 'lockStatus' },
      { op: 'localState', content: state('reencrypting') },
      { op: 'release' },
      { op: 'localState', content: null },
      { op: 'release' },
      { op: 'seed', files: [ownLock()] },
      { op: 'lockStatus' },
      { op: 'seed', files: [{ name: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, raw: '{}' }] },
      { op: 'release' },
      { op: 'lockStatus' },
    ],
  },
  {
    name: 'the operations without a change in progress',
    passwords: OLD_NEW,
    steps: [
      { op: 'resume' },
      { op: 'revert' },
      { op: 'abandon' },
      { op: 'deleteUndecryptable', ids: ['fake-1'] },
      { op: 'status' },
      { op: 'recover' },
      { op: 'localState', content: state('committing') },
      { op: 'revert' },
      { op: 'deleteUndecryptable', ids: ['fake-1'] },
    ],
  },
  {
    name: 'the files the stored password does not open',
    passwords: ['pw', 'other'],
    steps: [
      { op: 'listUndecryptable' },
      { op: 'stored', password: 'pw' },
      { op: 'seed', files: [pc('pw'), data(A, 'pw'), data(B, 'other'), { name: 'key-labels.enc', raw: 'not json' }] },
      { op: 'seed', files: [{ name: 'favorites_macro.enc.trash.1.2.fake-5', raw: 'not json' }] },
      { op: 'listUndecryptable' },
      { op: 'localState', content: state('reencrypting') },
      { op: 'listUndecryptable' },
    ],
  },
]

// --- Running a scenario ---

let seededUserData = ''

function statePath(): string {
  return join(seededUserData, 'local', 'auth', 'sync-password-change.json')
}

function readState(): string | null {
  try {
    return readFileSync(statePath(), 'utf8')
  } catch {
    return null
  }
}

async function keysSummary(): Promise<string> {
  const keys = await retrieveChangeKeys()
  return keys.ok ? `${keys.keys.oldPassword}>${keys.keys.newPassword}` : keys.reason
}

async function seedFile(seed: Seed): Promise<void> {
  if ('unit' in seed) {
    const envelope = await encrypt(JSON.stringify({ unit: seed.unit }), seed.password, seed.unit)
    createFile(seed.unit.replace(/\//g, '_') + '.enc', JSON.stringify(envelope))
  } else if ('passwordCheck' in seed) {
    const envelope = await encrypt(JSON.stringify({ type: 'password-check', version: 1 }), seed.passwordCheck, 'password-check')
    createFile('password-check.enc', JSON.stringify(envelope))
  } else if ('lock' in seed) {
    const content = { type: 'password-change-lock', version: 1, lockId: seed.lock, machineHash: seed.machineHash ?? MACHINE_HASH, startedAt: new Date(FIXED_NOW).toISOString() }
    createFile('password-change-lock.json', JSON.stringify(content))
  } else {
    createFile(seed.name, seed.raw)
  }
}

async function opener(content: string, passwords: string[]): Promise<unknown> {
  let envelope: SyncEnvelope
  try {
    envelope = JSON.parse(content) as SyncEnvelope
    if (typeof envelope.ciphertext !== 'string') return { raw: content }
  } catch {
    return { raw: content }
  }
  for (const password of passwords) {
    try {
      return { opens: password, syncUnit: envelope.syncUnit, plaintext: await decrypt(envelope, password) }
    } catch {
      // Not this one.
    }
  }
  return { opens: null }
}

async function runOp(step: Step): Promise<unknown> {
  switch (step.op) {
    case 'start':
      return startPasswordChange(step.password)
    case 'resume':
      return resumePasswordChange()
    case 'revert':
      return revertPasswordChange()
    case 'abandon':
      return abandonPasswordChange()
    case 'deleteUndecryptable':
      return deletePasswordChangeUndecryptableFiles(step.ids)
    case 'recover':
      return recoverPasswordChangeOnStartup()
    case 'status':
      return getPasswordChangeStatus()
    case 'lockStatus':
      return getPasswordChangeLockStatus()
    case 'release':
      return releasePasswordChangeLocks()
    case 'listUndecryptable':
      return listUndecryptableFiles()
    default:
      throw new Error(`not an operation: ${step.op}`)
  }
}

function restart(): void {
  resetSyncRuntimeForTests()
  forgetChangeStateCache()
  resetPasswordCheckCache()
  clearSyncFormatStatus()
}

/** Applies a step that sets the scene; false for a step under test. */
async function arrange(step: Step): Promise<boolean> {
  switch (step.op) {
    case 'seed':
      for (const seed of step.files) await seedFile(seed)
      return true
    case 'stored':
      stored.password = step.password
      return true
    case 'signedIn':
      auth.signedIn = step.value
      return true
    case 'localState':
      mkdirSync(join(seededUserData, 'local', 'auth'), { recursive: true })
      if (step.content === null) rmSync(statePath(), { force: true })
      else writeFileSync(statePath(), step.content)
      forgetChangeStateCache()
      return true
    case 'keys':
      await storeChangeKeys({ oldPassword: step.old, newPassword: step.new })
      return true
    case 'clearKeys':
      await clearChangeKeys()
      return true
    case 'failNext':
      drive.failNext.add(step.what)
      return true
    case 'hideNew':
      drive.hideNew = step.on
      if (!step.on) drive.hidden.clear()
      return true
    case 'afterUpdates':
      drive.afterUpdates = { count: step.count, action: step.action }
      return true
    case 'chunkSize':
      passwordChangeTuning.chunkSize = step.size
      return true
    case 'restart':
      restart()
      return true
    default:
      return false
  }
}

async function runScenario(scenario: Scenario): Promise<unknown> {
  // Each scenario's lock ids count from `…000000000001`.
  resetHarness()
  seededUserData = seedUserData()
  drive.files = []
  drive.nextId = 1
  drive.clockMs = 0
  drive.hideNew = false
  drive.hidden.clear()
  drive.failNext.clear()
  drive.afterUpdates = null
  stored.password = null
  auth.signedIn = true
  passwordChangeTuning.chunkSize = 50
  restart()

  const steps: unknown[] = []
  for (const step of scenario.steps) {
    if (await arrange(step)) {
      steps.push({ step })
      continue
    }
    drive.events = []
    let result: unknown
    try {
      result = { ok: (await runOp(step)) ?? null }
    } catch (err) {
      result = { error: (err as Error).message }
    }
    steps.push({
      step,
      result,
      drive: drive.events,
      state: readState(),
      keys: await keysSummary(),
      stored: stored.password,
    })
  }
  const files = []
  for (const { id, name, modifiedTime, createdTime, content } of drive.files) {
    files.push({ id, name, modifiedTime, createdTime, content: await opener(content, scenario.passwords) })
  }
  return { name: scenario.name, passwords: scenario.passwords, steps, files }
}

describe('record the password change fixtures', () => {
  it('records each scenario', async () => {
    expect(passwordChangeTuning).toEqual({ chunkSize: 50, maxPasses: 3 })
    expect(lockTiming.relistDelaysMs).toEqual([1000, 2000, 4000])
    expect(lockTiming.settleMs).toBe(2000)
    vi.spyOn(lockTiming, 'sleep').mockImplementation(async (ms: number) => {
      drive.events.push(`sleep:${ms}`)
    })
    quit.request = () => {
      syncRuntime.isQuitting = true
    }
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
    writeJsonFixture(OUT, { now: FIXED_NOW, machineHash: MACHINE_HASH, scenarios })
  }, 600_000)
})
