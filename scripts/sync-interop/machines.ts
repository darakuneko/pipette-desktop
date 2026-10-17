// SPDX-License-Identifier: GPL-2.0-or-later
// The machines of the sync interop tests and the Drive they share:
//   - the Node fake Drive (scripts/fake-drive), which the Electron code's
//     requests to the real Drive URLs are sent on to, and nothing else;
//   - Electron machines: the Electron main process's sync code (with the
//     mocks of setup.ts) pointed at a userData of the harness;
//   - Rust machines: src-tauri/crates/pipette-sync's example sync_peer, run
//     once per step on a userData of its own, its master key in a file
//     beside it.
// One clock for all of them: the harness's `Date` and the `now` each Rust
// step is given.

import { vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { cargoTargetDir } from '../fixture-files'
import { startFakeDrive, type FakeDrive } from '../fake-drive/server'
import { logRequest } from '../sync-fixtures/drive-request-log'
import { FIXED_NOW, assertSafePath, readTree, useUserData, writeTree, type Tree } from '../sync-fixtures/harness'
import { handlers, machineEnv } from './machine-state'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { mergeDefined, newSettingsBase, parsePipetteSettings, settingsToSave } from '../../src/shared/pipette-settings-normalize'
import { resetSyncRuntimeForTests } from '../../src/main/sync/sync-runtime-state'
import { resetPasswordCheckCache } from '../../src/main/sync/sync-password'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { setupFavoriteStore } from '../../src/main/favorite-store'
import { setupPipetteSettingsStore } from '../../src/main/pipette-settings-store'

const execFileAsync = promisify(execFile)

/** The Rust peer: PIPETTE_SYNC_PEER, or the debug build's. */
const PEER = process.env.PIPETTE_SYNC_PEER
  ?? resolve(cargoTargetDir, 'debug/examples', process.platform === 'win32' ? 'sync_peer.exe' : 'sync_peer')
/** The account both machines are signed in to. */
const SUB = 'interop-sub'
const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'
/** One step of a Rust machine may take this long. */
const STEP_TIMEOUT_MS = 300_000

let drive: FakeDrive | null = null
let now = FIXED_NOW
const dirs: string[] = []
/** Called with the name of each file the Electron code is about to create. */
let beforeCreate: ((name: string) => Promise<void>) | null = null

export function fakeDrive(): FakeDrive {
  if (drive === null) throw new Error('the fake Drive is not running')
  return drive
}

/** Starts the fake Drive, sends the Electron code's Drive requests to it
 *  and registers the stores' handlers. */
export async function startMachines(): Promise<void> {
  if (!existsSync(PEER)) {
    throw new Error(`the Rust peer ${PEER} is missing: run cargo build -p pipette-sync --example sync_peer in src-tauri`)
  }
  const started = await startFakeDrive()
  drive = started
  const guarded = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
    if (beforeCreate !== null && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      const body = logRequest(url, init).body
      const meta = body && 'parts' in body ? body.parts[0]?.json as { name?: string } | undefined : undefined
      if (meta?.name) await beforeCreate(meta.name)
    }
    return guarded(`${started.url}${url.pathname}${url.search}`, init)
  }) as typeof fetch
  setupFavoriteStore()
  setupPipetteSettingsStore()
}

export async function stopMachines(): Promise<void> {
  await drive?.close()
  drive = null
}

/** After each test: an empty Drive, the clock back at the start, and the
 *  Rust machines' directories removed. */
