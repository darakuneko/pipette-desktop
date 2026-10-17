// SPDX-License-Identifier: GPL-2.0-or-later
// Interoperability of the two sync engines on one Drive: the Electron main
// process's sync code (machine 1, run here in the harness of the sync
// fixture generators) and the Rust engine of src-tauri/crates/pipette-sync
// (machine 2, its example sync_peer run once per step, over HTTP) share
// the Node fake Drive (scripts/fake-drive) with the same account and the
// same sync password, each with a userData and a machine hash of its own.
//
// Scenarios:
//   - both save and sync in turn, edits to one unit from both included:
//     both `sync/` trees end with the same values, nothing left pending.
//     A first download into machine 2 writes the bytes the Electron code
//     writes on an empty machine of its own; the trees of the two machines
//     are compared as values because a merge writes an entry's keys in
//     its own order while a store writes them in another. Then the
//     Electron code reads the userData the Rust engine synced
//     (a copy) with a download and an upload pass and changes nothing in
//     it, on Drive neither;
//   - a password change stopped half way (by failed uploads) on one
//     machine stops the sync of both until it is resumed; the other then
//     re-enters the new password and both converge — once with each
//     engine running the change;
//   - both create the same unit at once: two copies of one name on Drive;
//     the next syncs converge on the chosen copy and the Rust polling pass
//     moves the other copy to the trash;
//   - a sync-format marker newer than both: every pass and the password
//     change of both stop, and Drive is left as it was.
//
// Run: pnpm run test:sync-interop (after building the peer: cargo build
// -p pipette-sync --example sync_peer, from src-tauri). The peer binary
// may be given in PIPETTE_SYNC_PEER.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { cargoTargetDir } from '../fixture-files'
import { startFakeDrive, type FakeDrive } from '../fake-drive/server'
import { logRequest } from '../sync-fixtures/drive-request-log'
import { FIXED_NOW, assertSafePath, readTree, seedUserData, useUserData, writeTree, type Tree } from '../sync-fixtures/harness'

const execFileAsync = promisify(execFile)

const PEER = process.env.PIPETTE_SYNC_PEER
  ?? resolve(cargoTargetDir, 'debug/examples', process.platform === 'win32' ? 'sync_peer.exe' : 'sync_peer')
const SUB = 'interop-sub'
const PC1_MACHINE = 'interop-machine-1'
const PC2_MACHINE = 'interop-machine-2'
const PC2_INSTALLATION_ID = '00000000-0000-4000-8000-00000000f2f0'
const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'
/** One step of a machine may take this long (key derivations included). */
const STEP_TIMEOUT_MS = 180_000

const { env, handlers } = vi.hoisted(() => ({
  env: { machineId: 'interop-machine-1' },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  secureOn: () => {},
}))
vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: true }),
  getAccessToken: async () => 'interop-token',
  getAccountSub: async () => 'interop-sub',
}))
// The real machine hash: SHA-256 of the machine id and the installation id
// of the userData in use, as the Rust identity derives it.
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { createHash: hash } = await import('node:crypto')
  const { readFileSync: read } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const { app } = await import('electron')
  return {
    getMachineHash: vi.fn(async () => {
      const id = read(joinPath(app.getPath('userData'), 'local', 'installation-id'), 'utf8').trim()
      return hash('sha256').update(env.machineId).update(id).digest('hex')
    }),
  }
})
// No typing analytics on either machine; the Rust side keeps its cache in
// its own userData.
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
// The passes run when the test says, not from timers.
vi.mock('../../src/main/sync/sync-flush', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-flush')>(),
  scheduleFlushIfPending: () => {},
}))
vi.mock('../../src/main/sync/sync-service', async () => {
  const { markPending } = await import('../../src/main/sync/sync-runtime-state')
  return { notifyChange: (unit: string) => markPending(unit) }
})
vi.mock('../../src/main/utils/broadcast', () => ({ broadcastToAllWindows: () => {} }))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false, defaultAutoAdvance: true })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

