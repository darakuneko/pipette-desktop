// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the parts every sync entry point runs before it
// touches data (src-tauri/crates/pipette-sync: the guard, the sync-format
// marker and its status, the password-check). Runs the Electron main
// process's sync-password-guard.ts, sync-format.ts, sync-format-status.ts
// and sync-password.ts in the sync fixture harness (setup.ts) over
// scenarios of steps, against an in-memory Drive that behaves as the Rust
// `InMemoryDrive` of pipette-drive does (ids `fake-1`, `fake-2`, …; every
// write one second after the one before from 2026-01-01T00:00:00.000Z;
// `nameContains` matches the start of a name). Records, for each step, its
// result or error message, the Drive operations it sent, the validated
// password-check and the sync-format status events; and, for each
// scenario, the files left on Drive and the stored password.
//
// Writes src-tauri/crates/pipette-sync/tests/fixtures/ts_preflight.json.
//
// Run: pnpm run generate:sync-fixtures

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { seedUserData } from './harness'
import type { SyncEnvelope, SyncFormatStatus } from '../../src/shared/types/sync'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_preflight.json')

/** Where every scenario starts its clock (the sync-format and
 *  password-check memories read it). */
const START_MS = 1_000_000
const CREATED_MEMORY_MS = 5 * 60 * 1000
const CLOCK_START_MS = Date.UTC(2026, 0, 1)

interface MemFile {
  id: string
  name: string
  modifiedTime: string
  content: string
}

/** The in-memory Drive (see the header) and what the scenario does to it. */
const drive = vi.hoisted(() => ({
  files: [] as MemFile[],
  nextId: 1,
  clockMs: 0,
  hideNew: false,
  hidden: new Set<string>(),
  failNext: new Map<string, string>(),
  events: [] as string[],
}))

/** The stored sync password: null when there is no file. */
const stored = vi.hoisted(() => ({
  state: { kind: 'none' } as { kind: 'none' } | { kind: 'readable'; password: string } | { kind: 'decryptFailed' } | { kind: 'keystoreUnavailable' },
}))

const auth = vi.hoisted(() => ({ signedIn: true }))

function tick(): string {
  drive.clockMs = drive.clockMs === 0 ? CLOCK_START_MS : drive.clockMs + 1000
  return new Date(drive.clockMs).toISOString()
}

/** Drive's error for an injected 400, as pipette-drive's fake writes it. */
function injected(label: string): Error {
  const body = '{"error":{"code":400,"message":"Injected failure","errors":[{"reason":"backendError","message":"Injected failure"}]}}'
  return new Error(`Drive ${label} failed: 400 ${body}`)
}

function failIfDue(op: string, label: string): void {
  if (drive.failNext.has(op)) {
    drive.failNext.delete(op)
    throw injected(label)
  }
}

function createFile(name: string, content: string): MemFile {
  const file = { id: `fake-${drive.nextId++}`, name, modifiedTime: tick(), content }
  drive.files.push(file)
  if (drive.hideNew) drive.hidden.add(file.id)
  return file
}

function listing(nameContains?: string): Array<{ id: string; name: string; modifiedTime: string }> {
  return drive.files
    .filter((f) => !drive.hidden.has(f.id) && (nameContains === undefined || f.name.startsWith(nameContains)))
    .map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }))
}

vi.mock('../../src/main/sync/google-drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/google-drive')>()
  return {
    ...actual,
    listFiles: async (options?: { nameContains?: string }) => {
      drive.events.push(`list:${options?.nameContains ?? '*'}`)
      failIfDue('list', 'list')
      return listing(options?.nameContains)
    },
    downloadFile: async (id: string) => {
      drive.events.push(`download:${id}`)
      failIfDue('download', 'download')
      const file = drive.files.find((f) => f.id === id)
      if (!file) throw new Error(`Drive download failed: 404 not found`)
      return JSON.parse(file.content) as SyncEnvelope
    },
    uploadFile: async (name: string, envelope: SyncEnvelope, existingFileId?: string) => {
      if (existingFileId) throw new Error('the preflight never updates a file')
      drive.events.push(`create:${name}`)
      failIfDue('create', 'upload')
      const file = createFile(name, JSON.stringify(envelope))
      return { id: file.id, modifiedTime: file.modifiedTime }
    },
    createRawFile: async (name: string, content: string) => {
      drive.events.push(`create:${name} ${content}`)
      failIfDue('create', 'upload')
      return { id: createFile(name, content).id }
    },
    deleteFile: async (id: string) => {
      drive.events.push(`delete:${id}`)
      failIfDue('delete', 'delete')
      drive.files = drive.files.filter((f) => f.id !== id)
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
    retrievePasswordResult: async () => {
      const s = stored.state
      return s.kind === 'readable' ? { ok: true, password: s.password } : { ok: false, reason: s.kind === 'none' ? 'noPasswordFile' : s.kind }
    },
    storePassword: async (password: string) => {
      if (stored.state.kind === 'keystoreUnavailable') throw new Error('OS keychain encryption is not available')
      stored.state = { kind: 'readable', password }
    },
    clearPassword: async () => {
      if (stored.state.kind !== 'keystoreUnavailable') stored.state = { kind: 'none' }
    },
  }
})