export function resetMachines(): void {
  beforeCreate = null
  drive?.state.reset()
  now = FIXED_NOW
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function onBeforeCreate(hook: ((name: string) => Promise<void>) | null): void {
  beforeCreate = hook
}

/** Moves every machine's clock a minute on. */
export function tick(): void {
  now += 60_000
  vi.setSystemTime(now)
}

/** A new temporary directory, removed after the test. */
export function tempDir(prefix: string): string {
  const dir = assertSafePath(mkdtempSync(join(tmpdir(), `pipette-sync-interop-${prefix}-`)))
  dirs.push(dir)
  return dir
}

// ---- Electron machines ----

/** Points the Electron code at `dir` as a machine that just started. */
export function startElectron(dir: string, machineId: string, typingUids: string[] = []): void {
  onElectron(dir, machineId, typingUids)
  resetSyncRuntimeForTests()
  resetPasswordCheckCache()
  clearSyncFormatStatus()
  forgetChangeStateCache()
}

/** Points the Electron code back at `dir` without forgetting its run. */
export function onElectron(dir: string, machineId: string, typingUids: string[] = []): void {
  useUserData(dir)
  machineEnv.machineId = machineId
  machineEnv.typingUids = typingUids
}

/** `work`'s value, or its error's message. */
export async function caught<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const event = {} as unknown

export async function saveFavoriteElectron(type: string, id: string): Promise<void> {
  const result = await handlers.get(IpcChannels.FAVORITE_STORE_SAVE)!(event, type, `{"id":"${id}"}`, `Fav ${id}`)
  if ((result as { success?: boolean }).success !== true) throw new Error(`save failed: ${JSON.stringify(result)}`)
}

export async function patchSettingsElectron(uid: string, patch: Record<string, unknown>): Promise<void> {
  const result = await handlers.get(IpcChannels.PIPETTE_SETTINGS_PATCH)!(event, uid, patch)
  if ((result as { success?: boolean }).success !== true) throw new Error(`patch failed: ${JSON.stringify(result)}`)
}

// ---- Rust machines ----

export interface RustMachine {
  dir: string
  keystore: string
  machineId: string
}

export interface PeerAnswer {
  success?: boolean
  error?: string
  status?: string
  skipReason?: string
  failedUnits?: string[]
  kind?: string
  elapsedMs: number
  maxRssKb: number | null
  progress: Array<{ message: string | null; reason: string | null }>
}

/** A Rust machine on a new userData with `installationId`. */
export function newRustMachine(machineId: string, installationId: string, tree: Tree = {}): RustMachine {
  const dir = tempDir('rust')
  dirs.push(`${dir}-keystore.json`)
  writeTree(dir, { 'local/installation-id': installationId, ...tree })
  return { dir, keystore: `${dir}-keystore.json`, machineId }
}

/** One step of `machine`: the peer started on it, running `command`. */
export async function onRust(machine: RustMachine, command: Record<string, unknown>): Promise<PeerAnswer> {
  const input = {
    userData: machine.dir,
    keystore: machine.keystore,
    driveUrl: fakeDrive().url,
    now,
    machineId: machine.machineId,
    sub: SUB,
    command,
  }
  const { stdout } = await execFileAsync(PEER, [JSON.stringify(input)], { timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as PeerAnswer
}

export async function saveFavoriteRust(machine: RustMachine, type: string, id: string): Promise<void> {
  const answer = await onRust(machine, { op: 'saveFavorite', type, json: `{"id":"${id}"}`, label: `Fav ${id}` })
  if (answer.success !== true) throw new Error(`save failed: ${JSON.stringify(answer)}`)
}

/** A settings patch as the Tauri shim writes it
 *  (src/tauri-shim/api/settings.ts): read, merge, stamp, write. */
export async function patchSettingsRust(machine: RustMachine, uid: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(machine.dir, 'sync', 'keyboards', uid, 'pipette_settings.json')
  const existing = existsSync(path) ? parsePipetteSettings(readFileSync(path, 'utf8')) : null
  const merged = mergeDefined(existing ?? newSettingsBase({ defaultKeyboardLayout: '', defaultAutoAdvance: true }), patch)
  const answer = await onRust(machine, { op: 'writeSettings', uid, content: JSON.stringify(settingsToSave(merged)) })
  if (answer.success !== true) throw new Error(`patch failed: ${JSON.stringify(answer)}`)
}

/** The pending units `machine` left in its sync-pending.json. */
export function rustPending(machine: RustMachine): unknown[] {
  const path = join(machine.dir, 'local', 'sync-pending.json')
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { units?: unknown[] }).units ?? []
}

// ---- Trees and Drive ----

export const syncTree = (dir: string): Tree => (existsSync(join(dir, 'sync')) ? readTree(join(dir, 'sync')) : {})

/** The `sync/` tree with each JSON file as its value, so the order of an
 *  object's keys does not count. */
export function syncValues(dir: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(syncTree(dir)).map(([path, text]) =>
    [path, text !== null && path.endsWith('.json') ? JSON.parse(text) as unknown : text]))
}

/** Every Drive file as id, name and modifiedTime. */
export const driveFiles = (): string[] => fakeDrive().state.files.map((f) => `${f.id} ${f.name} ${f.modifiedTime}`)

export function clearFaults(): void {
  // DriveState keeps its injected faults private; a test drops the rest of
  // a batch it gave more than enough of.
  (fakeDrive().state as unknown as { faults: unknown[] }).faults.length = 0
}