import { IpcChannels } from '../../src/shared/ipc/channels'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'
import { mergeDefined, newSettingsBase, parsePipetteSettings, settingsToSave } from '../../src/shared/pipette-settings-normalize'
import { executeSync } from '../../src/main/sync/sync-execute'
import { hasPendingChanges, resetSyncRuntimeForTests } from '../../src/main/sync/sync-runtime-state'
import { replacePasswordAndValidate, resetPasswordCheckCache, setPasswordAndValidate } from '../../src/main/sync/sync-password'
import { getPasswordChangeStatus, resumePasswordChange, startPasswordChange } from '../../src/main/sync/sync-password-change'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { setupFavoriteStore } from '../../src/main/favorite-store'
import { setupPipetteSettingsStore } from '../../src/main/pipette-settings-store'

// ---- The machines ----

interface Machines {
  pc1: string
  pc2: string
  keystore: string
}

let drive: FakeDrive
let now = FIXED_NOW
const extraDirs: string[] = []
/** Called with the name of each file the Electron code is about to create. */
let beforeCreate: ((name: string) => Promise<void>) | null = null

/** Moves both machines' clocks a minute on. */
function tick(): void {
  now += 60_000
  vi.setSystemTime(now)
}

function newMachines(): Machines {
  const pc2 = assertSafePath(mkdtempSync(join(tmpdir(), 'pipette-sync-interop-pc2-')))
  extraDirs.push(pc2, `${pc2}-keystore.json`)
  writeTree(pc2, { 'local/installation-id': PC2_INSTALLATION_ID })
  const pc1 = seedUserData()
  return { pc1, pc2, keystore: `${pc2}-keystore.json` }
}

/** Points the Electron code at `dir` as a machine that just started. */
function startTs(dir: string, machineId = PC1_MACHINE): void {
  useUserData(dir)
  env.machineId = machineId
  resetSyncRuntimeForTests()
  resetPasswordCheckCache()
  clearSyncFormatStatus()
  forgetChangeStateCache()
}

/** Points the Electron code back at machine 1 without forgetting its run. */
function onPc1(m: Machines): void {
  useUserData(m.pc1)
  env.machineId = PC1_MACHINE
}

interface PeerAnswer {
  success?: boolean
  error?: string
  status?: string
  skipReason?: string
  failedUnits?: string[]
  kind?: string
  progress: Array<{ message: string | null; reason: string | null }>
}