vi.mock('../../src/main/logger', () => ({ log: () => {} }))

import { encrypt } from '../../src/main/sync/sync-crypto'
import { listFiles } from '../../src/main/sync/google-drive'
import { getSyncBlock, assertSyncFormatSupported } from '../../src/main/sync/sync-password-guard'
import { ensureSyncFormatMarker, ensureSyncFormatMarkerKnown, syncFormatGeneration, syncFormatTiming } from '../../src/main/sync/sync-format'
import {
  clearSyncFormatStatus,
  getCachedSyncFormatStatus,
  refreshSyncFormatStatus,
  setSyncFormatStatusListener,
} from '../../src/main/sync/sync-format-status'
import {
  checkPasswordCheckExists,
  ensurePasswordCheckValidated,
  passwordCheckTiming,
  replacePasswordAndValidate,
  resetPasswordCheckCache,
  setPasswordAndValidate,
  validatePasswordCheck,
} from '../../src/main/sync/sync-password'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'

type Stored = 'none' | 'decryptFailed' | 'keystoreUnavailable' | { readable: string }

type Seed = { name: string; raw: string } | { name: string; passwordCheck: string }

type Step =
  | { op: 'guard' }
  | { op: 'guardListing' }
  | { op: 'assertFormat' }
  | { op: 'ensureMarker' }
  | { op: 'ensureMarkerKnown' }
  | { op: 'formatStatus' }
  | { op: 'cachedFormatStatus' }
  | { op: 'forgetAccount' }
  | { op: 'validate'; password: string }
  | { op: 'ensureValidated'; password: string }
  | { op: 'set'; password: string }
  | { op: 'replace'; password: string }
  | { op: 'exists' }
  | { op: 'resetCache' }
  | { op: 'advance'; ms: number }
  | { op: 'hideNew'; on: boolean }
  | { op: 'failNext'; what: 'list' | 'download' | 'create' | 'delete' }
  | { op: 'localState'; content: string | null }
  | { op: 'signedIn'; value: boolean }
  | { op: 'stored'; value: Stored }
  | { op: 'seed'; files: Seed[] }
  | { op: 'rewrite'; id: string; password: string }
  | { op: 'parallel'; steps: Step[] }

interface Scenario {
  name: string
  steps: Step[]
}

const pc = (password: string): Seed => ({ name: 'password-check.enc', passwordCheck: password })
const raw = (name: string, content = '{}'): Seed => ({ name, raw: content })
const marker = (version: number): Seed => raw(`sync-format-v${version}.json`, JSON.stringify({ type: 'sync-format', version }))
const VALID_STATE = JSON.stringify({ version: 1, target: 'new', step: 'reencrypting', lockId: 'lock-1', startedAt: 5 })
const NEWER = SYNC_FORMAT_VERSION + 1

