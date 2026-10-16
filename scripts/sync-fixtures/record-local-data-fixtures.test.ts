// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the Local Data export and import of
// src-tauri/crates/pipette-sync (local_data/): seeds a userData tree and
// runs the real EXPORT_LOCAL_DATA / IMPORT_LOCAL_DATA handlers of
// src/main/sync/sync-ipc.ts on it, with the file dialog answered by the
// scenario, and records:
//   - export: the handler's result, the save dialog's default file name and
//     filters, and the text of the file it wrote;
//   - import: the handler's result (an error as its kind and its text with
//     the userData path replaced), the units it reported for sync, and the
//     userData tree after it.
// Every other dependency of the handlers is a stub; nothing reaches Drive.
//
// Run: pnpm run generate:sync-fixtures

import { describe, it, expect, vi } from 'vitest'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { FIXED_INSTALLATION_ID, FIXED_NOW, readTree, seedUserData, type Tree } from './harness'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_local_data.json')

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const notified: string[] = []

vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, handler) },
  secureOn: () => undefined,
}))
vi.mock('../../src/main/sync/sync-service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const bundle = await import('../../src/main/sync/sync-bundle')
  const stubs = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      // Errors stay real classes for `instanceof`; every other function is a stub.
      typeof value === 'function' && !name.endsWith('Error') ? vi.fn(async () => undefined) : value,
    ]),
  )
  return {
    ...stubs,
    collectAllSyncUnits: bundle.collectAllSyncUnits,
    bundleSyncUnit: bundle.bundleSyncUnit,
    notifyChange: (unit: string) => { notified.push(unit) },
  }
})
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  onAppConfigChange: vi.fn(),
  getAppConfigStore: vi.fn(() => ({ get: () => false, clear: vi.fn() })),
}))
vi.mock('../../src/main/sync/google-auth', () => ({
  startOAuthFlow: vi.fn(async () => undefined),
  getAuthStatus: vi.fn(async () => ({ authenticated: false })),
}))
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: vi.fn(async () => 'ownhash0') }))
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: vi.fn(() => ({ listLocalKeyboardUids: () => [] })),
}))
vi.mock('../../src/main/typing-analytics/import-export', () => ({
  exportTypingDataForKeyboard: vi.fn(),
  importTypingDataFiles: vi.fn(),
}))
vi.mock('../../src/main/typing-analytics/deleted-ranges-apply', () => ({ prepareOwnDeletedRangesReapply: vi.fn() }))
vi.mock('../../src/main/typing-analytics/cache-rebuild', () => ({ ensureCacheIsFresh: vi.fn() }))
vi.mock('../../src/main/typing-analytics/typing-analytics-service', () => ({
  runOnFlushChain: async (task: () => Promise<void>) => { await task() },
  deleteAllTypingForKeyboard: vi.fn(),
  deleteTypingDailySummaries: vi.fn(),
  listTypingKeyboards: vi.fn(() => []),
}))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))

import { dialog } from 'electron'
import { setupSyncIpc } from '../../src/main/sync/sync-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'

// ---- Inputs ----

const DAY = 86_400_000
const D = (n: number): string => new Date(FIXED_NOW - n * DAY).toISOString()
const json = (value: unknown): string => JSON.stringify(value, null, 2)

const clocks = (c: Partial<Record<string, string>> = {}, base = D(10)) => ({ created: base, body: base, name: base, hub: base, ...c })

function fav(id: string, over: Record<string, unknown> = {}) {
  return { id, label: `Fav ${id}`, filename: `macro_t_${id}.json`, savedAt: D(10), clocks: clocks(), updatedAt: D(10), ...over }
}

function snap(id: string, over: Record<string, unknown> = {}) {
  return { id, label: `Snap ${id}`, filename: `KB_t_${id}.pipette`, savedAt: D(10), vilVersion: 2, clocks: clocks(), updatedAt: D(10), ...over }
}

/** A v1 entry, as an old export carries it. */
const v1 = (id: string, filename: string, over: Record<string, unknown> = {}) => ({ id, label: `L ${id}`, filename, savedAt: '2020-01-01T00:00:00.000Z', ...over })

