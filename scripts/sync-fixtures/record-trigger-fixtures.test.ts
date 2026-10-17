// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the automatic triggers of src-tauri/crates/pipette-sync
// (flush.rs, polling.rs, trash/tidy.rs). Runs the Electron main process's
// sync-flush.ts, sync-polling.ts and sync-trash.ts in the sync fixture
// harness (harness.ts) on a seeded userData, with the real envelope
// encryption and the real google-drive.ts against the Node fake Drive
// (scripts/fake-drive), as record-execute-fixtures.test.ts does. A pass
// syncs one unit at a time (SYNC_CONCURRENCY 1), so its requests come in
// one order. The clock stands at FIXED_NOW, which also dates the trash
// names and decides which trash has expired.
//
// Records, for each step (a flush pass or a poll pass, after the changes
// the step makes): every progress report, the Drive requests, the pending
// units with their owner and the held ones, the Drive revisions recorded as
// handled, the files remembered as created, the units reported as applied,
// and when the flush timer fires afterwards (it is then cleared, so no
// timer runs during the recording); and for each scenario, the userData
// tree and the Drive files (each data file as its decrypted plaintext) left
// behind.
//
// Writes src-tauri/crates/pipette-sync/tests/fixtures/ts_triggers.json.
//
// Run: pnpm run generate:sync-fixtures

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { startFakeDrive, type FakeDrive } from '../fake-drive/server'
import { logRequest } from './drive-request-log'
import { FIXED_INSTALLATION_ID, FIXED_NOW, readTree, seedUserData, type Tree } from './harness'
import { settleFlushChain } from './flush-chain'
import type { SyncProgress } from '../../src/shared/types/sync'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_triggers.json')

/** The machine id the Rust test gives its identity; with the harness's
 *  installation id it makes this device's hash. */
const MACHINE_ID = 'golden-machine'
const OWN = createHash('sha256').update(MACHINE_ID).update(FIXED_INSTALLATION_ID).digest('hex')
const PASSWORD = 'golden-password'
const DAY_MS = 86_400_000

type Stored = 'ok' | 'wrong' | 'decryptFailed' | 'keystoreUnavailable' | 'noPasswordFile'

const rec = vi.hoisted(() => ({
  sub: null as string | null,
  signedIn: true,
  autoSync: true,
  stored: 'ok' as string,
  applied: [] as string[],
}))

vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: rec.signedIn }),
  getAccessToken: async () => 'fixture-token',
  getAccountSub: async () => rec.sub,
}))
vi.mock('../../src/main/sync/sync-crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-crypto')>(),
  retrievePasswordResult: async () => {
    if (rec.stored === 'ok') return { ok: true, password: 'golden-password' }
    if (rec.stored === 'wrong') return { ok: true, password: 'wrong-password' }
    return { ok: false, reason: rec.stored }
  },
}))
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { createHash: hash } = await import('node:crypto')
  const { FIXED_INSTALLATION_ID: id } = await import('./harness')
  return { getMachineHash: vi.fn(async () => hash('sha256').update('golden-machine').update(id).digest('hex')) }
})
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: () => ({
    listLocalKeyboardUids: () => [],
    tombstoneRowsForUidHashInRanges: () => ({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }),
    getConnection: () => ({ transaction: <T>(fn: () => T) => fn }),
  }),
}))
vi.mock('../../src/main/sync/typing-deleted-ranges-merge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/typing-deleted-ranges-merge')>(),
  queueOwnDeletedRangesApply: () => {},
}))
vi.mock('../../src/main/sync/sync-runtime-state', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-runtime-state')>(),
  SYNC_CONCURRENCY: 1,
}))
vi.mock('../../src/main/sync/sync-service', async () => {
  const { markPending } = await import('../../src/main/sync/sync-runtime-state')
  return { notifyChange: (unit: string) => markPending(unit) }
})
vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload?: { syncUnit?: string }) => {
    if (channel === 'sync:unit-applied' && payload?.syncUnit) rec.applied.push(payload.syncUnit)
  },
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: rec.autoSync })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