const SCENARIOS: Scenario[] = [
  { name: 'nothing blocks an empty Drive', steps: [{ op: 'guard' }, { op: 'guardListing' }, { op: 'assertFormat' }] },
  {
    name: 'a local change state blocks without listing',
    steps: [{ op: 'localState', content: VALID_STATE }, { op: 'guard' }, { op: 'guardListing' }, { op: 'assertFormat' }],
  },
  {
    name: 'an unreadable local change state blocks',
    steps: [
      { op: 'localState', content: 'not json' },
      { op: 'guard' },
      { op: 'localState', content: JSON.stringify({ version: 2 }) },
      { op: 'guard' },
      { op: 'localState', content: null },
      { op: 'guard' },
    ],
  },
  {
    name: 'a lock of another device blocks',
    steps: [{ op: 'seed', files: [raw('password-change-lock.json')] }, { op: 'guard' }, { op: 'guardListing' }, { op: 'assertFormat' }],
  },
  {
    name: 'a newer marker blocks first and is noted',
    steps: [
      { op: 'seed', files: [raw('password-change-lock.json'), marker(SYNC_FORMAT_VERSION), marker(NEWER)] },
      { op: 'cachedFormatStatus' },
      { op: 'guard' },
      { op: 'cachedFormatStatus' },
      { op: 'guardListing' },
      { op: 'assertFormat' },
      { op: 'formatStatus' },
    ],
  },
  {
    name: 'the marker is created once and then seen',
    steps: [{ op: 'ensureMarker' }, { op: 'ensureMarker' }, { op: 'ensureMarkerKnown' }],
  },
  {
    name: 'a created marker missing from listings is not created again until the memory expires',
    steps: [
      { op: 'hideNew', on: true },
      { op: 'ensureMarker' },
      { op: 'ensureMarker' },
      { op: 'advance', ms: CREATED_MEMORY_MS - 1 },
      { op: 'ensureMarker' },
      { op: 'ensureMarkerKnown' },
      { op: 'advance', ms: 2 },
      { op: 'ensureMarker' },
    ],
  },
  {
    name: 'smaller markers are deleted once ours is listed',
    steps: [
      { op: 'seed', files: [marker(SYNC_FORMAT_VERSION - 1), marker(0), raw('sync-format-vx.json'), marker(NEWER)] },
      { op: 'hideNew', on: true },
      { op: 'ensureMarker' },
      { op: 'ensureMarker' },
      { op: 'hideNew', on: false },
      { op: 'ensureMarker' },
    ],
  },
  {
    name: 'a failed delete of a smaller marker does not fail',
    steps: [
      { op: 'seed', files: [marker(SYNC_FORMAT_VERSION - 1), marker(SYNC_FORMAT_VERSION)] },
      { op: 'failNext', what: 'delete' },
      { op: 'ensureMarker' },
    ],
  },
  {
    name: 'a failed marker create fails and the next one creates it',
    steps: [{ op: 'failNext', what: 'create' }, { op: 'ensureMarker' }, { op: 'ensureMarker' }],
  },
  {
    name: 'markers seen missing at once are created once',
    steps: [{ op: 'parallel', steps: [{ op: 'ensureMarker' }, { op: 'ensureMarker' }, { op: 'ensureMarker' }] }],
  },
  {
    name: 'sign-out forgets the created marker',
    steps: [{ op: 'hideNew', on: true }, { op: 'ensureMarker' }, { op: 'forgetAccount' }, { op: 'ensureMarker' }],
  },
  {
    name: 'the format status follows the markers',
    steps: [
      { op: 'formatStatus' },
      { op: 'seed', files: [marker(SYNC_FORMAT_VERSION - 1), marker(SYNC_FORMAT_VERSION)] },
      { op: 'formatStatus' },
      { op: 'formatStatus' },
      { op: 'seed', files: [marker(NEWER)] },
      { op: 'formatStatus' },
      { op: 'forgetAccount' },
      { op: 'cachedFormatStatus' },
      { op: 'failNext', what: 'list' },
      { op: 'formatStatus' },
      { op: 'formatStatus' },
    ],
  },
  {
    name: 'the password-check is created with the marker first and validated once',
    steps: [
      { op: 'validate', password: 'pw' },
      { op: 'ensureValidated', password: 'pw' },
      { op: 'ensureValidated', password: 'other' },
      { op: 'ensureValidated', password: 'pw' },
      { op: 'resetCache' },
      { op: 'ensureValidated', password: 'pw' },
    ],
  },
  {
    name: 'a created password-check missing from listings is opened by id',
    steps: [
      { op: 'hideNew', on: true },
      { op: 'ensureValidated', password: 'pw' },
      { op: 'ensureValidated', password: 'pw' },
      { op: 'ensureValidated', password: 'other' },
      { op: 'advance', ms: CREATED_MEMORY_MS },
      { op: 'ensureValidated', password: 'pw' },
    ],
  },
  {
    name: 'password-checks seen missing at once are created once',
    steps: [{ op: 'parallel', steps: [{ op: 'ensureValidated', password: 'pw' }, { op: 'ensureValidated', password: 'other' }] }],
  },
  {
    name: 'the newest of two password-checks is the one validated',
    steps: [
      { op: 'seed', files: [pc('new'), pc('old')] },
      { op: 'validate', password: 'old' },
      { op: 'rewrite', id: 'fake-1', password: 'new' },
      { op: 'ensureValidated', password: 'old' },
      { op: 'ensureValidated', password: 'new' },
    ],
  },
  {
    name: 'set creates the marker and the password-check and refuses a second set',
    steps: [{ op: 'set', password: 'pw' }, { op: 'set', password: 'again' }, { op: 'ensureValidated', password: 'pw' }, { op: 'exists' }],
  },
  {
    name: 'set over an undecryptable password validates against Drive',
    steps: [
      { op: 'stored', value: 'decryptFailed' },
      { op: 'seed', files: [pc('pw')] },
      { op: 'set', password: 'wrong' },
      { op: 'set', password: 'pw' },
    ],
  },
  {
    name: 'set is refused before Drive without a key store, with a local change, or a lock',
    steps: [
      { op: 'stored', value: 'keystoreUnavailable' },
      { op: 'set', password: 'pw' },
      { op: 'stored', value: 'none' },
      { op: 'localState', content: VALID_STATE },
      { op: 'set', password: 'pw' },
      { op: 'localState', content: null },
      { op: 'seed', files: [raw('password-change-lock.json')] },
      { op: 'set', password: 'pw' },
    ],
  },
  {
    name: 'set stores no password when the marker cannot be created',
    steps: [{ op: 'failNext', what: 'create' }, { op: 'set', password: 'pw' }, { op: 'exists' }],
  },
  {
    name: 'replace stores only a password that opens the password-check',
    steps: [
      { op: 'stored', value: { readable: 'old' } },
      { op: 'seed', files: [pc('new')] },
      { op: 'replace', password: 'typo' },
      { op: 'failNext', what: 'download' },
      { op: 'replace', password: 'new' },
      { op: 'replace', password: 'new' },
      { op: 'ensureValidated', password: 'new' },
    ],
  },
  {
    name: 'replace is refused without a password-check, signed out, without a key store, or with a newer marker',
    steps: [
      { op: 'stored', value: { readable: 'old' } },
      { op: 'replace', password: 'new' },
      { op: 'signedIn', value: false },
      { op: 'replace', password: 'new' },
      { op: 'signedIn', value: true },
      { op: 'stored', value: 'keystoreUnavailable' },
      { op: 'replace', password: 'new' },
      { op: 'stored', value: { readable: 'old' } },
      { op: 'seed', files: [pc('new'), marker(NEWER)] },
      { op: 'replace', password: 'new' },
    ],
  },
  {
    name: 'exists lists every file',
    steps: [{ op: 'exists' }, { op: 'seed', files: [pc('pw')] }, { op: 'exists' }],
  },
]

