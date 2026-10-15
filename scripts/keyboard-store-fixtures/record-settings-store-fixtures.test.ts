// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the pipette settings storage of
// src-tauri/crates/pipette-keyboard-stores. Each scenario runs twice from
// the same userData files, at fixed times:
//
// - through the real PIPETTE_SETTINGS_* handlers of
//   src/main/pipette-settings-store.ts, recording each step's response, the
//   sync units reported to notifyChange, and every file and directory left
//   behind (path → content);
// - through the Tauri shim's members (src/tauri-shim/api/settings.ts) on a
//   backend that stores as the crate does, recording each backend command
//   with its arguments and answer.
//
// Both runs must answer the same, report the same units and leave the same
// files; the crate replays the shim's commands on the same files and
// compares its answers, units and files byte for byte. The keyboard names
// carry no analytics product names here, which the Tauri backend does not
// read either.
//
// A file-system error's text is the OS's and Node's, which the crate does
// not copy; no scenario makes one.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const { handlers, notified, paths, config, backend } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  config: { current: { defaultKeyboardLayout: 'qwerty', defaultAutoAdvance: true } as Record<string, unknown> },
  backend: { call: (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.reject(new Error('no backend')) },
}))

vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => notified.push(unit) }))
vi.mock('../../src/main/app-config', () => ({ loadAppConfig: () => config.current }))
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: () => {
    throw new Error('no analytics database')
  },
}))
vi.mock('../../src/tauri-shim/ipc', () => ({
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}))

import { setupPipetteSettingsStore } from '../../src/main/pipette-settings-store'
import { getActiveKeyboardMetaMap, readKeyboardMetaIndex, resolveKeyboardDisplayName } from '../../src/main/sync/keyboard-meta'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { isSafePathSegment } from '../../src/shared/utils/safe-filename'
import { settingsApi } from '../../src/tauri-shim/api/settings'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_settings_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

type Step =
  | { op: 'get'; uid: string }
  | { op: 'patch'; uid: string; patch: unknown }
  /** Patches of one keyboard made together, without waiting for each other. */
  | { op: 'patches'; uid: string; patches: unknown[] }
  | { op: 'ensureDir'; uid: string }
  | { op: 'listAll' }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

interface Scenario {
  name: string
  time: string
  /** The AppConfig fields a new settings file starts from. */
  config: { defaultKeyboardLayout: unknown; defaultAutoAdvance: unknown }
  tree: Tree
  steps: Step[]
}

/** A backend command the shim made, with its answer or its error message. */
interface Command {
  command: string
  args: Record<string, unknown>
  response?: unknown
  error?: string
}

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })

const UID = '0xA1B2'
const FILE = `sync/keyboards/${UID}/pipette_settings.json`
const DEFAULTS = { defaultKeyboardLayout: 'qwerty', defaultAutoAdvance: true }

const get = (uid = UID): Step => ({ op: 'get', uid })
const patch = (p: unknown, uid = UID): Step => ({ op: 'patch', uid, patch: p })

const RESULT = {
  date: '2026-01-01T00:00:00.000Z', wpm: 50, accuracy: 95, wordCount: 30,
  correctChars: 100, incorrectChars: 5, durationSeconds: 30,
}
const MEMORY = {
  textId: 't1', currentWordIndex: 1, currentInput: 'a', wordResults: [],
  correctChars: 1, incorrectChars: 0, elapsedMs: 10, wpmHistory: [], savedAt: '2026-01-01T00:00:00.000Z',
}
const settingsFile = (fields: Record<string, unknown>): string => JSON.stringify(fields)
const names = (entries: unknown[]): string => JSON.stringify({ type: 'keyboard-meta', version: 1, entries }, null, 2)
const snapshotIndex = (uid: string, filename: string): string =>
  JSON.stringify({ uid, entries: [{ id: 'd', filename: 'Old_2026-01-01T00-00-00.000Z_d.pipette', deletedAt: T0 }, { id: 's', filename }] }, null, 2)