/** One step of machine 2. */
async function pc2(m: Machines, command: Record<string, unknown>): Promise<PeerAnswer> {
  const input = { userData: m.pc2, keystore: m.keystore, driveUrl: drive.url, now, machineId: PC2_MACHINE, sub: SUB, command }
  const { stdout } = await execFileAsync(PEER, [JSON.stringify(input)], { timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as PeerAnswer
}

async function ts<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const event = {} as unknown

async function saveFavoriteTs(type: string, id: string): Promise<void> {
  const result = await handlers.get(IpcChannels.FAVORITE_STORE_SAVE)!(event, type, `{"id":"${id}"}`, `Fav ${id}`)
  expect(result).toMatchObject({ success: true })
}

async function patchSettingsTs(uid: string, patch: Record<string, unknown>): Promise<void> {
  const result = await handlers.get(IpcChannels.PIPETTE_SETTINGS_PATCH)!(event, uid, patch)
  expect(result).toEqual({ success: true })
}

async function saveFavoritePc2(m: Machines, type: string, id: string): Promise<void> {
  expect(await pc2(m, { op: 'saveFavorite', type, json: `{"id":"${id}"}`, label: `Fav ${id}` })).toMatchObject({ success: true })
}

/** A settings patch on machine 2 as the Tauri shim writes it
 *  (src/tauri-shim/api/settings.ts): read, merge, stamp, write. */
async function patchSettingsPc2(m: Machines, uid: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(m.pc2, 'sync', 'keyboards', uid, 'pipette_settings.json')
  const existing = existsSync(path) ? parsePipetteSettings(readFileSync(path, 'utf8')) : null
  const merged = mergeDefined(existing ?? newSettingsBase({ defaultKeyboardLayout: '', defaultAutoAdvance: true }), patch)
  const content = JSON.stringify(settingsToSave(merged))
  expect(await pc2(m, { op: 'writeSettings', uid, content })).toMatchObject({ success: true })
}

const syncTree = (dir: string): Tree => (existsSync(join(dir, 'sync')) ? readTree(join(dir, 'sync')) : {})

/** The `sync/` tree with each JSON file as its value, so the order of an
 *  object's keys does not count. */
function syncValues(dir: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(syncTree(dir)).map(([path, text]) =>
    [path, text !== null && path.endsWith('.json') ? JSON.parse(text) as unknown : text]))
}

/** Every Drive file as id, name and modifiedTime. */
const driveFiles = (): string[] => drive.state.files.map((f) => `${f.id} ${f.name} ${f.modifiedTime}`)

/** The pending units machine 2 left in its sync-pending.json. */
function pc2Pending(m: Machines): unknown[] {
  const path = join(m.pc2, 'local', 'sync-pending.json')
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { units?: unknown[]; heldUnits?: unknown }
  return parsed.units ?? []
}

function clearFaults(): void {
  // DriveState keeps its injected faults private; the test drops the rest
  // of a batch it gave more than enough of.
  (drive.state as unknown as { faults: unknown[] }).faults.length = 0
}

/** Both machines with the sync password set and the same favorite and
 *  keyboard settings, all synced. */
async function syncedPair(password: string): Promise<Machines> {
  const m = newMachines()
  startTs(m.pc1)
  expect(await ts(() => setPasswordAndValidate(password))).toBeUndefined()
  await saveFavoriteTs('macro', 'base')
  await patchSettingsTs('kbI', { layerNames: ['Base'] })
  expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
  tick()
  expect(await pc2(m, { op: 'setPassword', password })).toMatchObject({ success: true })
  // The keyboard is connected to machine 2 too, so its units are synced
  // there (a keyboard never used on a machine is left on Drive).
  expect(await pc2(m, { op: 'ensureKeyboard', uid: 'kbI' })).toMatchObject({ success: true })
  expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })

  // Machine 2 wrote what the Electron code writes on a machine of its
  // own that downloads the same, byte for byte. Machine 1's files are
  // still as its stores wrote them (the merges write the keys of an entry
  // in their own order), so the two match as values.
  const mirror = assertSafePath(mkdtempSync(join(tmpdir(), 'pipette-sync-interop-mirror-')))
  extraDirs.push(mirror)
  writeTree(mirror, { 'local/installation-id': PC2_INSTALLATION_ID, 'sync/keyboards/kbI/': null })
  startTs(mirror, 'interop-machine-3')
  expect(await ts(() => setPasswordAndValidate(password))).toBeUndefined()
  expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
  expect(syncTree(m.pc2)).toEqual(syncTree(mirror))
  startTs(m.pc1)
  expect(syncValues(m.pc2)).toEqual(syncValues(m.pc1))
  tick()
  return m
}

// ---- Tests ----