const bundleOf = (entries: unknown[], files: Record<string, unknown>) => ({ index: { entries }, files })
const settingsOf = (content: unknown) => ({ files: { 'pipette_settings.json': content } })
const file = (data: Record<string, unknown>): string => JSON.stringify({ version: 1, ...data })

interface ExportScenario {
  name: string
  tree: Tree
  /** The save dialog is cancelled. */
  cancel?: boolean
}

interface ImportScenario {
  name: string
  tree: Tree
  /** The text of the file the open dialog picks; none: cancelled. */
  text: string | null
  /** Directories (relative to userData) made read-only for the import. */
  readOnly?: string[]
}

const FULL_TREE: Tree = {
  'sync/favorites/macro/index.json': json({ type: 'macro', entries: [fav('a'), fav('d', { deletedAt: D(1), updatedAt: D(1) })] }),
  'sync/favorites/macro/macro_t_a.json': '{"a":1}',
  'sync/favorites/tapDance/index.json': json({ type: 'tapDance', entries: [] }),
  'sync/meta/keyboard-names.json': json({ type: 'keyboard-meta', version: 1, entries: [{ uid: 'kbA', deviceName: 'A', updatedAt: D(1) }] }),
  'sync/key-labels/index.json': json({ entries: [] }),
  'sync/keyboards/kbA/pipette_settings.json': '{"_updatedAt":"2026-10-01T00:00:00.000Z","layer":"ü"}',
  'sync/keyboards/kbA/snapshots/index.json': json({ uid: 'kbA', entries: [snap('s1', { filename: 'legacy.pipette' }), snap('s2', { filename: 'KB_t_s2.pipette' })] }),
  'sync/keyboards/kbA/snapshots/legacy.pipette': 'SNAP1',
  'sync/keyboards/kbA/analyze_filters/index.json': json({ uid: 'kbA', entries: [] }),
  'sync/keyboards/kbA/runs/index.json': json({ uid: 'kbA', entries: [] }),
  'sync/keyboards/kbA/devices/ownhash0/2026-10-15.jsonl': '{"id":"x"}\n',
  'sync/keyboards/123/pipette_settings.json': '{"_updatedAt":"2026-09-01T00:00:00.000Z"}',
  'sync/keyboards/kbB/snapshots/index.json': '{not json',
}

const EXPORTS: ExportScenario[] = [
  { name: 'exports the favorites, snapshots and settings of a full userData', tree: FULL_TREE },
  { name: 'an empty userData exports empty categories', tree: {} },
  { name: 'a cancelled save dialog writes nothing', tree: FULL_TREE, cancel: true },
]

const LOCAL_SNAPS = 'sync/keyboards/uid1/snapshots'
const LOCAL_SETTINGS = 'sync/keyboards/uid1/pipette_settings.json'

