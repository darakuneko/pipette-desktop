// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the bundles and merges of src-tauri/crates/pipette-sync:
// seeds a userData tree, runs the real src/main/sync code on it step by step
// and records what each step did:
//   - `merge`: `mergeWithRemote` of a remote bundle (its plaintext) for a
//     unit; whether it failed (and how), the bundle it uploaded when Drive
//     needed this device's copy, the windows it notified, the units it
//     reported for sync and the Drive revisions it forgot;
//   - `gc`: `runPackGcAfterPass` after a pass that attempted (and failed)
//     some units;
//   - `bundle`: the plaintext of `bundleSyncUnit` for units;
//   - `collect`: `collectAllSyncUnits` and `collectAnalyticsSyncUnitsForUid`;
// and the userData tree after every step (path → text).
//
// Drive and the encryption are stubbed: the downloaded envelope is the
// plaintext itself, and an upload is recorded, never sent.
//
// Run: pnpm run generate:sync-fixtures

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolve } from 'node:path'
import { utimesSync } from 'node:fs'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { FIXED_INSTALLATION_ID, FIXED_NOW, readTree, seedUserData, type Tree } from './harness'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_sync_merge.json')

const OWN_HASH = 'ownhash0'

interface Recorder {
  envelope: string
  uploads: string[]
  bundleCalls: string[]
  events: Array<[string, unknown]>
  pending: string[]
  forgotten: string[]
  typingUids: string[]
}

const rec: Recorder = { envelope: '', uploads: [], bundleCalls: [], events: [], pending: [], forgotten: [], typingUids: [] }

vi.mock('../../src/main/sync/google-drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/google-drive')>()
  return {
    ...actual,
    listFiles: vi.fn(async () => []),
    downloadFile: vi.fn(async () => ({ ciphertext: rec.envelope })),
    uploadFile: vi.fn(async (_name: string, envelope: { ciphertext: string }) => {
      rec.uploads.push(envelope.ciphertext)
      return { id: 'uploaded', modifiedTime: '2026-10-16T00:00:00.000Z' }
    }),
  }
})
vi.mock('../../src/main/sync/sync-crypto', () => ({
  encrypt: vi.fn(async (plaintext: string, _pw: string, syncUnit: string) => ({ syncUnit, ciphertext: plaintext })),
  decrypt: vi.fn(async (envelope: { ciphertext: string }) => envelope.ciphertext),
}))
vi.mock('../../src/main/sync/sync-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/sync-bundle')>()
  return {
    ...actual,
    bundleSyncUnit: vi.fn(async (unit: string) => {
      rec.bundleCalls.push(unit)
      return actual.bundleSyncUnit(unit)
    }),
  }
})
vi.mock('../../src/main/sync/sync-runtime-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/sync-runtime-state')>()
  return {
    ...actual,
    forgetRemoteState: vi.fn((name: string) => {
      rec.forgotten.push(name)
      actual.forgetRemoteState(name)
    }),
  }
})
vi.mock('../../src/main/sync/sync-service', () => ({
  notifyChange: vi.fn((unit: string) => { rec.pending.push(unit) }),
}))
vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn((channel: string, payload?: unknown) => { rec.events.push([channel, payload ?? null]) }),
}))
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: vi.fn(async () => OWN_HASH) }))
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: vi.fn(() => ({ listLocalKeyboardUids: () => rec.typingUids })),
}))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

import { mergeWithRemote } from '../../src/main/sync/sync-merge-dispatch'
import { bundleSyncUnit, collectAllSyncUnits, collectAnalyticsSyncUnitsForUid } from '../../src/main/sync/sync-bundle'
import { runPackGcAfterPass } from '../../src/main/sync/pack-gc'
import { syncRuntime } from '../../src/main/sync/sync-runtime-state'
import type { DriveFile } from '../../src/main/sync/google-drive'

// ---- Inputs ----

