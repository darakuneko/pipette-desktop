// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the resets, deletes and trash actions of
// src-tauri/crates/pipette-sync (reset/, trash/manual.rs). Runs the IPC
// handlers of src/main/sync/sync-reset-ipc.ts in the sync fixture harness
// (harness.ts) on a seeded userData, with the pending units restored from
// its `local/sync-pending.json`, the real google-drive.ts against the Node
// fake Drive (scripts/fake-drive, which behaves as the Rust `InMemoryDrive`
// does) and the real hold of the pending units at a sign-out. The requests
// go to www.googleapis.com as google-drive.ts writes them and are sent on
// to the fake Drive on 127.0.0.1; nothing else is reachable.
//
// The typing analytics, polling and the app config are recorded, not run:
// the keyboards the analytics cache has rows of are given, and each
// cleanup, `stopPolling`, the config clear and the sign-out are logged.
//
// Records, for each step: the handler's answer, the calls logged, the units
// reported changed, the pending units (sorted) with their owner and the
// held ones, the userData tree (the pending file written first) and the
// Drive files by id and name.
//
// Writes src-tauri/crates/pipette-sync/tests/fixtures/ts_reset.json.
//
// Run: pnpm run generate:sync-fixtures

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { startFakeDrive, type FakeDrive } from '../fake-drive/server'
import { FIXED_INSTALLATION_ID, FIXED_NOW, readTree, seedUserData, type Tree } from './harness'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_reset.json')
const OWN_HASH = 'hash-own'

const rec = vi.hoisted(() => ({
  sub: null as string | null,
  calls: [] as string[],
  notified: [] as string[],
  typingCache: [] as string[],
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    rec.handlers.set(channel, handler)
  },
}))
vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: true }),
  getAccessToken: async () => 'fixture-token',
  getAccountSub: async () => rec.sub,
  signOut: async () => {
    rec.calls.push('signOut')
    rec.sub = null
  },
}))
vi.mock('../../src/main/sync/sync-crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-crypto')>(),
  retrievePasswordResult: async () => ({ ok: true, password: 'golden-password' }),
}))
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: async () => 'hash-own' }))
vi.mock('../../src/main/typing-analytics/typing-analytics-service', () => ({
  deleteAllTypingForKeyboard: async (uid: string, _cutoffMs: number, scope: string) => {
    rec.calls.push(`typing:${uid}:${scope}`)
  },
  listTypingKeyboards: () => rec.typingCache.map((uid) => ({ uid })),
  deleteTypingDailySummaries: async () => {},
}))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: () => ({}),
  saveAppConfig: async () => undefined,
  getAppConfigStore: () => ({
    get: () => undefined,
    clear: () => {
      rec.calls.push('clearConfig')
    },
  }),
}))
vi.mock('../../src/main/hub/hub-ipc-token', () => ({ clearHubTokenCache: () => {} }))
vi.mock('../../src/main/utils/broadcast', () => ({ broadcastToAllWindows: () => {} }))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
// The facade as sync-reset-ipc.ts uses it, from the modules that hold each
// part; a change is only marked pending (no flush), polling is only logged.
vi.mock('../../src/main/sync/sync-service', async () => {
  const state = await import('../../src/main/sync/sync-runtime-state')
  const lock = await import('../../src/main/sync/sync-reset-lock')
  const guard = await import('../../src/main/sync/sync-password-guard')
  const changeState = await import('../../src/main/sync/sync-password-change-state')
  const account = await import('../../src/main/sync/sync-pending-account')
  const password = await import('../../src/main/sync/sync-password')
  const { app } = await import('electron')
  const { join } = await import('node:path')
  const { readdir: listDir } = await import('node:fs/promises')
  return {
    ...lock,
    cancelPendingChanges: state.cancelPendingChanges,
    copyPendingState: state.copyPendingState,
    restoreCancelledPending: state.restoreCancelledPending,
    notifyChange: (unit: string) => {
      rec.notified.push(unit)
      state.markPending(unit)
    },
    stopPolling: () => {
      rec.calls.push('stopPolling')
    },
    listLocalKeyboardUids: async () => {
      const uids = new Set<string>()
      try {
        for (const entry of await listDir(join(app.getPath('userData'), 'sync', 'keyboards'), { withFileTypes: true })) {
          if (entry.isDirectory()) uids.add(entry.name)
        }
      } catch { /* no keyboards */ }
      return uids
    },
    SyncBlockedError: guard.SyncBlockedError,
    assertSyncAllowed: guard.assertSyncAllowed,
    assertNoLocalPasswordChange: guard.assertNoLocalPasswordChange,
    forgetChangeStateCache: changeState.forgetChangeStateCache,
    signOutKeepingPendingLocked: async () => {
      rec.calls.push('signOutLocked')
      await account.signOutKeepingPendingLocked()
    },
    deleteDeviceTypingData: async () => {},
    SyncCredentialError: password.SyncCredentialError,
    AccountSwitchBusyError: account.AccountSwitchBusyError,
  }
})

