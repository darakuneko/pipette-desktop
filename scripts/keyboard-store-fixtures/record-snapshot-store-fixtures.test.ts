// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the snapshot store of
// src-tauri/crates/pipette-keyboard-stores: runs the real SNAPSHOT_STORE_*
// handlers of src/main/snapshot-store.ts on a userData directory built in a
// temp directory, at fixed times and with a fixed sequence of new ids. It
// records each step's response, the sync units reported to notifyChange,
// and every file and directory left behind (path → content), so the crate
// can replay each scenario and compare the bytes.
//
// A file-system error's text is the OS's and Node's, which the crate does
// not copy: such an error is recorded as `<os error>`.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const { handlers, notified, paths, ids } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  ids: { next: 1 },
}))

vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => notified.push(unit) }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  /** The ids the crate's tests hand out: `00000000-0000-4000-8000-{n:012}`. */
  const randomUUID = (): string => `00000000-0000-4000-8000-${String(ids.next++).padStart(12, '0')}`
  return { ...actual, default: { ...actual, randomUUID }, randomUUID }
})

import { setupSnapshotStore } from '../../src/main/snapshot-store'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_snapshot_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

type Step =
  | { op: 'list'; uid: string }
  | { op: 'save'; uid: string; json: string; deviceName: string; label: string; vilVersion?: number }
  | { op: 'load'; uid: string; id: string }
  | { op: 'update'; uid: string; id: string; json: string; vilVersion?: number; migrateFrom?: string }
  | { op: 'rename'; uid: string; id: string; label: string }
  | { op: 'delete'; uid: string; id: string }
  | { op: 'hubPostId'; uid: string; id: string; hubPostId: string | null }
  | { op: 'hubPrivate'; uid: string; id: string; link: unknown }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

interface Scenario {
  name: string
  time: string
  tree: Tree
  steps: Step[]
}

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const UID = '0xA1B2'
const DIR = `sync/keyboards/${UID}/snapshots`
const index = (entries: unknown[], uid = UID): string => JSON.stringify({ uid, entries }, null, 2)

const list = (uid = UID): Step => ({ op: 'list', uid })
const save = (deviceName: string, label = 'L', json = '{"v":1}', vilVersion?: number, uid = UID): Step =>
  ({ op: 'save', uid, json, deviceName, label, ...(vilVersion !== undefined ? { vilVersion } : {}) })
const load = (id: string, uid = UID): Step => ({ op: 'load', uid, id })
const rename = (id: string, label: string, uid = UID): Step => ({ op: 'rename', uid, id, label })
const del = (id: string, uid = UID): Step => ({ op: 'delete', uid, id })
const update = (id: string, json: string, extra: { vilVersion?: number; migrateFrom?: string } = {}, uid = UID): Step =>
  ({ op: 'update', uid, id, json, ...extra })