import { decrypt, encrypt } from '../../src/main/sync/sync-crypto'
import { driveFileName } from '../../src/main/sync/google-drive'
import { trashFileName } from '../../src/main/sync/drive-trash'
import { flushPendingChanges, notifyChange } from '../../src/main/sync/sync-flush'
import { startPolling, stopPolling, waitForPollPassForTests } from '../../src/main/sync/sync-polling'
import { clearFlushTimer, markPending, resetSyncRuntimeForTests, setProgressCallback, syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { resetPasswordCheckCache } from '../../src/main/sync/sync-password'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'

// ---- Inputs ----

const D = (n: number): string => new Date(FIXED_NOW - n * DAY_MS).toISOString()
const json = (value: unknown): string => JSON.stringify(value, null, 2)
const clocks = (at: string) => ({ created: at, body: at, name: at, hub: at })

function favIndex(ty: string, ids: string[]) {
  return { type: ty, entries: ids.map((id) => ({ id, label: `Fav ${id}`, filename: `${ty}_${id}.json`, savedAt: D(10), updatedAt: D(10), clocks: clocks(D(10)) })) }
}

function favTree(ty: string, ids: string[]): Tree {
  const tree: Tree = { [`sync/favorites/${ty}/index.json`]: json(favIndex(ty, ids)) }
  for (const id of ids) tree[`sync/favorites/${ty}/${ty}_${id}.json`] = `{"id":"${id}"}`
  return tree
}

function favBundle(ty: string, ids: string[]): string {
  const files: Record<string, string> = {}
  for (const id of ids) files[`${ty}_${id}.json`] = `{"id":"${id}"}`
  return JSON.stringify({ type: 'favorite', key: ty, index: favIndex(ty, ids), files })
}

function settingsBundle(uid: string, at: string): string {
  return JSON.stringify({
    type: 'settings', key: uid, index: { uid, entries: [] },
    files: { 'pipette_settings.json': JSON.stringify({ theme: 'remote', _updatedAt: at }) },
  })
}

type DriveSeed =
  | { name: string; plaintext: string; unit: string; trashRenamedAt?: number }
  | { name: string; raw: string; trashRenamedAt?: number }
  | { name: 'password-check.enc'; passwordCheck: true }

const PASSWORD_CHECK: DriveSeed = { name: 'password-check.enc', passwordCheck: true }
const MARKER: DriveSeed = { name: `sync-format-v${SYNC_FORMAT_VERSION}.json`, raw: JSON.stringify({ type: 'sync-format', version: SYNC_FORMAT_VERSION }) }
const unitSeed = (unit: string, plaintext: string, trashRenamedAt?: number): DriveSeed =>
  ({ name: driveFileName(unit), plaintext, unit, ...(trashRenamedAt === undefined ? {} : { trashRenamedAt }) })

interface Step {
  run: 'flush' | 'poll'
  /** The account the stored sign-in belongs to from this step on. */
  sub?: string | null
  signedIn?: boolean
  autoSync?: boolean
  stored?: Stored
  /** Changes noted before the pass (`notifyChange`). */
  notify?: string[]
  /** Failures the fake Drive gives the next requests. */
  faults?: Array<{ status: number; count: number; only: 'list' | 'download' | 'create' | 'update' | 'delete' }>
  /** This machine's password-change state file (null removes it). */
  localState?: string | null
  /** Writes a new revision of a unit's Drive file (its first copy). */
  rewrite?: { unit: string; plaintext: string }
}

interface Scenario {
  name: string
  tree: Tree
  drive: DriveSeed[]
  /** Units pending before the first step, and their owner. */
  pending?: string[]
  owner?: string
  steps: Step[]
}

const kbA = (path: string): string => `sync/keyboards/kbA/${path}`
const ownDay = (day: string): string => `keyboards/kbA/devices/${OWN}/days/${day}`

const SCENARIOS: Scenario[] = [
  {
    name: 'flush passes and their retries',
    tree: { ...favTree('macro', ['a']), ...favTree('tapDance', ['t']) },
    drive: [PASSWORD_CHECK, MARKER],
    pending: ['favorites/macro'],
    steps: [
      { run: 'flush', sub: 'sub-1' },
      { run: 'flush', notify: ['favorites/tapDance'], faults: [{ status: 400, count: 1, only: 'create' }] },
      { run: 'flush' },
      { run: 'flush', notify: ['favorites/macro'], autoSync: false },
      { run: 'flush', autoSync: true, stored: 'decryptFailed' },
      { run: 'flush', stored: 'noPasswordFile' },
      { run: 'flush', stored: 'ok', signedIn: false },
      { run: 'flush', signedIn: true, faults: [{ status: 400, count: 1, only: 'list' }] },
      { run: 'flush', localState: 'not json' },
      { run: 'flush', localState: null, stored: 'wrong' },
      { run: 'flush', stored: 'ok', sub: 'sub-2' },
    ],
  },
  {
    name: 'polls of a device with one keyboard',
    tree: { [kbA('pipette_settings.json')]: JSON.stringify({ theme: 'local', _updatedAt: D(9) }) },
    drive: [
      PASSWORD_CHECK,
      MARKER,
      unitSeed('favorites/tapDance', favBundle('tapDance', ['r1'])),
      unitSeed('keyboards/kbA/settings', settingsBundle('kbA', D(1))),
      unitSeed('keyboards/kbB/settings', settingsBundle('kbB', D(1))),
      unitSeed('keyboards/kbA/devices/other1/days/2026-10-14', '{}'),
      unitSeed('keyboards/kbA/runs', '{}'),
      unitSeed('favorites/combo', JSON.stringify({ type: 'favorite', key: 'combo', index: { entries: 5 } })),
      { name: 'favorites_macro.enc', raw: 'not json' },
    ],
    steps: [
      { run: 'poll', sub: 'sub-1' },
      { run: 'poll' },
      { run: 'poll', rewrite: { unit: 'favorites/tapDance', plaintext: favBundle('tapDance', ['r1', 'r2']) } },
      { run: 'poll', stored: 'decryptFailed' },
      { run: 'poll', stored: 'ok', localState: 'not json' },
    ],
  },
  {
    name: 'the tidying of names with several copies after a poll',
    tree: { [kbA('pipette_settings.json')]: JSON.stringify({ theme: 'local', _updatedAt: D(9) }) },
    drive: [
      PASSWORD_CHECK,
      MARKER,
      unitSeed('favorites/macro', favBundle('macro', ['a'])),
      unitSeed('favorites/macro', favBundle('macro', ['a', 'b'])),
      unitSeed('favorites/tapDance', favBundle('tapDance', ['t'])),
      unitSeed('favorites/tapDance', favBundle('tapDance', ['old']), FIXED_NOW - 31 * DAY_MS),
      unitSeed('favorites/tapDance', favBundle('tapDance', ['young']), FIXED_NOW - DAY_MS),
      unitSeed('favorites/combo', favBundle('combo', ['c1']), FIXED_NOW - 2 * DAY_MS),
      unitSeed('favorites/combo', favBundle('combo', ['c2']), FIXED_NOW - 3 * DAY_MS),
      unitSeed(ownDay('2026-10-01'), '{}', FIXED_NOW - DAY_MS),
      unitSeed('keyboards/kbA/devices/other1/days/2026-10-01', '{}'),
      unitSeed('keyboards/kbA/devices/other1/days/2026-10-01', '{}'),
      unitSeed('keyboards/kbB/settings', settingsBundle('kbB', D(1))),
      unitSeed('keyboards/kbB/settings', settingsBundle('kbB', D(2))),
    ],
    steps: [
      { run: 'poll', sub: 'sub-1' },
      { run: 'poll' },
    ],
  },
]

// ---- Running ----

const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'

function summarize(url: URL, init: RequestInit | undefined): string {
  const method = (init?.method ?? 'GET').toUpperCase()
  const id = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1]
  if (method === 'GET' && url.pathname === '/drive/v3/files') return 'list'
  if (method === 'GET' && id) return `download ${id}`
  if (method === 'DELETE' && id) return `delete ${id}`
  if (method === 'PATCH' && id) return url.pathname.startsWith('/upload/') ? `update ${id}` : `rename ${id}`
  if (method === 'POST') {
    const body = logRequest(url, init).body
    const meta = body && 'parts' in body ? body.parts[0]?.json as { name?: string } | undefined : undefined
    return `create ${meta?.name ?? '?'}`
  }
  return `${method} ${url.pathname}`
}