const IMPORTS: ImportScenario[] = [
  {
    name: 'writes all three categories and reports the changed units',
    tree: {},
    text: file({
      snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette')], { 's_e1.pipette': '{"vil":true}' }) },
      favorites: { macro: bundleOf([v1('f1', 'm_f1.json')], { 'm_f1.json': '{"data":1}' }) },
      settings: { uid1: settingsOf(JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 1 })) },
    }),
  },
  {
    name: 'a failed settings write rolls back the snapshots written before it',
    tree: {
      [`${LOCAL_SNAPS}/index.json`]: json({ uid: 'uid1', entries: [] }),
      'sync/keyboards/uid2/pipette_settings.json': json({ _updatedAt: '2019-01-01T00:00:00.000Z', foo: 'old' }),
    },
    text: file({
      snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette'), v1('e2', 's_e2.pipette')], { 's_e1.pipette': 'P1', 's_e2.pipette': 'P2' }) },
      settings: { uid2: settingsOf(JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 'new' })) },
      favorites: { macro: bundleOf([v1('f1', 'm_f1.json')], { 'm_f1.json': 'F' }) },
    }),
    readOnly: ['sync/keyboards/uid2'],
  },
  {
    name: 'a corrupted local index fails the import and is left as it is',
    tree: { [`${LOCAL_SNAPS}/index.json`]: '{not valid json' },
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette')], { 's_e1.pipette': 'P1' }) } }),
  },
  {
    name: 'a live local entry wins over the file',
    tree: {
      [`${LOCAL_SNAPS}/index.json`]: json({ uid: 'uid1', entries: [v1('e1', 's_e1.pipette', { label: 'Local', savedAt: '2019-01-01T00:00:00.000Z' })] }),
      [`${LOCAL_SNAPS}/s_e1.pipette`]: 'ORIGINAL',
    },
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette', { label: 'Remote' })], { 's_e1.pipette': 'REMOTE' }) } }),
  },
  {
    name: 'older or equal settings are not written, newer ones are',
    tree: {
      [LOCAL_SETTINGS]: json({ _updatedAt: '2024-01-01T00:00:00.000Z', foo: 'newer' }),
      'sync/keyboards/uid2/pipette_settings.json': json({ _updatedAt: '2024-01-01T00:00:00.000Z' }),
      'sync/keyboards/uid3/pipette_settings.json': json({ _updatedAt: '2019-01-01T00:00:00.000Z' }),
      'sync/keyboards/uid4/pipette_settings.json': json({ _updatedAt: 'not a time' }),
    },
    text: file({
      settings: {
        uid1: settingsOf(JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 'older' })),
        uid2: settingsOf(JSON.stringify({ _updatedAt: '2024-01-01T00:00:00.000Z', foo: 'same' })),
        uid3: settingsOf(JSON.stringify({ _updatedAt: '2025-01-01T00:00:00.000Z', foo: 'newer' })),
        uid4: settingsOf(JSON.stringify({ _updatedAt: '2025-01-01T00:00:00.000Z', foo: 'vs NaN' })),
      },
    }),
  },
  {
    name: 'settings that are not JSON fail the import before anything is written',
    tree: { [LOCAL_SETTINGS]: json({ _updatedAt: '2019-01-01T00:00:00.000Z' }) },
    text: file({
      snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette')], { 's_e1.pipette': 'P1' }) },
      settings: { uid1: settingsOf('{not valid json') },
    }),
  },
  {
    name: 'local settings that cannot be compared are replaced',
    tree: {
      [LOCAL_SETTINGS]: '{not json',
      'sync/keyboards/uid2/pipette_settings.json': 'null',
      'sync/keyboards/uid3/pipette_settings.json': '"text"',
      'sync/keyboards/uid4/pipette_settings.json': json({ _updatedAt: '2030-01-01T00:00:00.000Z' }),
    },
    text: file({
      settings: {
        uid1: settingsOf('{"_updatedAt":"2020-01-01T00:00:00.000Z"}'),
        uid2: settingsOf('{"_updatedAt":"2020-01-01T00:00:00.000Z"}'),
        uid3: settingsOf('{"_updatedAt":"2020-01-01T00:00:00.000Z"}'),
        uid4: settingsOf('null'),
        uid5: settingsOf(null),
        uid6: { files: {} },
        uid7: {},
      },
    }),
  },
  {
    name: 'settings files that are not an object fail the import',
    tree: {},
    text: file({ settings: { uid1: { files: [] } } }),
  },
  {
    name: 'settings content that is not a string fails the import',
    tree: {},
    text: file({ settings: { uid1: settingsOf(5) } }),
  },
  {
    name: 'a bundle without index entries fails the import',
    tree: {},
    text: file({ snapshots: { uid1: { index: {}, files: {} } } }),
  },
  {
    name: 'malformed entries are skipped and unsafe keys ignored',
    tree: {},
    text: file({
      snapshots: {
        uid1: bundleOf(
          [
            v1('e1', undefined as unknown as string),
            v1('e2', 's_e2.pipette'),
            5,
            'text',
            [],
            { id: 3, filename: 'x.pipette' },
            v1('e3', '../escape.pipette'),
            v1('e4', '..'),
          ],
          { 's_e2.pipette': 'P2' },
        ),
        '../evil': bundleOf([v1('x', 'x.pipette')], { 'x.pipette': 'X' }),
      },
      favorites: { 'bad/type': bundleOf([v1('f', 'f.json')], {}) },
    }),
  },
  {
    name: 'a null entry fails the import',
    tree: {},
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette'), null], { 's_e1.pipette': 'P1' }) } }),
  },
  {
    name: 'a body that is not a string fails the import',
    tree: {},
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 's_e1.pipette')], { 's_e1.pipette': 5 }) } }),
  },
  {
    name: 'a body named like an inherited property fails the import',
    tree: {},
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 'toString')], {}) } }),
  },
  {
    name: 'revives a local tombstone past its deletedAt, from a clock running ahead too',
    tree: {
      [`${LOCAL_SNAPS}/index.json`]: json({ uid: 'uid1', entries: [snap('e1', { filename: 'KB_t_e1.pipette', deletedAt: D(-1), updatedAt: D(-1) })] }),
      [`${LOCAL_SNAPS}/KB_t_e1.pipette`]: 'OLD BODY',
    },
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 'KB_t.pipette', { label: 'Back' })], { 'KB_t.pipette': 'BACKUP' }) } }),
  },
  {
    name: 'gives an entry the store lacks a new created and keeps its other clocks',
    tree: { [`${LOCAL_SNAPS}/index.json`]: json({ uid: 'uid1', note: 'kept', entries: [snap('other')] }) },
    text: file({ snapshots: { uid1: bundleOf([snap('e1', { filename: 'KB_t.pipette' })], { 'KB_t.pipette': 'BODY' }) } }),
  },
  {
    name: 'a tombstone in the file never replaces a live entry and is added where none is',
    tree: { [`${LOCAL_SNAPS}/index.json`]: json({ uid: 'uid1', entries: [v1('e1', 's_e1.pipette')] }) },
    text: file({
      snapshots: {
        uid1: bundleOf(
          [v1('e1', 's_e1.pipette', { deletedAt: '2030-01-01T00:00:00.000Z' }), v1('e2', 's_e2.pipette', { deletedAt: D(2) })],
          { 's_e2.pipette': 'DEAD BODY' },
        ),
      },
    }),
  },
  {
    name: 'saves bodies and moves the local bodies under id-carrying names',
    tree: {
      'sync/favorites/macro/index.json': json({ type: 'macro', entries: [v1('l1', 'shared.json'), v1('l2', 'shared.json')] }),
      'sync/favorites/macro/shared.json': 'LOCAL',
    },
    text: file({ favorites: { macro: bundleOf([v1('b1', 'macro_ts.json')], { 'macro_ts.json': 'BACKUP' }) } }),
  },
  {
    name: 'an id twice in the file',
    tree: {
      [`${LOCAL_SNAPS}/index.json`]: json({ uid: 'uid1', entries: [snap('dead', { deletedAt: D(1), updatedAt: D(1) })] }),
    },
    text: file({
      snapshots: {
        uid1: bundleOf(
          [v1('dead', 'a.pipette', { label: 'first' }), v1('dead', 'b.pipette', { label: 'second' }), v1('new', 'c.pipette'), v1('new', 'd.pipette')],
          { 'a.pipette': 'A', 'b.pipette': 'B', 'c.pipette': 'C', 'd.pipette': 'D' },
        ),
      },
    }),
  },
  {
    name: 'local indexes of other shapes',
    tree: {
      'sync/keyboards/uid1/snapshots/index.json': '[1,2]',
      'sync/keyboards/uid2/snapshots/index.json': '{"uid":"uid2"}',
      'sync/keyboards/uid3/snapshots/index.json': '"ab"',
    },
    text: file({
      snapshots: {
        uid1: bundleOf([v1('e1', 's.pipette')], {}),
        uid2: bundleOf([v1('e1', 's.pipette')], {}),
        uid3: bundleOf([v1('e1', 's.pipette')], {}),
      },
    }),
  },
  {
    name: 'a null local index fails the import',
    tree: { 'sync/keyboards/uid1/snapshots/index.json': 'null' },
    text: file({ snapshots: { uid1: bundleOf([v1('e1', 's.pipette')], {}) } }),
  },
  {
    name: 'keyboards are imported in the order of the file object',
    tree: {},
    text: file({
      favorites: { macro: bundleOf([v1('f', 'f.json')], {}) },
      settings: { b: settingsOf('{}'), 7: settingsOf('{}') },
      snapshots: { zz: bundleOf([v1('e', 'e.pipette')], {}), 10: bundleOf([v1('e', 'e.pipette')], {}), 2: bundleOf([v1('e', 'e.pipette')], {}) },
    }),
  },
  { name: 'a file of another version', tree: {}, text: JSON.stringify({ version: 2 }) },
  { name: 'a file that is not an object', tree: {}, text: '[1]' },
  { name: 'a file that is not JSON', tree: {}, text: '{"version":1,' },
  { name: 'a cancelled open dialog imports nothing', tree: { [LOCAL_SETTINGS]: '{}' }, text: null },
]