const DAY = 86_400_000
/** `n` days before the fixed clock, as `toISOString` writes it. */
const D = (n: number): string => new Date(FIXED_NOW - n * DAY).toISOString()
const json = (value: unknown): string => JSON.stringify(value, null, 2)

type Step =
  | { merge: { unit: string; plaintext: string; modifiedTime: string } }
  | { gc: { attempted: string[]; failed: string[] } }
  | { bundle: string[] }
  | { collect: { uid: string } }

interface Scenario {
  name: string
  tree: Tree
  /** File path → modification time in ms. */
  mtimes?: Record<string, number>
  typingUids?: string[]
  steps: Step[]
}

const merge = (unit: string, bundle: unknown, modifiedTime?: string): Step =>
  ({ merge: { unit, plaintext: typeof bundle === 'string' ? bundle : JSON.stringify(bundle), modifiedTime: modifiedTime ?? D(0) } })

const clocks = (c: Partial<Record<string, string>> = {}, base = D(10)) => ({ created: base, body: base, name: base, hub: base, ...c })

function fav(id: string, c: Partial<Record<string, string>> = {}, over: Record<string, unknown> = {}) {
  return { id, label: `Fav ${id}`, filename: `macro_t_${id}.json`, savedAt: D(10), clocks: clocks(c), updatedAt: D(10), ...over }
}

function snap(id: string, c: Partial<Record<string, string>> = {}, over: Record<string, unknown> = {}) {
  return { id, label: `Snap ${id}`, filename: `KB_t_${id}.pipette`, savedAt: D(10), vilVersion: 2, clocks: clocks(c), updatedAt: D(10), ...over }
}

function run(i: number) {
  const id = `r${String(i).padStart(2, '0')}`
  const at = new Date(FIXED_NOW - (60 - i) * 60_000).toISOString()
  return { id, startedAt: at, filename: `t_${id}.json`, savedAt: at, clocks: { created: at, body: at }, updatedAt: at }
}

function pack(id: string, c: Partial<Record<string, string>> = {}, over: Record<string, unknown> = {}) {
  return {
    id, name: `Pack ${id}`, version: '1.0', enabled: true, savedAt: D(10), filename: `packs/${id}.json`,
    clocks: { ...clocks(c), enabled: D(10), ...c }, updatedAt: D(10), ...over,
  }
}

const packBody = (version: string, extra: Record<string, unknown> = {}): string => json({ version, name: 'P', ...extra })

const RANGES = json({ version: 1, entries: [{ id: 'g1', startMs: 1000, endMs: 2000, cutoffMs: 3000 }, { id: 'bad', startMs: 5, endMs: 1 }] })