const SCENARIOS: Scenario[] = [
  {
    name: 'a new file from the defaults, then patches that add, merge and delete keys',
    time: T0,
    config: DEFAULTS,
    tree: {},
    steps: [
      get(),
      { op: 'ensureDir', uid: UID },
      get(),
      patch({ _rev: 1, layerNames: ['Base', 'Fn'] }),
      at(MIN),
      patch({ _rev: 1, autoAdvance: false, quickSelect: true, keymapScale: 1.25 }),
      patch({ _rev: 1, typingTestMemory: MEMORY, unknownField: { kept: [1, 2.5, 'é😀'] } }),
      at(2 * MIN),
      patch({ _rev: 1, typingTestMemory: null, layerPanelOpen: undefined }),
      patch({ _rev: 1, analyze: { filters: { deviceScopes: ['own'] } } }),
      patch({ _rev: 1, analyze: { goalDays: 3, filters: undefined } }),
      patch({ _rev: 1, analyze: { fingerAssignments: {} } }),
      patch({ _rev: 1, typingTestResults: [RESULT], basicViewType: 'iso' }),
      get(),
    ],
  },
  {
    name: 'a new file takes the app-wide layout and auto-advance',
    time: T0,
    config: { defaultKeyboardLayout: 'dvorak', defaultAutoAdvance: false },
    tree: {},
    steps: [patch({ _rev: 1, quickSelect: true }), get()],
  },
  {
    name: 'an empty app-wide layout falls back to qwerty',
    time: T0,
    config: { defaultKeyboardLayout: '', defaultAutoAdvance: false },
    tree: {},
    steps: [patch({ _rev: 1, splitKeyMode: 'flat' })],
  },
  {
    name: 'an app-wide auto-advance that is not a boolean makes the new file invalid',
    time: T0,
    config: { defaultKeyboardLayout: 'colemak', defaultAutoAdvance: 'yes' },
    tree: {},
    steps: [patch({ _rev: 1, quickSelect: true }), patch({ _rev: 1, autoAdvance: true })],
  },
  {
    name: 'an existing file is rewritten with its known fields in their order',
    time: T0,
    config: DEFAULTS,
    tree: {
      [FILE]: settingsFile({
        zzz: 'unknown', viewMode: 'typingTest', appliedKeymapLayout: 'stale', layerNames: ['A'],
        autoAdvance: false, keyboardLayout: 'german', _updatedAt: t(-MIN), keymapScale: 0.75, _rev: 1,
      }),
    },
    steps: [get(), patch({ _rev: 1, layerPanelOpen: true }), get()],
  },
  {
    name: 'a file without layer names reads and writes them as empty',
    time: T0,
    config: { defaultKeyboardLayout: 'dvorak', defaultAutoAdvance: false },
    tree: { [FILE]: '{"keyboardLayout":"jis","autoAdvance":true}' },
    steps: [get(), patch({ quickSelect: false })],
  },
  {
    name: 'patches that make the settings invalid are refused',
    time: T0,
    config: DEFAULTS,
    tree: { [FILE]: settingsFile({ _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames: [] }) },
    steps: [
      patch({ keyboardLayout: 5 }),
      patch({ _rev: 2 }),
      patch({ layerNames: ['a', 1] }),
      patch({ keymapScale: 9 }),
      patch({ autoAdvance: null }),
      patch({ viewMatrix: { '0,0': { row: -1, col: 0 } } }),
      patch(['not', 'an', 'object']),
      patch(null),
      patch('text'),
      get(),
    ],
  },
  {
    name: 'files that are not valid settings read as none and are replaced by the next patch',
    time: T0,
    config: DEFAULTS,
    tree: {
      [FILE]: 'not json',
      'sync/keyboards/bom/pipette_settings.json': '﻿{"keyboardLayout":"qwerty","autoAdvance":true}',
      'sync/keyboards/invalid/pipette_settings.json': '{"keyboardLayout":"qwerty"}',
      'sync/keyboards/array/pipette_settings.json': '[1]',
      'sync/keyboards/utf8/pipette_settings.json': {
        hex: Buffer.concat([Buffer.from('{"keyboardLayout":"'), Buffer.from([0xff, 0xe6]), Buffer.from('","autoAdvance":true}')]).toString('hex'),
      },
    },
    steps: [
      get(), patch({ quickSelect: true }),
      get('bom'), patch({ quickSelect: true }, 'bom'),
      get('invalid'), patch({ quickSelect: true }, 'invalid'),
      get('array'), patch({ quickSelect: true }, 'array'),
      get('utf8'), patch({ quickSelect: true }, 'utf8'),
    ],
  },
  {
    name: 'uids that are not one path segment',
    time: T0,
    config: DEFAULTS,
    tree: {},
    steps: ['', '.', '..', 'a/b', 'a\\b', '../x'].flatMap((uid): Step[] => [
      get(uid),
      patch({ _rev: 1, quickSelect: true }, uid),
      patch(null, uid),
      { op: 'ensureDir', uid },
    ]),
  },
  {
    name: 'patches of one keyboard made together all apply, in call order',
    time: T0,
    config: DEFAULTS,
    tree: {},
    steps: [
      {
        op: 'patches',
        uid: UID,
        patches: [
          { _rev: 1, keyboardLayout: 'colemak' },
          { _rev: 1, autoAdvance: false },
          { _rev: 1, keyboardLayout: 'workman', layerNames: ['L0'] },
          { _rev: 1, keyboardLayout: 5 },
        ],
      },
      get(),
    ],
  },
  {
    name: 'the typing test results of every keyboard, with their names',
    time: T0,
    config: DEFAULTS,
    tree: {
      'sync/meta/keyboard-names.json': names([
        { uid: 'named', deviceName: 'Named Board', updatedAt: T0 },
        { uid: 'self', deviceName: 'self', updatedAt: T0 },
        { uid: 'gone', deviceName: 'Gone Board', updatedAt: T0, deletedAt: T0 },
        { uid: 'number', deviceName: 42, updatedAt: T0 },
        { uid: 'empty', deviceName: '', updatedAt: T0 },
      ]),
      ...Object.fromEntries(
        ['named', 'self', 'gone', 'number', 'empty', 'snap', 'bare', 'a b'].map((uid, i) => [
          `sync/keyboards/${uid}/pipette_settings.json`,
          settingsFile({ keyboardLayout: 'qwerty', autoAdvance: true, typingTestResults: [{ ...RESULT, wpm: i + 1 }, { ...RESULT, wpm: i + 11, name: uid }] }),
        ]),
      ),
      'sync/keyboards/self/snapshots/index.json': snapshotIndex('self', 'Self Snap_2026-01-02T00-00-00.000Z_s.pipette'),
      'sync/keyboards/gone/snapshots/index.json': snapshotIndex('gone', 'Gone Snap_2026-01-02T00-00-00.000Z_s.pipette'),
      'sync/keyboards/snap/snapshots/index.json': snapshotIndex('snap', 'Snap Board_2026-01-02T00-00-00.000Z_s.pipette'),
      'sync/keyboards/bare/snapshots/index.json': '{"uid":"bare","entries":[{"id":"x","filename":"no-date-here.pipette"}]}',
      'sync/keyboards/no-results/pipette_settings.json': settingsFile({ keyboardLayout: 'qwerty', autoAdvance: true, typingTestResults: [] }),
      'sync/keyboards/invalid/pipette_settings.json': settingsFile({ keyboardLayout: 1, typingTestResults: [RESULT] }),
      'sync/keyboards/no-file/': null,
      'sync/keyboards/dir-file/pipette_settings.json/': null,
      'sync/keyboards/loose-file': 'x',
    },
    steps: [{ op: 'listAll' }],
  },
  {
    name: 'no keyboards directory pools nothing',
    time: T0,
    config: DEFAULTS,
    tree: {},
    steps: [{ op: 'listAll' }],
  },
  {
    name: 'a null entry in the keyboard names fails the pool',
    time: T0,
    config: DEFAULTS,
    tree: {
      'sync/meta/keyboard-names.json': names([null]),
      [FILE]: settingsFile({ keyboardLayout: 'qwerty', autoAdvance: true, typingTestResults: [RESULT] }),
    },
    steps: [{ op: 'listAll' }],
  },
]

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function build(dir: string, tree: Tree): void {
  for (const [path, content] of Object.entries(tree)) {
    const target = join(dir, path)
    if (content === null) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : Buffer.from(content.hex, 'hex'))
  }
}

