// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the Analyze sync and the Data modal's reads of the
// typing data on Drive of src-tauri/crates/pipette-sync (analytics.rs,
// typing_remote.rs). Runs the Electron main process's sync-analytics.ts,
// sync-typing-remote.ts and the `listRemoteFileNames` of sync-scan.ts in the
// sync fixture harness (harness.ts) on a seeded userData and the real
// better-sqlite3 cache, with the real envelope encryption and the real
// google-drive.ts against the Node fake Drive (scripts/fake-drive), which
// behaves as the Rust `InMemoryDrive` does. The requests go to
// www.googleapis.com as google-drive.ts writes them and are sent on to the
// fake Drive on 127.0.0.1; nothing else is reachable. The Analyze sync syncs
// one unit at a time (SYNC_CONCURRENCY 1), so its requests come in one order.
//
// Records, for each step of each scenario: what the call answered (or the
// message it threw), the Drive requests (a listing with the name it filters
// on), the Drive revisions recorded as handled and the files remembered as
// created, the units reported as applied, how many applies of this
// device's deleted ranges were queued (counted, not run) and the userData
// tree; and, for each scenario, the Drive files left behind (each data file
// as its decrypted plaintext).
//
// Writes src-tauri/crates/pipette-sync/tests/fixtures/ts_analytics_sync.json.
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

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_analytics_sync.json')

/** The machine id the Rust test gives its identity; with the harness's
 *  installation id it makes this device's hash. */
const MACHINE_ID = 'golden-machine'
const OWN = createHash('sha256').update(MACHINE_ID).update(FIXED_INSTALLATION_ID).digest('hex')
const REMOTE = 'remote-hash-1'
const OTHER = 'remote-hash-2'
const PASSWORD = 'golden-password'

const rec = vi.hoisted(() => ({
  signedIn: true,
  password: 'golden-password',
  applied: [] as string[],
  queued: 0,
}))

vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: rec.signedIn }),
  getAccessToken: async () => 'fixture-token',
  getAccountSub: async () => null,
}))
vi.mock('../../src/main/sync/sync-crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-crypto')>(),
  retrievePasswordResult: async () => ({ ok: true, password: rec.password }),
}))
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { createHash: hash } = await import('node:crypto')
  const { FIXED_INSTALLATION_ID: id } = await import('./harness')
  return { getMachineHash: vi.fn(async () => hash('sha256').update('golden-machine').update(id).digest('hex')) }
})
vi.mock('../../src/main/sync/typing-deleted-ranges-merge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/typing-deleted-ranges-merge')>(),
  queueOwnDeletedRangesApply: () => { rec.queued++ },
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
import { executeAnalyticsSync } from '../../src/main/sync/sync-analytics'
import {
  fetchRemoteTypingDay,
  hasAnyRemoteTypingData,
  listRemoteTypingDaysFor,
  listRemoteTypingHashesForUidFromCloud,
} from '../../src/main/sync/sync-typing-remote'
import { listRemoteFileNames } from '../../src/main/sync/sync-scan'
import { resetSyncRuntimeForTests, syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { resetPasswordCheckCache } from '../../src/main/sync/sync-password'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { TypingAnalyticsDB, resetTypingAnalyticsDBForTests, setTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { resetTypingAnalyticsForTests } from '../../src/main/typing-analytics/typing-analytics-state'
import { charMinuteRowId, minuteStatsRowId, scopeRowId, type JsonlRow } from '../../src/main/typing-analytics/jsonl/jsonl-row'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'

// ---- Inputs ----

const MINUTE = 60_000
const D0 = '2026-10-14'
const D1 = '2026-10-15'

/** A day file of `hash` for `uid`: its scope, then a minute-stats and a
 *  char-minute row at each minute of the day. */
function dayText(hash: string, uid: string, day: string, minutes: number[]): string {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  const scopeId = `${hash}|linux|${uid}`
  const rows: JsonlRow[] = [{
    id: scopeRowId(scopeId), kind: 'scope', updated_at: 1_000,
    payload: {
      id: scopeId, machineHash: hash, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64',
      keyboardUid: uid, keyboardVendorId: 1, keyboardProductId: 2, keyboardProductName: 'Pipette',
    },
  }]
  for (const m of minutes) {
    const ts = start + m * MINUTE
    rows.push({
      id: minuteStatsRowId(scopeId, ts, ''), kind: 'minute-stats', updated_at: 1_000,
      payload: {
        scopeId, minuteTs: ts, keystrokes: 3 + m, activeMs: 1_000, intervalAvgMs: 100, intervalMinMs: 50,
        intervalP25Ms: 75, intervalP50Ms: 100, intervalP75Ms: 150, intervalMaxMs: 200,
      },
    })
    rows.push({
      id: charMinuteRowId(scopeId, ts, '', 'a'), kind: 'char-minute', updated_at: 1_000,
      payload: { scopeId, minuteTs: ts, char: 'a', count: 2 + m },
    })
  }
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)
const dayPath = (uid: string, hash: string, day: string): string => `sync/keyboards/${uid}/devices/${hash}/${day}.jsonl`
const rangesPath = (uid: string, hash: string): string => `sync/keyboards/${uid}/devices/${hash}/deleted-ranges.json`
const dayUnit = (uid: string, hash: string, day: string): string => `keyboards/${uid}/devices/${hash}/days/${day}`
const rangesUnit = (uid: string, hash: string): string => `keyboards/${uid}/devices/${hash}/deleted-ranges`
const STATE_PATH = 'local/typing-analytics/sync_state.json'
const STATE = JSON.stringify({ _rev: 3, my_device_id: OWN, uploaded: {}, reconciled_at: {}, last_synced_at: 5_000 }, null, 2)

/** A range over minutes `fromMin`..`toMin` of `day`, cut off at its end. */
function range(id: string, day: string, fromMin: number, toMin: number): Record<string, unknown> {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  return { id, startMs: start + fromMin * MINUTE, endMs: start + toMin * MINUTE, cutoffMs: start + toMin * MINUTE }
}

const rangesText = (...entries: Record<string, unknown>[]): string => json({ version: 1, entries })

const dayBundle = (uid: string, hash: string, day: string, text: string): string =>
  JSON.stringify({ type: 'typing-analytics-device', key: `${uid}|${hash}|${day}`, index: { uid, entries: [] }, files: { 'data.jsonl': text } })
const rangesBundle = (uid: string, hash: string, text: string): string =>
  JSON.stringify({ type: 'typing-deleted-ranges', key: `${uid}|${hash}`, index: { uid, entries: [] }, files: { 'deleted-ranges.json': text } })

type DriveSeed =
  | { name: string; plaintext: string; unit: string }
  | { name: string; raw: string }
  | { name: 'password-check.enc'; passwordCheck: true }

const PASSWORD_CHECK: DriveSeed = { name: 'password-check.enc', passwordCheck: true }
const MARKER_NAME = `sync-format-v${SYNC_FORMAT_VERSION}.json`
const MARKER: DriveSeed = { name: MARKER_NAME, raw: JSON.stringify({ type: 'sync-format', version: SYNC_FORMAT_VERSION }) }
const unitSeed = (unit: string, plaintext: string): DriveSeed => ({ name: driveFileName(unit), plaintext, unit })
const rawSeed = (unit: string): DriveSeed => ({ name: driveFileName(unit), raw: '{}' })

type Call =
  | { analyticsSync: string }
  | { hasRemote: true }
  | { hashes: string }
  | { days: [string, string] }
  | { fetch: [string, string, string] }
  | { names: true }

interface Step {
  call: Call
  /** Whether the stored sign-in is there, from this step on. */
  signedIn?: boolean
  /** The stored password from this step on. */
  password?: string
  /** This machine's password-change state file (null removes it). */
  localState?: string | null
  /** Removes the Drive files of this name. */
  dropDrive?: string
  /** Adds a Drive file. */
  addDrive?: DriveSeed
  /** Failures the fake Drive gives the next requests. */
  faults?: Array<{ status: number; count: number; only: 'list' | 'download' | 'create' | 'update' | 'delete' }>
  /** Removes a local file. */
  removeLocal?: string
}

interface Scenario {
  name: string
  tree: Tree
  drive: DriveSeed[]
  steps: Step[]
}

const R1 = range('r1', D0, 1, 2)
const R2 = range('r2', D1, 3, 4)

const SCENARIOS: Scenario[] = [
  {
    name: 'the Analyze sync of one keyboard',
    tree: {
      [dayPath('kbA', OWN, D0)]: dayText(OWN, 'kbA', D0, [1]),
      [dayPath('kbA', OWN, D1)]: dayText(OWN, 'kbA', D1, [2]),
      [rangesPath('kbA', OWN)]: rangesText(range('o1', D0, 5, 6)),
      [rangesPath('kbA', REMOTE)]: rangesText(R1),
      [dayPath('kbB', OWN, D0)]: dayText(OWN, 'kbB', D0, [1]),
      [STATE_PATH]: STATE,
    },
    drive: [
      PASSWORD_CHECK,
      MARKER,
      rawSeed(dayUnit('kbA', OWN, D1)),
      unitSeed(dayUnit('kbA', REMOTE, D0), dayBundle('kbA', REMOTE, D0, dayText(REMOTE, 'kbA', D0, [1, 2, 3]))),
      unitSeed(rangesUnit('kbA', REMOTE), rangesBundle('kbA', REMOTE, rangesText(R1, R2))),
      unitSeed(dayUnit('kbB', REMOTE, D0), dayBundle('kbB', REMOTE, D0, dayText(REMOTE, 'kbB', D0, [1]))),
      unitSeed(dayUnit('kbAB', REMOTE, D0), dayBundle('kbAB', REMOTE, D0, dayText(REMOTE, 'kbAB', D0, [1]))),
    ],
    steps: [
      { call: { analyticsSync: 'kbA' } },
      { call: { analyticsSync: 'kbA' } },
      { localState: 'not json', call: { analyticsSync: 'kbA' } },
      { localState: null, addDrive: { name: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, raw: '{}' }, call: { analyticsSync: 'kbA' } },
      { dropDrive: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, call: { analyticsSync: 'kbA' } },
      { dropDrive: MARKER_NAME, call: { analyticsSync: 'kbA' } },
      { faults: [{ status: 400, count: 1, only: 'download' }], call: { analyticsSync: 'kbA' } },
      { faults: [{ status: 400, count: 1, only: 'list' }], call: { analyticsSync: 'kbA' } },
      { password: 'wrong-password', call: { analyticsSync: 'kbA' } },
      { password: PASSWORD, signedIn: false, call: { analyticsSync: 'kbA' } },
      { signedIn: true, call: { analyticsSync: 'kbB' } },
    ],
  },
  {
    name: 'the reads of other devices\' days',
    tree: { [STATE_PATH]: STATE },
    drive: [
      PASSWORD_CHECK,
      MARKER,
      unitSeed(dayUnit('kbA', REMOTE, D0), dayBundle('kbA', REMOTE, D0, dayText(REMOTE, 'kbA', D0, [1, 2, 3]))),
      unitSeed(dayUnit('kbA', REMOTE, D1), dayBundle('kbA', REMOTE, D1, dayText(REMOTE, 'kbA', D1, [3, 4]))),
      unitSeed(rangesUnit('kbA', REMOTE), rangesBundle('kbA', REMOTE, rangesText(R1))),
      rawSeed(dayUnit('kbA', OTHER, D0)),
      rawSeed(dayUnit('kbA', OWN, D0)),
      rawSeed(dayUnit('kbB', REMOTE, D0)),
    ],
    steps: [
      { call: { hasRemote: true } },
      { call: { hashes: 'kbA' } },
      { call: { hashes: 'kbC' } },
      { call: { days: ['kbA', REMOTE] } },
      { call: { days: ['kbA', OWN] } },
      { call: { names: true } },
      { call: { fetch: ['kbA', REMOTE, D0] } },
      { call: { fetch: ['kbA', REMOTE, D1] } },
      { removeLocal: rangesPath('kbA', REMOTE), call: { fetch: ['kbA', REMOTE, D1] } },
      { call: { fetch: ['kbA', REMOTE, '2026-01-01'] } },
      { call: { fetch: ['kbA', OWN, D0] } },
      { faults: [{ status: 400, count: 1, only: 'download' }], call: { fetch: ['kbA', REMOTE, D0] } },
      { faults: [{ status: 400, count: 1, only: 'list' }], call: { hasRemote: true } },
      { password: 'wrong-password', call: { fetch: ['kbA', REMOTE, D0] } },
      { call: { hasRemote: true } },
      { password: PASSWORD, localState: 'not json', call: { hasRemote: true } },
      { call: { fetch: ['kbA', REMOTE, D0] } },
      { call: { names: true } },
      { localState: null, addDrive: { name: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, raw: '{}' }, call: { days: ['kbA', REMOTE] } },
      { dropDrive: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`, signedIn: false, call: { hashes: 'kbA' } },
      { call: { names: true } },
    ],
  },
]

// ---- Running ----

const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'

function summarize(url: URL, init: RequestInit | undefined): string {
  const method = (init?.method ?? 'GET').toUpperCase()
  const id = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1]
  if (method === 'GET' && url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q')
    const name = q === null ? '*' : /^name contains '((?:[^'\\]|\\.)*)'$/.exec(q)?.[1]?.replace(/\\(.)/g, '$1') ?? q
    return `list ${name}`
  }
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

async function run(call: Call): Promise<unknown> {
  if ('analyticsSync' in call) return executeAnalyticsSync(call.analyticsSync)
  if ('hasRemote' in call) return hasAnyRemoteTypingData()
  if ('hashes' in call) return listRemoteTypingHashesForUidFromCloud(call.hashes)
  if ('days' in call) return listRemoteTypingDaysFor(...call.days)
  if ('fetch' in call) return fetchRemoteTypingDay(...call.fetch)
  const names = await listRemoteFileNames()
  return names === null ? null : [...names].sort()
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0)

describe('analytics sync fixtures', () => {
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
    resetTypingAnalyticsForTests()
    Object.assign(rec, { signedIn: true, password: PASSWORD, applied: [], queued: 0 })
    const userData = seedUserData(scenario.tree)
    mkdirSync(`${userData}-paths`, { recursive: true })
    const db = new TypingAnalyticsDB(join(`${userData}-paths`, 'cache.db'))
    setTypingAnalyticsDBForTests(db)
    forgetChangeStateCache()
    for (const seed of scenario.drive) drive.state.create(seed.name, Buffer.from(await seedContent(seed)), 'application/json')

    const requests: string[] = []
    const guarded = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
      requests.push(summarize(url, init))
      return guarded(`${drive.url}${url.pathname}${url.search}`, init)
    }) as typeof fetch
    try {
      const steps = []
      for (const step of scenario.steps) {
        if (step.signedIn !== undefined) rec.signedIn = step.signedIn
        if (step.password !== undefined) rec.password = step.password
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
        if (step.removeLocal !== undefined) rmSync(join(userData, step.removeLocal), { force: true })
        for (const fault of step.faults ?? []) drive.state.inject(fault)
        requests.length = 0
        rec.applied = []
        rec.queued = 0
        let result: unknown
        try {
          result = { value: await run(step.call) }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) }
        }
        await settleFlushChain()
        steps.push({
          step,
          result,
          requests: [...requests],
          remote: [...syncRuntime.lastKnownRemoteState].sort(byName).map(([name, r]) => [name, r.id, r.modifiedTime]),
          created: [...syncRuntime.createdFileIds].sort(byName),
          applied: [...rec.applied],
          queuedApplies: rec.queued,
          tree: readTree(userData),
        })
      }
      const files = []
      for (const file of drive.state.files) files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, ...await driveContent(file.content) })
      return {
        name: scenario.name,
        tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
        drive: scenario.drive,
        steps,
        driveAfter: files,
      }
    } finally {
      globalThis.fetch = guarded
      resetTypingAnalyticsDBForTests()
    }
  }

  it('records every scenario', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
    expect(scenarios.length).toBe(SCENARIOS.length)
    writeJsonFixture(OUT, {
      about: 'The Analyze sync and the reads of the typing data on Drive of the TypeScript sync code. Generated by scripts/sync-fixtures/record-analytics-sync-fixtures.test.ts; do not edit.',
      machineId: MACHINE_ID,
      ownHash: OWN,
      password: PASSWORD,
      now: FIXED_NOW,
      scenarios,
    })
  }, 300_000)
})