const v1 = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Label ${id}`, filename, savedAt: t(-60 * MIN), ...extra,
})

const SCENARIOS: Scenario[] = [
  {
    name: 'save, list, load, rename, hub links and delete',
    time: T0,
    tree: {},
    steps: [
      save('GPK60-63R', 'First', '{"a":1}', 2),
      save('GPK60-63R', '', 'second body\n'),
      at(MIN),
      list(),
      load(uuid(1)),
      rename(uuid(1), 'Renamed 名前 😀'),
      { op: 'hubPostId', uid: UID, id: uuid(2), hubPostId: ' post-1 ' },
      { op: 'hubPrivate', uid: UID, id: uuid(2), link: { id: 'p1', url: '/files/p1?token=t', expiresAt: null } },
      { op: 'hubPostId', uid: UID, id: uuid(2), hubPostId: '　' },
      { op: 'hubPostId', uid: UID, id: uuid(1), hubPostId: 'post-2' },
      { op: 'hubPostId', uid: UID, id: uuid(1), hubPostId: null },
      { op: 'hubPrivate', uid: UID, id: uuid(1), link: null },
      at(2 * MIN),
      del(uuid(2)),
      at(3 * MIN),
      del(uuid(2)),
      list(),
      load(uuid(2)),
      load('missing'),
      rename('missing', 'x'),
      del('missing'),
      { op: 'hubPostId', uid: UID, id: 'missing', hubPostId: 'p' },
      update('missing', '{}'),
    ],
  },
  {
    name: 'a v1 index with future clocks and unknown fields',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: '{\n  "before": [1, 2.50, 1e21],\n  "uid": "0xA1B2",\n  "entries": [\n'
        + [
          JSON.stringify(v1('v1', 'KB_2026-10-16T11-00-00.000Z_v1.pipette', { updatedAt: t(-30 * MIN), extra: { keep: true } })),
          JSON.stringify({
            note: 'first', id: 'future', label: 'Future', filename: 'KB_2030-01-01T00-00-00.000Z_future.pipette',
            savedAt: '2030-01-01T00:00:00.000Z', vilVersion: 1,
            clocks: { created: '2030-01-01T00:00:00.000Z', body: '2030-01-01T00:00:00.000Z', name: '2030-01-02T00:00:00.000Z', hub: 'nonsense', enabled: '2030-01-01T00:00:00.000Z' },
            updatedAt: '2031-01-01T00:00:00.000Z',
          }),
          JSON.stringify(v1('gone', 'KB_2026-10-16T10-00-00.000Z_gone.pipette', { deletedAt: t(-10 * MIN) })),
          '"a string entry"', 'null', '42', '{"label":"no id"}', '{"id":7,"label":"numeric id"}',
        ].map((line) => `    ${line}`).join(',\n')
        + '\n  ],\n  "after": "kept"\n}\n',
      [`${DIR}/KB_2026-10-16T11-00-00.000Z_v1.pipette`]: 'v1 body',
      [`${DIR}/KB_2030-01-01T00-00-00.000Z_future.pipette`]: 'future body',
      [`${DIR}/KB_2026-10-16T10-00-00.000Z_gone.pipette`]: 'gone body',
    },
    steps: [
      list(),
      load('future'),
      load('gone'),
      rename('v1', 'Renamed v1'),
      update('future', 'future body 2', { vilVersion: 2 }),
      rename('future', 'Renamed future'),
      del('future'),
      update('gone', 'revived', { vilVersion: 2 }),
      list(),
    ],
  },
  {
    name: 'legacy names without the id move on a write',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        v1('a', 'Board_2026-01-01T00-00-00.000Z.pipette'),
        v1('b', 'Board_2026-01-01T00-00-00.000Z.pipette'),
        v1('c', 'Gone_2026-01-02T00-00-00.000Z.pipette', { deletedAt: t(-MIN) }),
        v1('d', '../outside.pipette'),
        v1('e', 'Kept_2026-01-03T00-00-00.000Z_e.pipette'),
      ]),
      [`${DIR}/Board_2026-01-01T00-00-00.000Z.pipette`]: 'shared legacy body',
      [`${DIR}/Kept_2026-01-03T00-00-00.000Z_e.pipette`]: 'kept body',
    },
    steps: [list(), load('a'), load('d'), save('Board', 'New'), list(), load('a'), load('b'), load('c')],
  },
  {
    name: 'an index that is not JSON is replaced by the next save',
    time: T0,
    tree: { [`${DIR}/index.json`]: 'not json!!!' },
    steps: [list(), load('x'), save('KB'), list()],
  },
  {
    name: 'an index of another uid is replaced by the next save',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([v1('other', 'Other_2026-01-01T00-00-00.000Z_other.pipette')], '0xFFFF'),
      [`${DIR}/Other_2026-01-01T00-00-00.000Z_other.pipette`]: 'other body',
    },
    steps: [list(), load('other'), rename('other', 'x'), save('KB')],
  },
  { name: 'an index that is an array', time: T0, tree: { [`${DIR}/index.json`]: '[{"uid":"0xA1B2","entries":[]}]' }, steps: [list(), save('KB')] },
  { name: 'an index that is null', time: T0, tree: { [`${DIR}/index.json`]: 'null' }, steps: [list(), save('KB')] },
  { name: 'an index without an entries list', time: T0, tree: { [`${DIR}/index.json`]: '{"uid":"0xA1B2","entries":{"0":{"id":"x"}}}' }, steps: [list(), save('KB')] },
  { name: 'an index with a byte order mark', time: T0, tree: { [`${DIR}/index.json`]: '﻿{"uid":"0xA1B2","entries":[]}' }, steps: [list(), save('KB')] },
  {
    name: 'invalid UTF-8 in the index',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: { hex: Buffer.concat([Buffer.from('{"uid":"0xA1B2","entries":[{"id":"x","label":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","filename":"x_x.pipette","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [`${DIR}/x_x.pipette`]: { hex: Buffer.concat([Buffer.from('body '), Buffer.from([0xc3])]).toString('hex') },
    },
    steps: [list(), load('x'), rename('x', 'Good')],
  },
  {
    name: 'the 30-entry cap counts live entries only',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        ...Array.from({ length: 30 }, (_, i) => v1(`live-${i}`, `KB_2026-01-01T00-00-00.000Z_live-${i}.pipette`)),
        v1('dead-0', 'KB_2026-01-01T00-00-00.000Z_dead-0.pipette', { deletedAt: t(-MIN) }),
        v1('dead-1', 'KB_2026-01-01T00-00-00.000Z_dead-1.pipette', { deletedAt: t(-MIN) }),
      ]),
      [`${DIR}/KB_2026-01-01T00-00-00.000Z_dead-0.pipette`]: 'dead body',
    },
    steps: [
      save('KB', 'Over the cap'),
      load('dead-0'),
      del('live-3'),
      at(MIN),
      save('KB', 'Fits'),
      save('KB', 'Over again'),
      update('dead-0', 'revived over the cap'),
      list(),
    ],
  },
  {
    name: 'updates: migrations, user saves and revivals',
    time: T0,
    tree: {},
    steps: [
      save('KB', 'L', '{"v":1}', 1),
      at(MIN),
      update(uuid(1), '{"v":2}', { vilVersion: 2, migrateFrom: '{"v":0}' }),
      update(uuid(1), '{"v":2}', { vilVersion: 2, migrateFrom: '{"v":1}' }),
      update(uuid(1), '{"v":3}', { migrateFrom: '{"v":2}' }),
      at(2 * MIN),
      update(uuid(1), '{"v":4}'),
      at(3 * MIN),
      del(uuid(1)),
      update(uuid(1), '{"v":5}', { migrateFrom: '{"v":4}' }),
      at(4 * MIN),
      update(uuid(1), '{"v":6}', { vilVersion: 2 }),
      load(uuid(1)),
      list(),
    ],
  },
  {
    name: 'a body that is gone',
    time: T0,
    tree: { [`${DIR}/index.json`]: index([v1('a', 'KB_2026-01-01T00-00-00.000Z_a.pipette'), v1('b', 'KB_2026-01-01T00-00-00.000Z_b.pipette')]) },
    steps: [load('a'), update('a', 'written again'), load('a'), update('b', 'x', { migrateFrom: 'y' })],
  },
  {
    name: 'device names: long, control characters, reserved characters, emoji',
    time: T0,
    tree: {},
    steps: [
      save('K'.repeat(60) + 'é'.repeat(40) + '🎹'.repeat(10)),
      save('鍵'.repeat(41)),
      save('x'.repeat(117) + '_. y' + 'z'.repeat(10)),
      save('😀'.repeat(31)),
      save('_'.repeat(121)),
      save('Ctrl\u0001\nName\t\u007f'),
      save('a/b\\c:d*e?f"g<h>i|j'),
      save('name...'),
      save('name. '),
      save('  ...'),
      save('﻿Wide　'),
      save('日本語キーボード 😀'),
      list(),
    ],
  },
  {
    name: 'uids that are not one path segment',
    time: T0,
    tree: {},
    steps: ['', '.', '..', 'a/b', 'a\\b', '../x'].flatMap((uid) => [
      list(uid),
      save('KB', 'L', '{}', undefined, uid),
      load('x', uid),
      update('x', '{}', {}, uid),
      rename('x', 'y', uid),
      del('x', uid),
      { op: 'hubPostId', uid, id: 'x', hubPostId: 'p' } as Step,
      { op: 'hubPrivate', uid, id: 'x', link: null } as Step,
    ]),
  },
  {
    name: 'body filenames that are not safe',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        { id: 'up', filename: '../escape.pipette' },
        { id: 'none' },
        { id: 'null', filename: null },
        { id: 'empty', filename: '' },
        { id: 'dot', filename: '..' },
      ]),
    },
    steps: ['up', 'none', 'null', 'empty', 'dot'].flatMap((id) => [load(id), update(id, '{}')]),
  },
  {
    name: 'a save records the device name over a tombstone in the keyboard names',
    time: T0,
    tree: {
      'sync/meta/keyboard-names.json': JSON.stringify({
        type: 'keyboard-meta', version: 1,
        entries: [{ uid: UID, deviceName: 'Old', updatedAt: t(-MIN), deletedAt: t(-MIN) }],
      }, null, 2),
    },
    steps: [save('  New Name '), save('New Name'), save('Other Name')],
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

async function run(step: Exclude<Step, { op: 'at' }>): Promise<unknown> {
  const ev = {}
  switch (step.op) {
    case 'list': return handler(IpcChannels.SNAPSHOT_STORE_LIST)(ev, step.uid)
    case 'save': return handler(IpcChannels.SNAPSHOT_STORE_SAVE)(ev, step.uid, step.json, step.deviceName, step.label, step.vilVersion)
    case 'load': return handler(IpcChannels.SNAPSHOT_STORE_LOAD)(ev, step.uid, step.id)
    case 'update': {
      const options = step.migrateFrom !== undefined ? { migrateFrom: step.migrateFrom } : undefined
      return handler(IpcChannels.SNAPSHOT_STORE_UPDATE)(ev, step.uid, step.id, step.json, step.vilVersion, options)
    }
    case 'rename': return handler(IpcChannels.SNAPSHOT_STORE_RENAME)(ev, step.uid, step.id, step.label)
    case 'delete': return handler(IpcChannels.SNAPSHOT_STORE_DELETE)(ev, step.uid, step.id)
    case 'hubPostId': return handler(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID)(ev, step.uid, step.id, step.hubPostId)
    case 'hubPrivate': return handler(IpcChannels.SNAPSHOT_STORE_SET_HUB_PRIVATE)(ev, step.uid, step.id, step.link)
  }
}

/** The response as JSON text, with a file-system error's text replaced. */
function outcome(response: unknown): string | null {
  const r = response as { error?: unknown }
  if (typeof r?.error === 'string' && /^Error: E[A-Z]+:/.test(r.error)) {
    return JSON.stringify({ ...r, error: '<os error>' })
  }
  return JSON.stringify(response) ?? null
}

interface Played {
  outcomes: (string | null)[]
  notified: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string): Promise<Played> {
  paths.userData = dir
  notified.length = 0
  ids.next = 1
  build(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: (string | null)[] = []
    for (const step of scenario.steps) {
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push(null)
      } else {
        outcomes.push(outcome(await run(step)))
      }
    }
    return { outcomes, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('snapshot store fixtures', () => {
  it('records each scenario’s responses, notified units and files', async () => {
    setupSnapshotStore()
    root = mkdtempSync(join(tmpdir(), 'snapshot-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const capped = results.find((r) => r.name.startsWith('the 30-entry cap'))
    expect(capped?.outcomes[0]).toBe('{"success":false,"error":"max entries reached"}')
  })
})