/** Every file and directory (`path/` → null) under `dir`. */
function record(dir: string, prefix = ''): Tree {
  const tree: Tree = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) {
      tree[`${prefix}${name}/`] = null
      Object.assign(tree, record(path, `${prefix}${name}/`))
    } else {
      const bytes = readFileSync(path)
      const text = bytes.toString('utf-8')
      tree[`${prefix}${name}`] = Buffer.from(text, 'utf-8').equals(bytes) ? text : { hex: bytes.toString('hex') }
    }
  }
  return tree
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

/** What the settings members are, for one run. */
interface Members {
  get: (uid: string) => Promise<unknown>
  patch: (uid: string, patch: unknown) => Promise<unknown>
  ensureDir: (uid: string) => Promise<unknown>
  listAll: () => Promise<unknown>
}

const ELECTRON: Members = {
  get: (uid) => handler(IpcChannels.PIPETTE_SETTINGS_GET)({}, uid),
  patch: (uid, p) => handler(IpcChannels.PIPETTE_SETTINGS_PATCH)({}, uid, p),
  ensureDir: (uid) => handler(IpcChannels.PIPETTE_SETTINGS_ENSURE_DIR)({}, uid),
  listAll: () => handler(IpcChannels.PIPETTE_SETTINGS_LIST_ALL_TYPING_RESULTS)({}),
}