describe('the Electron and the Rust sync engines on one Drive', () => {
  beforeAll(async () => {
    if (!existsSync(PEER)) {
      throw new Error(`the Rust peer ${PEER} is missing: run cargo build -p pipette-sync --example sync_peer in src-tauri`)
    }
    drive = await startFakeDrive()
    const guarded = globalThis.fetch
    // google-drive.ts writes the real Drive URLs; they go to the fake
    // Drive on 127.0.0.1 and nowhere else.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
      if (beforeCreate !== null && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        const body = logRequest(url, init).body
        const meta = body && 'parts' in body ? body.parts[0]?.json as { name?: string } | undefined : undefined
        if (meta?.name) await beforeCreate(meta.name)
      }
      return guarded(`${drive.url}${url.pathname}${url.search}`, init)
    }) as typeof fetch
    setupFavoriteStore()
    setupPipetteSettingsStore()
  })

  afterAll(async () => {
    await drive?.close()
  })

  afterEach(() => {
    beforeCreate = null
    drive.state.reset()
    now = FIXED_NOW
    for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('converges when both save and sync in turn, and the Electron code reads what the Rust engine synced as it is', async () => {
    const m = await syncedPair('interop-password')

    // Machine 2 adds to a unit machine 1 created, starts a store of its
    // own and changes the shared keyboard's settings.
    await saveFavoritePc2(m, 'macro', 'from-2')
    await saveFavoritePc2(m, 'tapDance', 'td-2')
    await patchSettingsPc2(m, 'kbI', { autoAdvance: false })
    expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ status: 'completed' })
    tick()

    // Machine 1 edits the same unit before it has seen machine 2's
    // change: its upload merges first.
    onPc1(m)
    await saveFavoriteTs('macro', 'from-1')
    expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    tick()
    expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })
    expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })

    const tree = syncTree(m.pc1)
    expect(syncValues(m.pc2)).toEqual(syncValues(m.pc1))
    const macroIndex = JSON.parse(tree['favorites/macro/index.json'] as string) as { entries: Array<{ label: string }> }
    expect(macroIndex.entries.map((e) => e.label).sort()).toEqual(['Fav base', 'Fav from-1', 'Fav from-2'])
    expect(tree['favorites/tapDance/index.json']).toContain('Fav td-2')
    expect(JSON.parse(tree['keyboards/kbI/pipette_settings.json'] as string)).toMatchObject({ layerNames: ['Base'], autoAdvance: false })
    expect(hasPendingChanges()).toBe(false)
    expect(pc2Pending(m)).toEqual([])

    // The Electron code on a copy of machine 2's userData, as a machine
    // that just started: it stores the password, then a download and an
    // upload of everything leave the copy and Drive as they were.
    const copy = assertSafePath(mkdtempSync(join(tmpdir(), 'pipette-sync-interop-copy-')))
    extraDirs.push(copy)
    cpSync(m.pc2, copy, { recursive: true })
    startTs(copy, PC2_MACHINE)
    expect(await ts(() => setPasswordAndValidate('interop-password'))).toBeUndefined()
    const before = readTree(copy)
    const driveBefore = driveFiles()
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
    expect(readTree(copy)).toEqual(before)
    expect(driveFiles()).toEqual(driveBefore)
  })

  for (const changer of ['electron', 'rust'] as const) {
    it(`stops both machines while the ${changer} engine's password change is unfinished`, async () => {
      const m = await syncedPair('old-password')
      const changeOnPc1 = changer === 'electron'
      onPc1(m)

      // Every re-encrypting upload fails: the change stops after taking
      // the Drive lock and keeps its state for a resume.
      drive.state.inject({ status: 400, count: 1000, only: 'update' })
      const started = changeOnPc1
        ? await ts(() => startPasswordChange('new-password'))
        : await pc2(m, { op: 'changePassword', password: 'new-password' })
      clearFaults()
      expect(started).toHaveProperty('error')
      expect(drive.state.files.some((f) => f.name === 'password-change-lock.json')).toBe(true)
      const status = changeOnPc1 ? await getPasswordChangeStatus() : await pc2(m, { op: 'changeStatus' })
      expect(status).toMatchObject({ kind: 'inProgress' })

      // Neither machine syncs: the changer for its local state, the other
      // for the lock on Drive. Drive is left as it was.
      tick()
      const driveBefore = driveFiles()
      const local = { status: 'skipped', skipReason: 'blockedLocal' }
      const remote = { status: 'skipped', skipReason: 'blockedByOtherDevice' }
      // Saved a minute apart: entries saved in the same millisecond on two
      // machines keep each machine's own first (entry-merge.ts sorts by
      // updatedAt only), so their order would differ between the machines.
      await saveFavoriteTs('macro', 'blocked-1')
      tick()
      await saveFavoritePc2(m, 'macro', 'blocked-2')
      expect(await executeSync('upload', 'all')).toEqual(changeOnPc1 ? local : remote)
      expect(await executeSync('download', 'all')).toEqual(changeOnPc1 ? local : remote)
      expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject(changeOnPc1 ? remote : local)
      expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject(changeOnPc1 ? remote : local)
      expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })
      expect(driveFiles()).toEqual(driveBefore)

      // The changer resumes and finishes; the other machine's password no
      // longer opens Drive until it re-enters the new one.
      tick()
      const resumed = changeOnPc1 ? await ts(() => resumePasswordChange()) : await pc2(m, { op: 'resumeChange' })
      expect(resumed).toEqual(changeOnPc1 ? undefined : expect.objectContaining({ success: true }))
      expect(drive.state.files.some((f) => f.name === 'password-change-lock.json')).toBe(false)
      tick()
      if (changeOnPc1) {
        expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ error: 'sync.passwordMismatch' })
        expect(await pc2(m, { op: 'replacePassword', password: 'new-password' })).toMatchObject({ success: true })
      } else {
        expect(await ts(() => executeSync('upload', 'all'))).toEqual({ error: 'sync.passwordMismatch' })
        expect(await ts(() => replacePasswordAndValidate('new-password'))).toBeUndefined()
      }
      expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
      tick()
      expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ status: 'completed' })
      expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })
      tick()
      expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })

      const tree = syncTree(m.pc1)
      expect(syncValues(m.pc2)).toEqual(syncValues(m.pc1))
      expect(tree['favorites/macro/index.json']).toContain('Fav blocked-1')
      expect(tree['favorites/macro/index.json']).toContain('Fav blocked-2')
    })
  }

  it('converges after both create the same unit at once, and the Rust polling moves the extra copy to the trash', async () => {
    const m = await syncedPair('interop-password')
    const name = 'favorites_combo.enc'
    onPc1(m)
    await saveFavoriteTs('combo', 'c-1')
    tick()
    await saveFavoritePc2(m, 'combo', 'c-2')

    // Machine 1 lists Drive and is about to create the unit; machine 2
    // lists, finds no copy and creates its own first.
    let peer: Promise<PeerAnswer> | null = null
    beforeCreate = async (created) => {
      if (created !== name || peer !== null) return
      peer = pc2(m, { op: 'execute', direction: 'upload', scope: 'favorites' })
      expect(await peer).toMatchObject({ status: 'completed' })
    }
    expect(await executeSync('upload', 'favorites')).toEqual({ status: 'completed' })
    beforeCreate = null
    expect(peer).not.toBeNull()
    expect(drive.state.files.filter((f) => f.name === name)).toHaveLength(2)

    // The syncs converge on the newest copy; machine 2's own copy is left
    // for the polling pass to move to the trash.
    tick()
    expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ status: 'completed' })
    tick()
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    tick()
    expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })
    const copies = drive.state.files.filter((f) => f.name === name || f.name.startsWith(`${name}.trash.`))
    expect(copies.map((f) => (f.name === name ? 'live' : 'trash')).sort()).toEqual(['live', 'trash'])

    tick()
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })
    const tree = syncTree(m.pc1)
    expect(syncValues(m.pc2)).toEqual(syncValues(m.pc1))
    expect(tree['favorites/combo/index.json']).toContain('Fav c-1')
    expect(tree['favorites/combo/index.json']).toContain('Fav c-2')
  })

  it('stops both machines on a sync-format marker newer than both', async () => {
    const m = await syncedPair('interop-password')
    const newer = `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`
    drive.state.create(newer, Buffer.from(JSON.stringify({ type: 'sync-format', version: SYNC_FORMAT_VERSION + 1 })), 'application/json')
    const driveBefore = driveFiles()
    onPc1(m)
    await saveFavoriteTs('macro', 'late-1')
    await saveFavoritePc2(m, 'macro', 'late-2')
    const pc1Before = syncTree(m.pc1)
    const pc2Before = syncTree(m.pc2)

    const blocked = { status: 'skipped', skipReason: 'updateRequired' }
    expect(await executeSync('upload', 'all')).toEqual(blocked)
    expect(await executeSync('download', 'all')).toEqual(blocked)
    expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject(blocked)
    expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject(blocked)
    expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })
    expect(await ts(() => startPasswordChange('another-password'))).toEqual({ error: 'sync.updateRequired' })
    expect(await pc2(m, { op: 'changePassword', password: 'another-password' })).toMatchObject({ error: 'sync.updateRequired' })

    expect(driveFiles()).toEqual(driveBefore)
    expect(syncTree(m.pc1)).toEqual(pc1Before)
    expect(syncTree(m.pc2)).toEqual(pc2Before)
  })
})