// ---- Recording ----

function errorOf(message: string, userData: string): { kind: string; message: string } {
  const text = message.split(userData).join('<userData>')
  const kind = text === 'Invalid export file format' ? 'format'
    : text === 'Unsupported export version' ? 'version'
      : text.startsWith('Corrupted index: ') ? 'corrupted'
        : text.startsWith('Cannot read properties of null') ? 'type'
          : text.startsWith('Import failed: ') ? 'rollback'
            : /^E[A-Z]+: /.test(text) ? 'os'
              : 'syntax'
  return { kind, message: text }
}

function handler(channel: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<Record<string, unknown>>
}

async function recordExport(scenario: ExportScenario) {
  const userData = seedUserData(scenario.tree)
  const out = join(userData, 'exported.json')
  vi.mocked(dialog.showSaveDialog).mockReset()
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce(
    (scenario.cancel ? { canceled: true } : { canceled: false, filePath: out }) as never,
  )
  const result = await handler(IpcChannels.EXPORT_LOCAL_DATA)({})
  const [options] = vi.mocked(dialog.showSaveDialog).mock.calls[0] as unknown as [{ defaultPath: string; filters: unknown }]
  let written: string | null = null
  try {
    written = readFileSync(out, 'utf8')
    rmSync(out)
  } catch {
    written = null
  }
  return {
    name: scenario.name,
    tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
    cancel: scenario.cancel ?? false,
    result,
    dialog: { defaultPath: options.defaultPath, filters: options.filters },
    written,
    after: readTree(userData),
  }
}