const SCENARIOS: Scenario[] = [
  {
    name: 'favorites: the groups of both sides, legacy names, an orphan and an unsafe name',
    tree: {
      'sync/favorites/macro/index.json': json({ type: 'macro', entries: [
        fav('a', { name: D(2) }, { label: 'renamed here', updatedAt: D(2) }),
        fav('b'),
        { id: 'legacy', label: 'Legacy', filename: 'legacy.json', savedAt: D(20) },
        fav('dead', {}, { deletedAt: D(40), updatedAt: D(40) }),
      ] }),
      'sync/favorites/macro/macro_t_a.json': '{"a":1}',
      'sync/favorites/macro/macro_t_b.json': '{"b":1}',
      'sync/favorites/macro/legacy.json': '{"legacy":1}',
      'sync/favorites/macro/macro_t_orphan.json': 'orphan',
      'sync/favorites/macro/notes.txt': 'not a body',
    },
    steps: [
      merge('favorites/macro', {
        type: 'favorite', key: 'macro',
        index: { type: 'macro', entries: [
          fav('a', { body: D(1) }, { updatedAt: D(1) }),
          fav('b', {}, { deletedAt: D(3), updatedAt: D(3) }),
          fav('c', { created: D(4), body: D(4) }, { filename: 'remote-legacy.json', updatedAt: D(4) }),
          fav('evil', {}, { filename: '../evil.json' }),
          { id: 7, filename: 'x.json' },
          'not an entry',
        ] },
        files: { 'macro_t_a.json': '{"a":2}', 'remote-legacy.json': '{"c":1}', '../evil.json': 'evil' },
      }),
      { bundle: ['favorites/macro'] },
      merge('favorites/macro', JSON.parse(JSON.stringify({ type: 'favorite', key: 'macro', index: { type: 'macro', entries: [] }, files: {} }))),
    ],
  },
  {
    name: 'snapshots: a body tie broken by the hash, then the other way',
    tree: {
      'sync/keyboards/kb1/snapshots/index.json': json({ uid: 'kb1', entries: [snap('s1')] }),
      'sync/keyboards/kb1/snapshots/KB_t_s1.pipette': 'AAAA',
    },
    steps: [
      merge('keyboards/kb1/snapshots', { index: { uid: 'kb1', entries: [snap('s1')] }, files: { 'KB_t_s1.pipette': 'BBBB' } }),
      merge('keyboards/kb1/snapshots', { index: { uid: 'kb1', entries: [snap('s1')] }, files: { 'KB_t_s1.pipette': 'AAAA' } }),
    ],
  },
  {
    name: 'analyze filters: no local index, a stray body kept, the remote index as the base',
    tree: { 'sync/keyboards/kb2/analyze_filters/stray_x.json': 'stray' },
    steps: [
      merge('keyboards/kb2/analyze_filters', {
        index: { uid: 'kb2', extra: true, entries: [{ ...snap('f1'), filename: 'filter_f1.json', summary: 's' }] },
        files: { 'filter_f1.json': '{"f":1}' },
      }),
      { bundle: ['keyboards/kb2/analyze_filters'] },
    ],
  },
  {
    name: 'malformed bundles and units leave the files alone',
    tree: {
      'sync/favorites/combo/index.json': json({ type: 'combo', entries: [fav('a', {}, { filename: 'combo_t_a.json' })] }),
      'sync/favorites/combo/combo_t_a.json': '{}',
      'sync/keyboards/kb3/snapshots/index.json': '{"uid":"kb3","entries":',
      'sync/keyboards/kb3/snapshots/KB_t_x.pipette': 'kept',
    },
    steps: [
      merge('favorites/combo', { index: { entries: 'nope' }, files: {} }),
      merge('favorites/combo', { index: { entries: [] }, files: null }),
      merge('favorites/combo', { index: [], files: {} }),
      merge('favorites/combo', 'null'),
      merge('favorites/combo', '[]'),
      merge('favorites/combo', '"text"'),
      merge('favorites/..', { index: { entries: [] }, files: {} }),
      merge('foo/bar', { index: { entries: [] }, files: {} }),
      merge('keyboards/kb3/devices/h/days/2026-02-30', { index: { entries: [] }, files: {} }),
      merge('keyboards/kb3/snapshots', { index: { uid: 'kb3', entries: [snap('x')] }, files: { 'KB_t_x.pipette': 'remote' } }),
      merge('favorites/combo', { index: { entries: [] }, files: [] }),
    ],
  },
  {
    name: 'run logs: the retention tombstones and unlinks the oldest',
    tree: {
      'sync/keyboards/kb4/runs/index.json': json({ uid: 'kb4', entries: Array.from({ length: 50 }, (_, i) => run(i)) }),
      ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`sync/keyboards/kb4/runs/${run(i).filename}`, `{"run":${i}}`])),
    },
    steps: [
      merge('keyboards/kb4/runs', {
        index: { uid: 'kb4', entries: [run(50), run(51)] },
        files: { [run(50).filename]: '{"run":50}', [run(51).filename]: '{"run":51}' },
      }),
      { bundle: ['keyboards/kb4/runs'] },
    ],
  },
  {
    name: 'key labels keep the local order; typing-test texts merge by name and body',
    tree: {
      'sync/key-labels/index.json': json({ entries: [
        { id: 'k2', name: 'Two', filename: 'k2_t.json', savedAt: D(10), clocks: clocks(), updatedAt: D(10) },
        { id: 'k1', name: 'One', filename: 'k1_t.json', savedAt: D(10), clocks: clocks({ name: D(1) }), updatedAt: D(1) },
      ] }),
      'sync/key-labels/k2_t.json': '{"k":2}',
      'sync/key-labels/k1_t.json': '{"k":1}',
      'sync/typing-test-texts/index.json': json({ entries: [
        { id: 't1', name: 'Text', filename: 't1_a.json', savedAt: D(10), wordCount: 3, clocks: clocks(), updatedAt: D(10) },
      ] }),
      'sync/typing-test-texts/t1_a.json': '{"text":"a b c"}',
    },
    steps: [
      merge('key-labels', { index: { entries: [
        { id: 'k3', name: 'Three', filename: 'k3_t.json', savedAt: D(2), clocks: clocks({}, D(2)), updatedAt: D(2) },
        { id: 'k1', name: 'Uno', filename: 'k1_t.json', savedAt: D(10), clocks: clocks({ name: D(3) }), updatedAt: D(3) },
      ] }, files: { 'k3_t.json': '{"k":3}', 'k1_t.json': '{"k":1}' } }),
      merge('typing-test-texts', { index: { entries: [
        { id: 't1', name: 'Renamed', filename: 't1_b.json', savedAt: D(1), wordCount: 4, clocks: clocks({ body: D(1), name: D(1) }), updatedAt: D(1) },
      ] }, files: { 't1_b.json': '{"text":"a b c d"}' } }),
      { bundle: ['key-labels', 'typing-test-texts'] },
    ],
  },
  {
    name: 'settings: last writer wins on _updatedAt',
    tree: {
      'sync/keyboards/kb5/pipette_settings.json': JSON.stringify({ _rev: 1, keyboardLayout: 'qwerty', _updatedAt: D(5) }),
      'sync/keyboards/kb6/pipette_settings.json': 'not json',
    },
    steps: [
      merge('keyboards/kb5/settings', { files: { 'pipette_settings.json': JSON.stringify({ keyboardLayout: 'dvorak', _updatedAt: D(6) }) } }),
      merge('keyboards/kb5/settings', { files: { 'pipette_settings.json': JSON.stringify({ keyboardLayout: 'qwerty', _updatedAt: D(5) }) } }),
      merge('keyboards/kb5/settings', { files: { 'pipette_settings.json': JSON.stringify({ keyboardLayout: 'colemak', _updatedAt: D(1) }) } }),
      merge('keyboards/kb6/settings', { files: { 'pipette_settings.json': JSON.stringify({ keyboardLayout: 'x', _updatedAt: 'garbage' }) } }),
      merge('keyboards/kb6/settings', { files: { 'pipette_settings.json': JSON.stringify({ keyboardLayout: 'y', _updatedAt: D(9) }) } }),
      merge('keyboards/kb7/settings', { files: {} }),
      merge('keyboards/kb7/settings', { files: { 'pipette_settings.json': '' } }),
      merge('keyboards/kb7/settings', { files: { 'pipette_settings.json': 'null' } }),
      merge('keyboards/kb7/settings', { files: { 'pipette_settings.json': '{' } }),
      merge('keyboards/kb7/settings', { files: { 'pipette_settings.json': 5 } }),
      merge('keyboards/kb8/settings', {}),
      { bundle: ['keyboards/kb5/settings', 'keyboards/kb6/settings', 'keyboards/kb7/settings', 'keyboards/kb9/settings'] },
    ],
  },
  {
    name: 'keyboard names: per-uid last writer wins and the tombstone GC',
    tree: {
      'sync/meta/keyboard-names.json': json({ type: 'keyboard-meta', version: 1, extra: 'kept?', entries: [
        { uid: 'u1', deviceName: 'Local One', updatedAt: D(2) },
        { uid: 'u2', deviceName: 'Two', updatedAt: D(5) },
        { uid: 'u3', deviceName: '', updatedAt: D(40), deletedAt: D(40) },
        { uid: 'u4', deviceName: 'Four', updatedAt: D(1) },
      ] }),
    },
    steps: [
      merge('meta/keyboard-names', { type: 'keyboard-meta', key: 'keyboard-names', index: { type: 'keyboard-meta', version: 1, entries: [
        { uid: 'u1', deviceName: 'Remote One', updatedAt: D(3) },
        { uid: 'u2', deviceName: 'Two', updatedAt: D(4), deletedAt: D(4) },
        { uid: 'u5', deviceName: 'Five', updatedAt: D(1) },
      ] }, files: {} }),
      merge('meta/keyboard-names', { index: { entries: (JSON.parse(json([])) as unknown[]) } }),
      merge('meta/keyboard-names', { index: {} }),
      merge('meta/keyboard-names', 'null'),
      { bundle: ['meta/keyboard-names'] },
    ],
  },
  {
    name: 'packs: the roster, bodies before and after it, v1 metas and bundles',
    tree: {
      'sync/i18n/index.json': json({ metas: [
        { id: 'builtin-english', name: 'English', version: '1', enabled: true, savedAt: D(30), filename: 'packs/builtin-english.json' },
        { id: 'v1pack', name: 'Old', version: '0.9', enabled: true, savedAt: D(30), filename: 'packs/v1pack.json', coverage: 50 },
        pack('local', { body: D(2) }, { version: '2.0', coverage: 90 }),
      ] }),
      'sync/i18n/packs/v1pack.json': packBody('0.9'),
      'sync/i18n/packs/local.json': packBody('2.0'),
      'sync/themes/index.json': '{"metas":',
    },
    mtimes: { 'sync/i18n/packs/v1pack.json': FIXED_NOW - 20 * DAY },
    steps: [
      { bundle: ['i18n/index', 'i18n/packs/v1pack', 'i18n/packs/local', 'i18n/packs/builtin-english', 'i18n/packs/missing'] },
      merge('i18n/packs/remote', { files: { 'remote.json': packBody('3.0') }, body: { clock: D(1), fields: { version: '3.0' } } }),
      merge('i18n/index', { type: 'i18n-index', key: 'i18n-index', index: { metas: [
        pack('remote', { body: D(1) }, { version: '3.0', coverage: 70 }),
        pack('local', { body: D(5), name: D(1) }, { version: '1.5', name: 'Renamed' }),
        { ...pack('v1pack'), clocks: undefined, updatedAt: undefined },
        pack('../evil'),
        'junk',
      ] }, files: {} }),
      merge('i18n/packs/remote', { files: { 'remote.json': packBody('3.0') }, body: { clock: D(1), fields: { version: '3.0', coverage: 70, unknown: 1 } } }),
      merge('i18n/packs/local', { files: { 'local.json': packBody('1.5') }, body: { clock: D(5), fields: { version: '1.5' } } }),
      merge('i18n/packs/v1pack', { files: { 'v1pack.json': packBody('0.9') } }, D(25)),
      merge('i18n/packs/v1pack', { files: { 'v1pack.json': packBody('1.1') } }, D(1)),
      merge('i18n/packs/ghost', { files: { 'ghost.json': packBody('1') } }),
      merge('i18n/packs/builtin-english', { files: { 'builtin-english.json': '{}' } }),
      merge('i18n/packs/b@d', { files: {} }),
      merge('i18n/packs/local', 'null'),
      merge('themes/index', { index: { metas: [pack('t1')] } }),
      merge('themes/packs/t1', { files: { 't1.json': packBody('1') }, body: { clock: D(1), fields: { version: '1' } } }),
      merge('i18n/index', { index: { metas: 'nope' } }),
      { bundle: ['i18n/index', 'i18n/packs/remote', 'i18n/packs/local', 'i18n/packs/v1pack', 'themes/index'] },
    ],
  },
  {
    name: 'packs: waiting metas, tombstones and v1 bodies',
    tree: {
      'sync/i18n/index.json': json({ metas: [
        pack('wait', { body: '1970-01-01T00:00:00.000Z' }, { version: '2', coverage: 80 }),
        pack('tomb', {}, { deletedAt: D(1), updatedAt: D(1) }),
        pack('fresh', { body: '1970-01-01T00:00:00.000Z' }, { version: '3', coverage: 70, matchedBaseVersion: 'b' }),
        pack('fresh2', { body: '1970-01-01T00:00:00.000Z' }, { version: '3', coverage: 70 }),
        pack('same', { body: D(5) }, { version: '1', coverage: 60 }),
        { id: 'v1', name: 'Old', version: '1', enabled: true, savedAt: D(30), updatedAt: D(20), filename: 'packs/v1.json' },
      ] }),
      'sync/i18n/packs/wait.json': packBody('0'),
      'sync/i18n/packs/tomb.json': packBody('1'),
      'sync/i18n/packs/same.json': packBody('1'),
      'sync/i18n/packs/v1.json': packBody('1'),
    },
    mtimes: { 'sync/i18n/packs/wait.json': FIXED_NOW - 100 * DAY, 'sync/i18n/packs/v1.json': FIXED_NOW - 25 * DAY },
    steps: [
      { bundle: ['i18n/index', 'i18n/packs/wait', 'i18n/packs/tomb', 'i18n/packs/v1'] },
      merge('i18n/packs/tomb', { files: { 'tomb.json': packBody('9') }, body: { clock: D(0), fields: { version: '9' } } }),
      merge('i18n/packs/fresh', { files: { 'fresh.json': packBody('3') } }, D(2)),
      merge('i18n/packs/fresh2', { files: { 'fresh2.json': packBody('4') } }, D(2)),
      merge('i18n/packs/same', { files: { 'same.json': packBody('1') } }, D(1)),
      merge('i18n/packs/wait', { files: { 'wait.json': packBody('2') }, body: { clock: 'not a time', fields: { version: '2' } } }),
      merge('i18n/index', { index: { metas: [
        pack('fresh', { body: D(9) }, { version: '3' }),
        { id: 'v1', name: 'Old', version: '1', enabled: true, savedAt: D(30), filename: 'packs/v1.json',
          clocks: { created: D(30), body: new Date(FIXED_NOW - 25 * DAY).toISOString(), name: D(20), hub: D(20), enabled: D(20) }, updatedAt: D(20) },
      ] } }),
      { bundle: ['i18n/index'] },
    ],
  },
  {
    name: 'notifications: only a merge that wrote reports the unit',
    tree: {
      'sync/favorites/macro/index.json': json({ type: 'macro', entries: [fav('a')] }),
      'sync/favorites/macro/macro_t_a.json': '{"a":1}',
    },
    steps: [
      merge('favorites/macro', { index: { type: 'macro', entries: [fav('a')] }, files: { 'macro_t_a.json': '{"a":1}' } }),
      merge('favorites/macro', { index: { type: 'macro', entries: [fav('a', {}, { deletedAt: D(1), updatedAt: D(1) })] }, files: {} }),
      merge('favorites/macro', { index: { type: 'macro', entries: [fav('a', {}, { deletedAt: D(1), updatedAt: D(1) })] }, files: {} }),
      merge('favorites/macro', { index: { type: 'macro', entries: [fav('a', { created: D(0), body: D(0) }, { updatedAt: D(0), filename: 'new_a.json' })] }, files: { 'new_a.json': '{"a":2}' } }),
      { bundle: ['favorites/macro'] },
    ],
  },
  {
    name: 'packs: the GC after a pass',
    tree: {
      'sync/i18n/index.json': json({ metas: [
        pack('old', {}, { deletedAt: D(40), updatedAt: D(40) }),
        pack('recent', {}, { deletedAt: D(2), updatedAt: D(2) }),
        pack('live'),
        5,
      ], other: 1 }),
      'sync/i18n/packs/old.json': '{}',
      'sync/i18n/packs/recent.json': '{}',
      'sync/i18n/packs/live.json': '{}',
      'sync/i18n/packs/orphan.json': '{}',
      'sync/i18n/packs/undefined.json': '{}',
      'sync/i18n/packs/live.json.123.abc.tmp': '',
      'sync/i18n/packs/readme.txt': 'kept',
      'sync/themes/packs/lost.json': '{}',
    },
    steps: [
      { gc: { attempted: ['i18n/index', 'themes/index'], failed: ['i18n/packs/live'] } },
      { gc: { attempted: ['i18n/packs/live', 'favorites/macro'], failed: [] } },
      { gc: { attempted: ['themes/packs/x'], failed: [] } },
    ],
  },
  {
    name: 'collect and bundle every unit of a full userData',
    tree: {
      'sync/favorites/macro/index.json': json({ type: 'macro', entries: [fav('a'), fav('gone', {}, { filename: 'macro_t_gone.json' }), fav('d', {}, { deletedAt: D(1), updatedAt: D(1) })] }),
      'sync/favorites/macro/macro_t_a.json': '{"a":1}',
      'sync/meta/keyboard-names.json': json({ type: 'keyboard-meta', version: 1, entries: [{ uid: 'kbA', deviceName: 'A', updatedAt: D(1) }] }),
      'sync/key-labels/index.json': json({ entries: [] }),
      'sync/typing-test-texts/index.json': json({ entries: [] }),
      'sync/i18n/index.json': json({ metas: [pack('p1'), { id: 'builtin-english' }, { id: 3 }, pack('p2', {}, { deletedAt: D(1), updatedAt: D(1) })] }),
      'sync/i18n/packs/p1.json': packBody('1.0'),
      'sync/themes/index.json': json({ metas: [pack('t1')] }),
      'sync/themes/packs/t1.json': packBody('1.0'),
      'sync/keyboards/kbA/pipette_settings.json': '{"_updatedAt":"2026-10-01T00:00:00.000Z"}',
      'sync/keyboards/kbA/snapshots/index.json': json({ uid: 'kbA', entries: [snap('s1', {}, { filename: 'legacy.pipette' })] }),
      'sync/keyboards/kbA/snapshots/legacy.pipette': 'SNAP',
      'sync/keyboards/kbA/analyze_filters/index.json': json({ uid: 'kbA', entries: [] }),
      'sync/keyboards/kbA/runs/index.json': json({ uid: 'kbA', entries: [] }),
      [`sync/keyboards/kbA/devices/${OWN_HASH}/2026-10-15.jsonl`]: '{"id":"x"}\n',
      [`sync/keyboards/kbA/devices/${OWN_HASH}/2026-10-14.jsonl`]: '{"id":"y"}\n',
      [`sync/keyboards/kbA/devices/${OWN_HASH}/notaday.jsonl`]: '',
      'sync/keyboards/kbA/devices/otherhash/2026-10-15.jsonl': '{"id":"z"}\n',
      'sync/keyboards/kbA/devices/otherhash/deleted-ranges.json': RANGES,
      'sync/keyboards/kbB/snapshots/notes.txt': '',
      'sync/keyboards/kbB/devices/h2/deleted-ranges.json': '{',
      'sync/keyboards/file-not-dir': '',
      'sync/keyboards/kbC/': null,
    },
    typingUids: ['kbA', 'kbZ'],
    steps: [
      { collect: { uid: 'kbA' } },
      { bundle: [
        'favorites/macro', 'favorites/tapDance', 'meta/keyboard-names', 'key-labels', 'typing-test-texts',
        'i18n/index', 'i18n/packs/p1', 'i18n/packs/p2', 'themes/index', 'themes/packs/t1',
        'keyboards/kbA/settings', 'keyboards/kbA/snapshots', 'keyboards/kbA/analyze_filters', 'keyboards/kbA/runs',
        `keyboards/kbA/devices/${OWN_HASH}/days/2026-10-15`, 'keyboards/kbA/devices/otherhash/days/2026-10-15',
        'keyboards/kbA/devices/otherhash/deleted-ranges', `keyboards/kbA/devices/${OWN_HASH}/deleted-ranges`,
        'keyboards/kbA/devices/otherhash/days/2026-10-16', 'keyboards/kbB/devices/h2/deleted-ranges', 'unknown/unit', 'keyboards/kbA/other',
      ] },
    ],
  },
]