async function seedContent(seed: DriveSeed): Promise<string> {
  if ('raw' in seed) return seed.raw
  if ('passwordCheck' in seed) {
    return JSON.stringify(await encrypt(JSON.stringify({ type: 'password-check', version: 1 }), PASSWORD, 'password-check'))
  }
  return JSON.stringify(await encrypt(seed.plaintext, PASSWORD, seed.unit))
}

/** A Drive file's content as the Rust test compares it: the plaintext of an
 *  envelope that opens, otherwise the text. */
async function driveContent(content: Buffer): Promise<{ plaintext: string } | { raw: string }> {
  const text = content.toString('utf8')
  try {
    return { plaintext: await decrypt(JSON.parse(text), PASSWORD) }
  } catch {
    return { raw: text }
  }
}

function pendingState() {
  return {
    units: [...syncRuntime.pendingChanges],
    owner: syncRuntime.pendingOwner,
    held: [...syncRuntime.heldPending].map(([sub, units]) => [sub, [...units]]),
  }
}

/** One poll pass: the delayed first pass of `startPolling`, at once. */
async function poll(): Promise<void> {
  startPolling({ firstPassDelayMs: 0 })
  // The first pass's timer fires before this one and starts the pass.
  await new Promise((resolve) => setTimeout(resolve, 0))
  stopPolling()
  await waitForPollPassForTests()
}