// --- Running a scenario ---

let now = START_MS
let formatEvents: Array<SyncFormatStatus | null> = []

function localStatePath(): string {
  return join(seededUserData, 'local', 'auth', 'sync-password-change.json')
}

let seededUserData = ''

function validatedSummary(): { id: string; modifiedTime: string } | null {
  const v = syncRuntime.validatedPasswordCheck
  return v ? { id: v.id, modifiedTime: v.modifiedTime } : null
}

function storedSummary(): Stored {
  const s = stored.state
  return s.kind === 'readable' ? { readable: s.password } : s.kind
}

async function seedFile(seed: Seed): Promise<void> {
  if ('raw' in seed) {
    createFile(seed.name, seed.raw)
  } else {
    createFile(seed.name, JSON.stringify(await encrypt(JSON.stringify({ type: 'password-check', version: 1 }), seed.passwordCheck, 'password-check')))
  }
}

async function runOp(step: Step): Promise<unknown> {
  switch (step.op) {
    case 'guard':
      return getSyncBlock()
    case 'guardListing': {
      const generation = syncFormatGeneration()
      return getSyncBlock(await listFiles(), generation)
    }
    case 'assertFormat':
      await assertSyncFormatSupported()
      return null
    case 'ensureMarker': {
      const generation = syncFormatGeneration()
      await ensureSyncFormatMarker(await listFiles(), generation)
      return null
    }
    case 'ensureMarkerKnown':
      await ensureSyncFormatMarkerKnown()
      return null
    case 'formatStatus':
      return refreshSyncFormatStatus()
    case 'cachedFormatStatus':
      return getCachedSyncFormatStatus()
    case 'forgetAccount':
      resetPasswordCheckCache()
      clearSyncFormatStatus()
      return null
    case 'validate': {
      await validatePasswordCheck(step.password, await listFiles())
      return null
    }
    case 'ensureValidated': {
      await ensurePasswordCheckValidated(step.password, await listFiles())
      return null
    }
    case 'set':
      await setPasswordAndValidate(step.password)
      return null
    case 'replace':
      await replacePasswordAndValidate(step.password)
      return null
    case 'exists':
      return checkPasswordCheckExists()
    case 'resetCache':
      resetPasswordCheckCache()
      return null
    case 'parallel': {
      const results = await Promise.allSettled(step.steps.map((s) => runOp(s)))
      return results.map((r) => (r.status === 'fulfilled' ? { ok: r.value } : { error: (r.reason as Error).message }))
    }
    default:
      throw new Error(`not a Drive step: ${step.op}`)
  }
}