import { IpcChannels } from '../../src/shared/ipc/channels'
import { setupSyncResetIpc } from '../../src/main/sync/sync-reset-ipc'
import { trashFileName } from '../../src/main/sync/drive-trash'
import { persistPendingNow, resetSyncRuntimeForTests, syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { resetPendingStoreForTests, restorePendingFromDisk } from '../../src/main/sync/sync-pending-store'
import { forgetChangeStateCache } from '../../src/main/sync/sync-password-change-state'
import { resetPasswordCheckCache } from '../../src/main/sync/sync-password'
import { clearSyncFormatStatus } from '../../src/main/sync/sync-format-status'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'

// ---- Inputs ----

type Step =
  | { op: 'resetTargets'; arg: unknown }
  | { op: 'resetKeyboard'; arg: unknown }
  | { op: 'resetLocal'; arg: unknown }
  | { op: 'deleteFiles'; arg: unknown }
  | { op: 'listTrash' }
  | { op: 'restoreTrash'; arg: unknown }
  | { op: 'deleteTrash'; arg: unknown }

/** A Drive file put there before the steps (ids `fake-1`, `fake-2`, … in
 *  this order); with `trashAt`, then renamed to its trash name of that
 *  time. */
interface DriveSeed {
  name: string
  trashAt?: number
}

interface Scenario {
  name: string
  tree: Tree
  drive: DriveSeed[]
  /** The account signed in. */
  sub?: string
  /** The keyboards the typing-analytics cache has rows of. */
  typingCache?: string[]
  steps: Step[]
}

const D = (n: number): string => new Date(FIXED_NOW - n * 86_400_000).toISOString()
const json = (value: unknown): string => JSON.stringify(value, null, 2)
const meta = (uids: string[]): string =>
  json({ type: 'keyboard-meta', version: 1, entries: uids.map((uid) => ({ uid, deviceName: `Board ${uid}`, updatedAt: D(3) })) })
const pending = (owner: string | null, units: string[], held: Record<string, string[]> = {}): string =>
  JSON.stringify({ version: 1, owner, units, held })

/** A userData with two keyboards, every global store, the secrets of both
 *  builds, the downloads and logs, and pending units of each target. */
const BASE: Tree = {
  'sync/keyboards/uid1/pipette_settings.json': '{"theme":"a"}',
  'sync/keyboards/uid1/snapshots/index.json': '{"uid":"uid1","entries":[]}',
  'sync/keyboards/uid2/pipette_settings.json': '{"theme":"b"}',
  'sync/favorites/macro/index.json': '{"type":"macro","entries":[]}',
  'sync/typing-test-texts/index.json': '{"entries":[]}',
  'sync/key-labels/index.json': '{"entries":[]}',
  'sync/i18n/index.json': '{"entries":[]}',
  'sync/themes/index.json': '{"entries":[]}',
  'sync/meta/keyboard-names.json': meta(['uid1', 'uid2']),
  'local/auth/oauth-tokens.enc': 'electron tokens',
  'local/auth/sync-password.enc': 'electron password',
  'local/auth/tauri-sync-password.bin': 'tauri password',
  'local/downloads/languages/tatoeba/english.json': '[]',
  'local/logs/main.log': 'log',
  'local/sync-pending.json': pending(null, [
    'keyboards/uid1/settings',
    'keyboards/uid2/settings',
    'favorites/macro',
    'typing-test-texts',
    'key-labels',
    'i18n/index',
    'themes/index',
    'meta/keyboard-names',
  ], { 'sub-b': ['favorites/combo', 'keyboards/uid1/snapshots'] }),
}

const OWN_DAY = `keyboards_uid1_devices_${OWN_HASH}_days_2026-10-01.enc`

const SCENARIOS: Scenario[] = [
  {
    name: 'resets of targets on Drive',
    tree: BASE,
    drive: [
      { name: 'keyboards_uid1_settings.enc' },
      { name: 'keyboards_uid1_snapshots.enc', trashAt: 100 },
      { name: 'keyboards_uid2_settings.enc' },
      { name: 'favorites_macro.enc' },
      { name: 'favorites_combo.enc', trashAt: 200 },
      { name: 'i18n_index.enc' },
      { name: 'i18n_packs_p1.enc' },
      { name: 'themes_index.enc' },
      { name: 'key-labels.enc' },
      { name: 'key-labels.enc' },
      { name: 'key-labels.enc', trashAt: 300 },
      { name: 'key-labels.enc.bak' },
      { name: 'typing-test-texts.enc' },
      { name: 'meta_keyboard-names.enc' },
    ],
    steps: [
      { op: 'resetTargets', arg: { keyboards: false, favorites: false } },
      { op: 'resetTargets', arg: { keyboards: ['uid1', '../x'], favorites: false } },
      { op: 'resetTargets', arg: { keyboards: ['uid1'], favorites: false } },
      { op: 'resetTargets', arg: { keyboards: false, favorites: true, keyLabels: true } },
      { op: 'resetTargets', arg: { keyboards: true, favorites: false, i18nPacks: true, themePacks: true, typingTestTexts: true } },
      { op: 'resetTargets', arg: { keyboards: true, favorites: false } },
    ],
  },
  {
    name: 'resets of a keyboard',
    tree: BASE,
    drive: [{ name: 'keyboards_uid1_settings.enc' }, { name: 'keyboards_uid2_settings.enc' }],
    typingCache: ['uid1', 'uid3'],
    steps: [
      { op: 'resetKeyboard', arg: '../x' },
      { op: 'resetKeyboard', arg: 'uid1' },
      { op: 'resetKeyboard', arg: 'uid9' },
    ],
  },
  {
    name: 'a reset of a keyboard while Drive needs a newer app',
    tree: BASE,
    drive: [{ name: 'keyboards_uid1_settings.enc' }, { name: `sync-format-v${SYNC_FORMAT_VERSION + 1}.json` }],
    steps: [
      { op: 'resetKeyboard', arg: 'uid1' },
      { op: 'resetTargets', arg: { keyboards: ['uid2'], favorites: false } },
    ],
  },
  {
    name: 'resets of local targets',
    tree: BASE,
    drive: [],
    typingCache: ['uid2', 'uid3'],
    steps: [
      { op: 'resetLocal', arg: { keyboards: false, favorites: false, appSettings: false } },
      { op: 'resetLocal', arg: { keyboards: false, favorites: true, appSettings: false, themePacks: true } },
      { op: 'resetLocal', arg: { keyboards: true, favorites: false, appSettings: false } },
    ],
  },
  {
    name: 'a reset of app settings signs out holding the pending units',
    tree: BASE,
    drive: [],
    sub: 'sub-a',
    steps: [{ op: 'resetLocal', arg: { keyboards: false, favorites: true, appSettings: true } }],
  },
  {
    name: 'a reset of everything',
    tree: BASE,
    drive: [],
    sub: 'sub-a',
    typingCache: ['uid3'],
    steps: [{ op: 'resetLocal', arg: { keyboards: true, favorites: true, appSettings: true, i18nPacks: true, themePacks: true } }],
  },
  {
    name: 'resets refused while this machine changes the password',
    tree: { ...BASE, 'local/auth/sync-password-change.json': '{}' },
    drive: [{ name: 'keyboards_uid1_settings.enc' }],
    steps: [
      { op: 'resetLocal', arg: { keyboards: true, favorites: false, appSettings: true } },
      { op: 'resetKeyboard', arg: 'uid1' },
      { op: 'resetTargets', arg: { keyboards: true, favorites: false } },
      { op: 'deleteFiles', arg: ['fake-1'] },
      { op: 'listTrash' },
      { op: 'resetLocal', arg: { keyboards: false, favorites: true, appSettings: false } },
    ],
  },
  {
    name: 'the trash screen and the delete of chosen files',
    tree: BASE,
    drive: [
      { name: 'favorites_macro.enc' },
      { name: 'favorites_macro.enc', trashAt: 1000 },
      { name: 'keyboards_uid1_settings.enc' },
      { name: 'keyboards_uid1_settings.enc', trashAt: 2000 },
      { name: OWN_DAY, trashAt: 3000 },
      { name: 'keyboards_uid1_devices_hash-other_days_2026-10-01.enc', trashAt: 500 },
      { name: 'favorites_combo.enc', trashAt: 1500 },
      { name: 'favorites_combo.enc.trash.1.2.someone-else' },
    ],
    steps: [
      { op: 'listTrash' },
      { op: 'restoreTrash', arg: 42 },
      { op: 'restoreTrash', arg: 'fake-2' },
      { op: 'restoreTrash', arg: 'fake-5' },
      { op: 'restoreTrash', arg: 'fake-1' },
      { op: 'restoreTrash', arg: 'fake-4' },
      { op: 'deleteTrash', arg: [] },
      { op: 'deleteTrash', arg: ['fake-6', 'fake-1', 'gone', 'fake-5'] },
      { op: 'deleteFiles', arg: [] },
      { op: 'deleteFiles', arg: ['fake-7', 'fake-8'] },
      { op: 'listTrash' },
    ],
  },
]

// ---- Running ----

const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'

const CHANNELS: Record<Step['op'], string> = {
  resetTargets: IpcChannels.SYNC_RESET_TARGETS,
  resetKeyboard: IpcChannels.RESET_KEYBOARD_DATA,
  resetLocal: IpcChannels.RESET_LOCAL_TARGETS,
  deleteFiles: IpcChannels.SYNC_DELETE_FILES,
  listTrash: IpcChannels.SYNC_LIST_TRASH,
  restoreTrash: IpcChannels.SYNC_RESTORE_TRASH,
  deleteTrash: IpcChannels.SYNC_DELETE_TRASH,
}

function pendingState() {
  return {
    owner: syncRuntime.pendingOwner,
    units: [...syncRuntime.pendingChanges].sort(),
    held: [...syncRuntime.heldPending].map(([sub, units]) => [sub, [...units].sort()]),
  }
}

describe('reset fixtures', () => {
  let drive: FakeDrive

  beforeAll(async () => {
    drive = await startFakeDrive()
    setupSyncResetIpc()
  })

  afterAll(async () => {
    await drive.close()
  })

  async function runScenario(scenario: Scenario) {
    drive.state.reset()
    resetSyncRuntimeForTests()
    resetPendingStoreForTests()
    resetPasswordCheckCache()
    clearSyncFormatStatus()
    Object.assign(rec, { sub: scenario.sub ?? null, calls: [], notified: [], typingCache: scenario.typingCache ?? [] })
    const userData = seedUserData(scenario.tree)
    forgetChangeStateCache()
    restorePendingFromDisk()
    for (const seed of scenario.drive) {
      const file = drive.state.create(seed.name, Buffer.from('{}'), 'application/json')
      if (seed.trashAt !== undefined) drive.state.rename(file.id, trashFileName(file, seed.trashAt)!)
    }

    const guarded = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
      return guarded(`${drive.url}${url.pathname}${url.search}`, init)
    }) as typeof fetch
    try {
      const steps = []
      for (const step of scenario.steps) {
        rec.calls = []
        rec.notified = []
        const handler = rec.handlers.get(CHANNELS[step.op])!
        const result = 'arg' in step ? await handler(null, step.arg) : await handler(null)
        persistPendingNow()
        steps.push({
          step,
          result,
          calls: [...rec.calls],
          notified: [...rec.notified],
          pending: pendingState(),
          tree: readTree(userData),
          drive: drive.state.files.map((file) => [file.id, file.name]),
        })
      }
      return {
        name: scenario.name,
        tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
        drive: scenario.drive,
        sub: scenario.sub ?? null,
        typingCache: scenario.typingCache ?? [],
        steps,
      }
    } finally {
      globalThis.fetch = guarded
      resetPendingStoreForTests()
      resetSyncRuntimeForTests()
    }
  }

  it('records every scenario', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
    expect(scenarios.length).toBe(SCENARIOS.length)
    writeJsonFixture(OUT, {
      about: 'The resets, deletes and trash actions of the TypeScript sync code. Generated by scripts/sync-fixtures/record-reset-fixtures.test.ts; do not edit.',
      now: FIXED_NOW,
      ownHash: OWN_HASH,
      scenarios,
    })
  }, 300_000)
})