async function recordImport(scenario: ImportScenario) {
  const userData = seedUserData(scenario.tree)
  const picked = join(userData, 'picked.json')
  if (scenario.text !== null) writeFileSync(picked, scenario.text)
  vi.mocked(dialog.showOpenDialog).mockReset()
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce(
    (scenario.text === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picked] }) as never,
  )
  notified.length = 0
  for (const dir of scenario.readOnly ?? []) chmodSync(join(userData, dir), 0o555)
  let result: Record<string, unknown>
  try {
    result = await handler(IpcChannels.IMPORT_LOCAL_DATA)({})
  } finally {
    for (const dir of scenario.readOnly ?? []) chmodSync(join(userData, dir), 0o755)
  }
  rmSync(picked, { force: true })
  const [options] = vi.mocked(dialog.showOpenDialog).mock.calls[0] as unknown as [{ filters: unknown; properties: unknown }]
  const outcome = result.success === false
    ? { success: false, error: errorOf(String(result.error), userData) }
    : result
  return {
    name: scenario.name,
    tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
    text: scenario.text,
    readOnly: scenario.readOnly ?? [],
    result: outcome,
    dialog: { filters: options.filters, properties: options.properties },
    notified: [...notified],
    after: readTree(userData),
  }
}

describe('local data fixtures', () => {
  it('records every scenario', async () => {
    setupSyncIpc()
    const exports = []
    for (const scenario of EXPORTS) exports.push(await recordExport(scenario))
    const imports = []
    for (const scenario of IMPORTS) imports.push(await recordImport(scenario))
    expect(imports.length).toBe(IMPORTS.length)
    writeJsonFixture(OUT, { now: FIXED_NOW, exports, imports })
  })
})