const SHIM: Members = {
  get: (uid) => settingsApi.pipetteSettingsGet(uid),
  patch: (uid, p) => settingsApi.pipetteSettingsPatch(uid, p as never),
  ensureDir: (uid) => settingsApi.pipetteSettingsEnsureDir(uid),
  listAll: () => settingsApi.pipetteSettingsListAllTypingResults(),
}

/** The settings file of `uid` under `dir` as the crate reads it. */
function readSettings(dir: string, uid: string): { content: string | null; etag: string } {
  try {
    const bytes = readFileSync(join(dir, 'sync', 'keyboards', uid, 'pipette_settings.json'))
    return { content: bytes.toString('utf-8'), etag: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    return { content: null, etag: 'absent' }
  }
}

/** A backend on `dir` that stores as the crate does, logging each settings
 *  command to `commands`. */
function crateBackend(dir: string, commands: Command[]): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
  const keyboardDir = (uid: unknown): string => {
    if (typeof uid !== 'string' || !isSafePathSegment(uid)) throw new Error('Invalid uid')
    return join(dir, 'sync', 'keyboards', uid)
  }
  const answer = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case 'pipette_settings_read':
        keyboardDir(args.uid)
        return readSettings(dir, args.uid as string)
      case 'pipette_settings_write': {
        const kbDir = keyboardDir(args.uid)
        if (readSettings(dir, args.uid as string).etag !== args.etag) return 'conflict'
        mkdirSync(kbDir, { recursive: true })
        writeFileSync(join(kbDir, 'pipette_settings.json'), args.content as string)
        notified.push(`keyboards/${String(args.uid)}/settings`)
        return 'written'
      }
      case 'pipette_settings_ensure_dir':
        mkdirSync(keyboardDir(args.uid), { recursive: true })
        return null
      case 'pipette_settings_read_all': {
        const metaMap = getActiveKeyboardMetaMap(await readKeyboardMetaIndex())
        const keyboardsDir = join(dir, 'sync', 'keyboards')
        let entries: import('node:fs').Dirent[] = []
        try {
          entries = readdirSync(keyboardsDir, { withFileTypes: true })
        } catch { /* no keyboards yet */ }
        const files: { uid: string; name: unknown; content: string }[] = []
        for (const entry of entries) {
          if (!entry.isDirectory() || !isSafePathSegment(entry.name)) continue
          const { content } = readSettings(dir, entry.name)
          if (content === null) continue
          files.push({ uid: entry.name, name: await resolveKeyboardDisplayName(entry.name, metaMap), content })
        }
        return files
      }
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }
  return async (cmd, args = {}) => {
    if (cmd === 'app_config_get_all') return config.current
    const logged: Command = { command: cmd, args }
    commands.push(logged)
    try {
      logged.response = await answer(cmd, args)
      return logged.response
    } catch (err) {
      logged.error = err instanceof Error ? err.message : String(err)
      throw err
    }
  }
}

/** The response as JSON text; a rejection as `<rejected>`. */
async function outcome(response: Promise<unknown>): Promise<string | null> {
  try {
    return JSON.stringify(await response) ?? null
  } catch {
    return '<rejected>'
  }
}

interface Played {
  outcomes: (string | null)[]
  notified: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string, members: Members): Promise<Played> {
  paths.userData = dir
  notified.length = 0
  config.current = scenario.config
  build(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: (string | null)[] = []
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'at':
          vi.setSystemTime(new Date(step.time))
          outcomes.push(null)
          break
        case 'get': outcomes.push(await outcome(members.get(step.uid))); break
        case 'patch': outcomes.push(await outcome(members.patch(step.uid, step.patch))); break
        case 'patches':
          outcomes.push(await outcome(Promise.all(step.patches.map((p) => members.patch(step.uid, p)))))
          break
        case 'ensureDir': outcomes.push(await outcome(members.ensureDir(step.uid))); break
        case 'listAll': outcomes.push(await outcome(members.listAll())); break
      }
    }
    return { outcomes, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('pipette settings fixtures', () => {
  it('records each scenario on the handlers, and the shim’s commands that do the same', async () => {
    setupPipetteSettingsStore()
    root = mkdtempSync(join(tmpdir(), 'settings-store-fixtures-'))
    const results: unknown[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const electronDir = join(root, `${i}-electron`)
      const shimDir = join(root, `${i}-shim`)
      mkdirSync(electronDir)
      mkdirSync(shimDir)
      const electron = await play(scenario, electronDir, ELECTRON)
      const commands: Command[] = []
      backend.call = crateBackend(shimDir, commands)
      const shim = await play(scenario, shimDir, SHIM)
      expect(shim, scenario.name).toEqual(electron)
      results.push({ ...scenario, ...electron, commands })
    }
    writeJsonFixture(OUT, results)
  })
})
