// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the executeSync passes of src-tauri/crates/pipette-sync
// (dispatch.rs, execute.rs, scope.rs). Runs the Electron main process's
// sync-execute.ts, sync-merge-dispatch.ts and sync-scope.ts in the sync
// fixture harness (harness.ts) on a seeded userData, with the real envelope
// encryption and the real google-drive.ts against the Node fake Drive
// (scripts/fake-drive), which behaves as the Rust `InMemoryDrive` does. The
// requests go to www.googleapis.com as google-drive.ts writes them and are
// sent on to the fake Drive on 127.0.0.1; nothing else is reachable. A pass
// syncs one unit at a time (SYNC_CONCURRENCY 1), so its requests come in
// one order.
//
// Records:
//   - the scope truth table: `matchesScope` and `shouldDownloadSyncUnit`
//     for units × scopes;
//   - pass scenarios: for each step, the result (or the error), every
//     progress report, the Drive requests, the pending units with their
//     owner and the held ones, the Drive revisions recorded as handled and
//     the files remembered as created, the units reported as applied, the
//     flushes asked for and the keyboard-name backfills; and, for each
//     scenario, the userData tree and the Drive files (each data file as
//     its decrypted plaintext) left behind.
//
// The typing-analytics cache is not used: the keyboards this device recorded
// typing for are given (the Rust test seeds its cache with the same day
// files), another device's merged ranges are not tombstoned anywhere, and
// the apply of this device's deleted ranges queued after a pass is counted,
// not run.
//
// Writes src-tauri/crates/pipette-sync/tests/fixtures/ts_execute.json.
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
import type { SyncProgress, SyncScope } from '../../src/shared/types/sync'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_execute.json')

/** The machine id the Rust test gives its identity; with the harness's
 *  installation id it makes this device's hash. */
const MACHINE_ID = 'golden-machine'
const OWN = createHash('sha256').update(MACHINE_ID).update(FIXED_INSTALLATION_ID).digest('hex')
const PASSWORD = 'golden-password'

const rec = vi.hoisted(() => ({
  sub: null as string | null,
  typingUids: [] as string[],
  flushes: [] as Array<number | null>,
  applied: [] as string[],
  backfillResolves: 0,
  backfillCalls: 0,
  queued: 0,
}))

vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: true }),
  getAccessToken: async () => 'fixture-token',
  getAccountSub: async () => rec.sub,
}))
vi.mock('../../src/main/sync/sync-crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-crypto')>(),
  retrievePasswordResult: async () => ({ ok: true, password: 'golden-password' }),
}))
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { createHash: hash } = await import('node:crypto')
  const { FIXED_INSTALLATION_ID: id } = await import('./harness')
  return { getMachineHash: vi.fn(async () => hash('sha256').update('golden-machine').update(id).digest('hex')) }
})
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: () => ({
    listLocalKeyboardUids: () => rec.typingUids,
    // Another device's merged ranges are tombstoned in the cache, which
    // the recording does not keep.
    tombstoneRowsForUidHashInRanges: () => ({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }),
    getConnection: () => ({ transaction: <T>(fn: () => T) => fn }),
  }),
}))
vi.mock('../../src/main/sync/typing-deleted-ranges-merge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/typing-deleted-ranges-merge')>(),
  queueOwnDeletedRangesApply: () => { rec.queued++ },
}))
vi.mock('../../src/main/sync/sync-flush', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-flush')>(),
  scheduleFlushIfPending: (delayMs?: number) => { rec.flushes.push(delayMs ?? null) },
}))
vi.mock('../../src/main/sync/keyboard-meta', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/keyboard-meta')>(),
  backfillKeyboardMeta: async () => {
    rec.backfillCalls++
    return { resolved: rec.backfillResolves, failed: [] }
  },
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
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

import { decrypt, encrypt } from '../../src/main/sync/sync-crypto'
import { driveFileName } from '../../src/main/sync/google-drive'
import { executeSync } from '../../src/main/sync/sync-execute'
import { matchesScope, shouldDownloadSyncUnit } from '../../src/main/sync/sync-scope'
import { markPending, resetSyncRuntimeForTests, setProgressCallback, syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { resetPasswordCheckCache } from '../../src/main/sync/sync-password'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { scopeRowId } from '../../src/main/typing-analytics/jsonl/jsonl-row'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'

// ---- Scope truth table ----

const TABLE_UNITS: Array<string | null> = [
  'favorites/macro', 'meta/keyboard-names', 'key-labels', 'typing-test-texts',
  'i18n/index', 'i18n/packs/p1', 'themes/index', 'themes/packs/t1',
  'keyboards/kbA/settings', 'keyboards/kbA/snapshots', 'keyboards/kbA/analyze_filters', 'keyboards/kbA/runs',
  'keyboards/kbA/devices/h1/days/2026-04-19', 'keyboards/kbA/devices/h1/deleted-ranges',
  'keyboards/kbB/settings', 'keyboards/kbB/runs', 'keyboards/kbB/devices/h1/days/2026-04-19',
  'keyboards/kbAB/settings', null, '',
]
const TABLE_SCOPES: SyncScope[] = [
  'all', 'favorites', 'packs', { keyboard: 'kbA' }, { favorites: true, keyboard: 'kbA' }, { keyboard: 'kbB' },
]

function scopeTable() {
  const local = new Set(['kbA'])
  return TABLE_SCOPES.map((scope) => ({
    scope,
    units: TABLE_UNITS.map((unit) => ({
      unit,
      matches: matchesScope(unit, scope),
      download: shouldDownloadSyncUnit(unit, scope, local),
    })),
  }))
}

// ---- Inputs ----

const D = (n: number): string => new Date(FIXED_NOW - n * 86_400_000).toISOString()
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

/** This device's day of `uid`: its scope row. */
function dayText(uid: string): string {
  const scopeId = `${OWN}|linux|${uid}`
  return JSON.stringify({
    id: scopeRowId(scopeId), kind: 'scope', updated_at: 1_000,
    payload: {
      id: scopeId, machineHash: OWN, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64',
      keyboardUid: uid, keyboardVendorId: 1, keyboardProductId: 2, keyboardProductName: 'Pipette',
    },
  }) + '\n'
}

const dayPath = (uid: string, hash: string, day: string): string => `sync/keyboards/${uid}/devices/${hash}/${day}.jsonl`
const dayFile = (uid: string, hash: string, day: string): string => `keyboards_${uid}_devices_${hash}_days_${day}.enc`
const STATE_PATH = 'local/typing-analytics/sync_state.json'

function state(uploaded: Record<string, string[]> = {}, reconciledAt: Record<string, number | null> = {}): string {
  return JSON.stringify({ _rev: 3, my_device_id: OWN, uploaded, reconciled_at: reconciledAt, last_synced_at: 5_000 }, null, 2)
}

type DriveSeed =
  | { name: string; plaintext: string; unit: string }
  | { name: string; raw: string }
  | { name: 'password-check.enc'; passwordCheck: true }

const PASSWORD_CHECK: DriveSeed = { name: 'password-check.enc', passwordCheck: true }
const MARKER: DriveSeed = { name: `sync-format-v${SYNC_FORMAT_VERSION}.json`, raw: JSON.stringify({ type: 'sync-format', version: SYNC_FORMAT_VERSION }) }
const unitSeed = (unit: string, plaintext: string): DriveSeed =>
  ({ name: driveFileName(unit), plaintext, unit })

interface Step {
  execute?: { direction: 'download' | 'upload'; scope: SyncScope }
  /** The account the stored sign-in belongs to from this step on. */
  sub?: string | null
  /** Failures the fake Drive gives the next requests. */
  faults?: Array<{ status: number; count: number; only: 'list' | 'download' | 'create' | 'update' | 'delete' }>
  /** How many keyboards the backfill names from this step on. */
  backfill?: number
  /** This machine's password-change state file (null removes it). */
  localState?: string | null
  /** Removes the Drive files of this name. */
  dropDrive?: string
  /** Adds a Drive file. */
  addDrive?: DriveSeed
}

interface Scenario {
  name: string
  tree: Tree
  drive: DriveSeed[]
  /** Units pending before the first step. */
  pending?: string[]
  /** The keyboards this device recorded typing for, and their day files. */
  typing?: { uids: string[]; days: string[] }
  steps: Step[]
}

const kbA = (path: string): string => `sync/keyboards/kbA/${path}`
const snapIndex = { uid: 'kbA', entries: [{ id: 's1', label: 'Snap', filename: 'KB_t_s1.pipette', savedAt: D(5), vilVersion: 2, updatedAt: D(5), clocks: clocks(D(5)) }] }
const RANGES = json({ version: 1, entries: [{ id: 'g1', startMs: 1000, endMs: 2000, cutoffMs: 3000 }] })
const runsBundle = (uid: string): string => JSON.stringify({ type: 'run-log', key: uid, index: { uid, entries: [] }, files: {} })
const emptyDayBundle = (uid: string, hash: string, day: string): string =>
  JSON.stringify({ type: 'typing-analytics-device', key: `${uid}|${hash}|${day}`, index: { uid, entries: [] }, files: { 'data.jsonl': '\n' } })

const SCENARIOS: Scenario[] = [
  {
    name: 'a first upload of everything, then a download and a keyboard upload',
    tree: {
      ...favTree('macro', ['a', 'b']),
      [kbA('pipette_settings.json')]: JSON.stringify({ theme: 'local', _updatedAt: D(3) }),
      [kbA('snapshots/index.json')]: json(snapIndex),
      [kbA('snapshots/KB_t_s1.pipette')]: 'SNAP',
      [dayPath('kbA', OWN, '2026-10-14')]: dayText('kbA'),
      [kbA('devices/other1/deleted-ranges.json')]: RANGES,
      [STATE_PATH]: state({}, { [`kbA|${OWN}`]: 5_000 }),
    },
    drive: [PASSWORD_CHECK, MARKER],
    pending: ['favorites/macro', 'keyboards/kbA/settings'],
    typing: { uids: ['kbA'], days: [dayText('kbA')] },
    steps: [
      { sub: 'sub-1', execute: { direction: 'upload', scope: 'all' } },
      { execute: { direction: 'download', scope: 'all' } },
      { execute: { direction: 'upload', scope: { keyboard: 'kbA' } } },
    ],
  },
  {
    name: 'downloads of each scope into a device with one keyboard',
    tree: {
      'sync/keyboards/kbC/pipette_settings.json': JSON.stringify({ theme: 'local', _updatedAt: D(9) }),
      [STATE_PATH]: state(),
    },
    drive: [
      PASSWORD_CHECK,
      MARKER,
      unitSeed('favorites/tapDance', favBundle('tapDance', ['r1'])),
      { name: 'favorites_combo.enc', raw: 'not json' },
      unitSeed('keyboards/kbB/settings', settingsBundle('kbB', D(1))),
      unitSeed('keyboards/kbC/settings', settingsBundle('kbC', D(1))),
      unitSeed('keyboards/kbC/devices/other1/days/2026-10-14', emptyDayBundle('kbC', 'other1', '2026-10-14')),
      unitSeed('keyboards/kbC/runs', runsBundle('kbC')),
      unitSeed('key-labels', JSON.stringify({ type: 'key-label', key: 'key-labels', index: { entries: [] }, files: {} })),
    ],
    steps: [
      { sub: 'sub-1', execute: { direction: 'download', scope: { favorites: true, keyboard: 'kbC' } } },
      { execute: { direction: 'download', scope: { keyboard: 'kbC' } } },
      { backfill: 2, execute: { direction: 'download', scope: 'all' } },
      { backfill: 0, execute: { direction: 'download', scope: { keyboard: 'kbB' } } },
      { execute: { direction: 'download', scope: 'packs' } },
    ],
  },
  {
    name: 'the reconcile of this device\'s days before an upload',
    tree: {
      [dayPath('kbA', OWN, '2026-10-15')]: dayText('kbA'),
      [STATE_PATH]: state({ [`kbA|${OWN}`]: ['2026-10-13'] }, { [`kbA|${OWN}`]: null }),
    },
    drive: [
      PASSWORD_CHECK,
      MARKER,
      { name: dayFile('kbA', OWN, '2026-10-13'), raw: '{}' },
      { name: dayFile('kbA', OWN, '2026-10-12'), raw: '{}' },
      { name: dayFile('kbA', 'other1', '2026-10-12'), raw: '{}' },
    ],
    typing: { uids: ['kbA'], days: [dayText('kbA')] },
    steps: [
      { execute: { direction: 'upload', scope: 'all' } },
      { execute: { direction: 'upload', scope: 'all' } },
    ],
  },
  {
    name: 'blocked, failing and partial passes',
    tree: { ...favTree('macro', ['a']), ...favTree('tapDance', ['t']), [STATE_PATH]: state() },
    drive: [PASSWORD_CHECK, MARKER, { name: 'password-change-lock.json', raw: '{}' }],
    pending: ['favorites/macro'],
    steps: [
      { localState: 'not json', execute: { direction: 'download', scope: 'all' } },
      { localState: null, execute: { direction: 'upload', scope: 'all' } },
      { dropDrive: 'password-change-lock.json', addDrive: { name: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, raw: '{}' }, execute: { direction: 'upload', scope: 'favorites' } },
      { dropDrive: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, faults: [{ status: 400, count: 1, only: 'list' }], execute: { direction: 'download', scope: 'all' } },
      { sub: 'sub-2', faults: [{ status: 400, count: 1, only: 'create' }], execute: { direction: 'upload', scope: 'favorites' } },
      { execute: { direction: 'upload', scope: 'favorites' } },
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

describe('executeSync fixtures', () => {
  let drive: FakeDrive

  beforeAll(async () => {
    drive = await startFakeDrive()
  })

  afterAll(async () => {
    await drive.close()
  })

  async function runScenario(scenario: Scenario) {
    drive.state.reset()
    resetSyncRuntimeForTests()
    resetPasswordCheckCache()
    clearSyncFormatStatus()
    Object.assign(rec, { sub: null, typingUids: scenario.typing?.uids ?? [], flushes: [], applied: [], backfillResolves: 0, backfillCalls: 0, queued: 0 })
    const userData = seedUserData(scenario.tree)
    forgetChangeStateCache()
    for (const seed of scenario.drive) drive.state.create(seed.name, Buffer.from(await seedContent(seed)), 'application/json')
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
        if (step.backfill !== undefined) rec.backfillResolves = step.backfill
        if (step.localState !== undefined) {
          const path = join(userData, 'local', 'auth', 'sync-password-change.json')
          if (step.localState === null) rmSync(path, { force: true })
          else {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, step.localState)
          }
          forgetChangeStateCache()
        }
        if (step.dropDrive !== undefined) drive.state.files = drive.state.files.filter((f) => f.name !== step.dropDrive)
        if (step.addDrive !== undefined) drive.state.create(step.addDrive.name, Buffer.from(await seedContent(step.addDrive)), 'application/json')
        for (const fault of step.faults ?? []) drive.state.inject(fault)
        requests.length = 0
        progress.length = 0
        rec.flushes = []
        rec.applied = []
        rec.backfillCalls = 0
        rec.queued = 0
        let result: unknown
        if (step.execute) {
          try {
            result = await executeSync(step.execute.direction, step.execute.scope)
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) }
          }
        }
        steps.push({
          step,
          result,
          progress: [...progress],
          requests: [...requests],
          pending: pendingState(),
          remote: [...syncRuntime.lastKnownRemoteState].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, r]) => [name, r.id, r.modifiedTime]),
          created: [...syncRuntime.createdFileIds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          applied: [...rec.applied],
          flushes: [...rec.flushes],
          backfills: rec.backfillCalls,
          queuedApplies: rec.queued,
        })
      }
      const files = []
      for (const file of drive.state.files) files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, ...await driveContent(file.content) })
      return {
        name: scenario.name,
        tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
        drive: scenario.drive,
        pending: scenario.pending ?? [],
        typing: scenario.typing ?? { uids: [], days: [] },
        steps,
        treeAfter: readTree(userData),
        driveAfter: files,
      }
    } finally {
      globalThis.fetch = guarded
      setProgressCallback(() => {})
    }
  }

  it('records the scope table and every scenario', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
    expect(scenarios.length).toBe(SCENARIOS.length)
    writeJsonFixture(OUT, {
      about: 'The executeSync passes and the scopes of the TypeScript sync code. Generated by scripts/sync-fixtures/record-execute-fixtures.test.ts; do not edit.',
      machineId: MACHINE_ID,
      ownHash: OWN,
      password: PASSWORD,
      now: FIXED_NOW,
      scopes: scopeTable(),
      scenarios,
    })
  }, 300_000)
})