// ---- Recording ----

function errorName(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'MalformedSyncBundleError' || err.name === 'PackMetaPendingError') return err.name
    return err instanceof TypeError || err instanceof SyntaxError ? 'TypeError' : 'Error'
  }
  return 'Error'
}

function resetRecorder(): void {
  rec.uploads.length = 0
  rec.bundleCalls.length = 0
  rec.events.length = 0
  rec.pending.length = 0
  rec.forgotten.length = 0
}

async function runStep(userData: string, step: Step): Promise<Record<string, unknown>> {
  resetRecorder()
  if ('merge' in step) {
    const { unit, plaintext, modifiedTime } = step.merge
    rec.envelope = plaintext
    const file = { id: 'remote', name: `${unit}.enc`, modifiedTime } as DriveFile
    let outcome: Record<string, unknown>
    try {
      await mergeWithRemote(file, unit, 'pw', [])
      const needsUpload = rec.bundleCalls.length > 0
      outcome = { needsUpload, uploaded: rec.uploads[0] ?? null }
    } catch (err) {
      outcome = { error: errorName(err) }
    }
    return { ...outcome, events: [...rec.events], pending: [...rec.pending], forgotten: [...rec.forgotten].sort(), tree: readTree(userData) }
  }
  if ('gc' in step) {
    await runPackGcAfterPass(step.gc.attempted, step.gc.failed)
    return { events: [...rec.events], pending: [...rec.pending], tree: readTree(userData) }
  }
  if ('bundle' in step) {
    const bundles: Array<{ unit: string; plaintext: string | null } | { unit: string; error: string }> = []
    for (const unit of step.bundle) {
      try {
        const b = await bundleSyncUnit(unit)
        bundles.push({ unit, plaintext: b ? JSON.stringify(b) : null })
      } catch (err) {
        bundles.push({ unit, error: errorName(err) })
      }
    }
    return { bundles, tree: readTree(userData) }
  }
  return {
    all: await collectAllSyncUnits(),
    forUid: await collectAnalyticsSyncUnitsForUid(step.collect.uid),
    tree: readTree(userData),
  }
}

async function record(scenario: Scenario) {
  const userData = seedUserData(scenario.tree)
  for (const [path, ms] of Object.entries(scenario.mtimes ?? {})) utimesSync(resolve(userData, path), ms / 1000, ms / 1000)
  rec.typingUids = scenario.typingUids ?? []
  syncRuntime.syncedPackRosters.clear()
  syncRuntime.lastKnownRemoteState.clear()
  syncRuntime.createdFileIds.clear()
  const results = []
  for (const step of scenario.steps) results.push({ step, result: await runStep(userData, step) })
  return { name: scenario.name, tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree }, mtimes: scenario.mtimes ?? {}, typingUids: rec.typingUids, ownHash: OWN_HASH, now: FIXED_NOW, steps: results }
}

describe('sync merge fixtures', () => {
  beforeEach(() => resetRecorder())

  it('records every scenario', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await record(scenario))
    expect(scenarios.length).toBe(SCENARIOS.length)
    writeJsonFixture(OUT, scenarios)
  })
})