/** Applies a step that sets the scene; false for a step that runs code under test. */
async function arrange(step: Step): Promise<boolean> {
  switch (step.op) {
    case 'advance':
      now += step.ms
      return true
    case 'hideNew':
      drive.hideNew = step.on
      if (!step.on) drive.hidden.clear()
      return true
    case 'failNext':
      drive.failNext.set(step.what, step.what)
      return true
    case 'localState':
      mkdirSync(join(seededUserData, 'local', 'auth'), { recursive: true })
      if (step.content === null) {
        rmSync(localStatePath(), { force: true })
      } else {
        writeFileSync(localStatePath(), step.content)
      }
      forgetChangeStateCache()
      return true
    case 'signedIn':
      auth.signedIn = step.value
      return true
    case 'stored':
      stored.state = typeof step.value === 'string' ? { kind: step.value } : { kind: 'readable', password: step.value.readable }
      return true
    case 'seed':
      for (const seed of step.files) await seedFile(seed)
      return true
    case 'rewrite': {
      const file = drive.files.find((f) => f.id === step.id)!
      file.content = JSON.stringify(await encrypt(JSON.stringify({ type: 'password-check', version: 1 }), step.password, 'password-check'))
      file.modifiedTime = tick()
      return true
    }
    default:
      return false
  }
}

async function runScenario(scenario: Scenario): Promise<unknown> {
  seededUserData = seedUserData()
  drive.files = []
  drive.nextId = 1
  drive.clockMs = 0
  drive.hideNew = false
  drive.hidden.clear()
  drive.failNext.clear()
  stored.state = { kind: 'none' }
  auth.signedIn = true
  now = START_MS
  forgetChangeStateCache()
  resetPasswordCheckCache()
  setSyncFormatStatusListener(null)
  clearSyncFormatStatus()
  formatEvents = []
  setSyncFormatStatusListener((status) => formatEvents.push(status))

  const steps: unknown[] = []
  for (const step of scenario.steps) {
    if (await arrange(step)) {
      steps.push({ step })
      continue
    }
    drive.events = []
    formatEvents = []
    let result: unknown
    try {
      result = { ok: (await runOp(step)) ?? null }
    } catch (err) {
      result = { error: (err as Error).message }
    }
    steps.push({ step, result, drive: drive.events, validated: validatedSummary(), formatEvents })
  }
  return {
    name: scenario.name,
    steps,
    files: drive.files.map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime })),
    stored: storedSummary(),
  }
}

describe('record the preflight fixtures', () => {
  it('records each scenario', async () => {
    vi.spyOn(syncFormatTiming, 'now').mockImplementation(() => now)
    vi.spyOn(passwordCheckTiming, 'now').mockImplementation(() => now)
    expect(syncFormatTiming.createdMemoryMs).toBe(CREATED_MEMORY_MS)
    expect(passwordCheckTiming.createdMemoryMs).toBe(CREATED_MEMORY_MS)
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
    writeJsonFixture(OUT, {
      syncFormatVersion: SYNC_FORMAT_VERSION,
      startMs: START_MS,
      scenarios,
    })
  }, 120_000)
})