describe('trigger fixtures', () => {
  let drive: FakeDrive

  beforeAll(async () => {
    drive = await startFakeDrive()
  })

  afterAll(async () => {
    await drive.close()
  })

  async function seedDrive(seed: DriveSeed): Promise<void> {
    const file = drive.state.create(seed.name, Buffer.from(await seedContent(seed)), 'application/json')
    if ('trashRenamedAt' in seed && seed.trashRenamedAt !== undefined) {
      drive.state.rename(file.id, trashFileName(file, seed.trashRenamedAt)!)
    }
  }

  async function runScenario(scenario: Scenario) {
    drive.state.reset()
    resetSyncRuntimeForTests()
    resetPasswordCheckCache()
    clearSyncFormatStatus()
    Object.assign(rec, { sub: null, signedIn: true, autoSync: true, stored: 'ok', applied: [] })
    const userData = seedUserData(scenario.tree)
    forgetChangeStateCache()
    for (const seed of scenario.drive) await seedDrive(seed)
    if (scenario.owner !== undefined) syncRuntime.pendingOwner = scenario.owner
    for (const unit of scenario.pending ?? []) markPending(unit)

    const requests: string[] = []
    const guarded = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
      requests.push(summarize(url, init))
      return guarded(`${drive.url}${url.pathname}${url.search}`, init)
    }) as typeof fetch
    const progress: SyncProgress[] = []
    setProgressCallback((p) => progress.push({ ...p }))
    try {
      const steps = []
      for (const step of scenario.steps) {
        if (step.sub !== undefined) rec.sub = step.sub
        if (step.signedIn !== undefined) rec.signedIn = step.signedIn
        if (step.autoSync !== undefined) rec.autoSync = step.autoSync
        if (step.stored !== undefined) rec.stored = step.stored
        if (step.localState !== undefined) {
          const path = join(userData, 'local', 'auth', 'sync-password-change.json')
          if (step.localState === null) rmSync(path, { force: true })
          else {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, step.localState)
          }
          forgetChangeStateCache()
        }
        if (step.rewrite !== undefined) {
          const file = drive.state.files.find((f) => f.name === driveFileName(step.rewrite!.unit))!
          drive.state.update(file.id, Buffer.from(JSON.stringify(await encrypt(step.rewrite.plaintext, PASSWORD, step.rewrite.unit))))
        }
        for (const fault of step.faults ?? []) drive.state.inject(fault)
        requests.length = 0
        progress.length = 0
        rec.applied = []
        for (const unit of step.notify ?? []) notifyChange(unit)
        clearFlushTimer()
        if (step.run === 'flush') await flushPendingChanges()
        else await poll()
        const timer = syncRuntime.debounceDueAt === null ? null : syncRuntime.debounceDueAt - Date.now()
        clearFlushTimer()
        steps.push({
          step,
          progress: [...progress],
          requests: [...requests],
          pending: pendingState(),
          remote: [...syncRuntime.lastKnownRemoteState].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, r]) => [name, r.id, r.modifiedTime]),
          created: [...syncRuntime.createdFileIds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          applied: [...rec.applied],
          timer,
        })
      }
      await settleFlushChain()
      const files = []
      for (const file of drive.state.files) files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, ...await driveContent(file.content) })
      return {
        name: scenario.name,
        tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
        drive: scenario.drive,
        pending: scenario.pending ?? [],
        owner: scenario.owner ?? null,
        steps,
        treeAfter: readTree(userData),
        driveAfter: files,
      }
    } finally {
      globalThis.fetch = guarded
      setProgressCallback(() => {})
    }
  }

  it('records every scenario', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
    expect(scenarios.length).toBe(SCENARIOS.length)
    writeJsonFixture(OUT, {
      about: 'The flush, poll and tidying passes of the TypeScript sync code. Generated by scripts/sync-fixtures/record-trigger-fixtures.test.ts; do not edit.',
      machineId: MACHINE_ID,
      ownHash: OWN,
      password: PASSWORD,
      now: FIXED_NOW,
      scenarios,
    })
  }, 300_000)
})
