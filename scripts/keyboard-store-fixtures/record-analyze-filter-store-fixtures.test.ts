// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the Analyze filter store of
// src-tauri/crates/pipette-keyboard-stores: runs the real
// ANALYZE_FILTER_STORE_* handlers of src/main/analyze-filter-store.ts on a
// userData directory built in a temp directory, at fixed times and with a
// fixed sequence of new ids. It records each step's response, the sync
// units reported to notifyChange, and every file and directory left behind
// (path → content), so the crate can replay each scenario and compare the
// bytes.
//
// A file-system error's text is the OS's and Node's, which the crate does
// not copy: such an error is recorded as `<os error>`.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { type Tree, buildTree, outcomeText, recordTree } from './fixture-tree'

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

import { setupAnalyzeFilterStore } from '../../src/main/analyze-filter-store'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_analyze_filter_store_scenarios.json')

type Step =
  | { op: 'list'; uid: string }
  | { op: 'save'; uid: string; json: string; label: string; summary?: string }
  | { op: 'load'; uid: string; id: string }
  | { op: 'update'; uid: string; id: string; json: string }
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
const DIR = `sync/keyboards/${UID}/analyze_filters`
const index = (entries: unknown[], uid = UID): string => JSON.stringify({ uid, entries }, null, 2)

const list = (uid = UID): Step => ({ op: 'list', uid })
const save = (label = 'L', json = '{"version":1}', summary?: string, uid = UID): Step =>
  ({ op: 'save', uid, json, label, ...(summary !== undefined ? { summary } : {}) })
const load = (id: string, uid = UID): Step => ({ op: 'load', uid, id })
const rename = (id: string, label: string, uid = UID): Step => ({ op: 'rename', uid, id, label })
const del = (id: string, uid = UID): Step => ({ op: 'delete', uid, id })
const update = (id: string, json: string, uid = UID): Step => ({ op: 'update', uid, id, json })

const v1 = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Label ${id}`, filename, savedAt: t(-60 * MIN), ...extra,
})

const SCENARIOS: Scenario[] = [
  {
    name: 'save, list, load, rename, hub links and delete',
    time: T0,
    tree: {},
    steps: [
      save('First', '{"version":1,"tab":"wpm"}', 'WPM · 7 days'),
      save('', 'second body\n', ''),
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
      { op: 'hubPrivate', uid: UID, id: 'missing', link: null },
      update('missing', '{}'),
    ],
  },
  {
    name: 'a v1 index with future clocks and unknown fields',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: '{\n  "before": [1, 2.50, 1e21],\n  "uid": "0xA1B2",\n  "entries": [\n'
        + [
          JSON.stringify(v1('v1', '2026-10-16T11-00-00.000Z_v1.json', { summary: 'old', updatedAt: t(-30 * MIN), extra: { keep: true } })),
          JSON.stringify({
            note: 'first', id: 'future', label: 'Future', filename: '2030-01-01T00-00-00.000Z_future.json',
            savedAt: '2030-01-01T00:00:00.000Z',
            clocks: { created: '2030-01-01T00:00:00.000Z', body: '2030-01-01T00:00:00.000Z', name: '2030-01-02T00:00:00.000Z', hub: 'nonsense', enabled: '2030-01-01T00:00:00.000Z' },
            updatedAt: '2031-01-01T00:00:00.000Z',
          }),
          JSON.stringify(v1('gone', '2026-10-16T10-00-00.000Z_gone.json', { deletedAt: t(-10 * MIN), hubPostId: 'h' })),
          '"a string entry"', 'null', '42', '{"label":"no id"}', '{"id":7,"label":"numeric id"}',
        ].map((line) => `    ${line}`).join(',\n')
        + '\n  ],\n  "after": "kept"\n}\n',
      [`${DIR}/2026-10-16T11-00-00.000Z_v1.json`]: 'v1 body',
      [`${DIR}/2030-01-01T00-00-00.000Z_future.json`]: 'future body',
      [`${DIR}/2026-10-16T10-00-00.000Z_gone.json`]: 'gone body',
    },
    steps: [
      list(),
      load('future'),
      load('gone'),
      rename('v1', 'Renamed v1'),
      update('future', 'future body 2'),
      rename('future', 'Renamed future'),
      del('future'),
      update('gone', 'revived'),
      list(),
    ],
  },
  {
    name: 'legacy names without the id move on a write',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        v1('a', '2026-01-01T00-00-00.000Z.json'),
        v1('b', '2026-01-01T00-00-00.000Z.json'),
        v1('c', '2026-01-02T00-00-00.000Z.json', { deletedAt: t(-MIN) }),
        v1('d', '../outside.json'),
        v1('e', '2026-01-03T00-00-00.000Z_e.json'),
      ]),
      [`${DIR}/2026-01-01T00-00-00.000Z.json`]: 'shared legacy body',
      [`${DIR}/2026-01-03T00-00-00.000Z_e.json`]: 'kept body',
    },
    steps: [list(), load('a'), load('d'), save('New'), list(), load('a'), load('b'), load('c')],
  },
  {
    name: 'an index that is not JSON is replaced by the next save',
    time: T0,
    tree: { [`${DIR}/index.json`]: 'not json!!!' },
    steps: [list(), load('x'), save(), list()],
  },
  {
    name: 'an index of another uid is replaced by the next save',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([v1('other', '2026-01-01T00-00-00.000Z_other.json')], '0xFFFF'),
      [`${DIR}/2026-01-01T00-00-00.000Z_other.json`]: 'other body',
    },
    steps: [list(), load('other'), rename('other', 'x'), save()],
  },
  { name: 'an index that is an array', time: T0, tree: { [`${DIR}/index.json`]: '[{"uid":"0xA1B2","entries":[]}]' }, steps: [list(), save()] },
  { name: 'an index that is null', time: T0, tree: { [`${DIR}/index.json`]: 'null' }, steps: [list(), save()] },
  { name: 'an index without an entries list', time: T0, tree: { [`${DIR}/index.json`]: '{"uid":"0xA1B2","entries":{"0":{"id":"x"}}}' }, steps: [list(), save()] },
  { name: 'an index with a byte order mark', time: T0, tree: { [`${DIR}/index.json`]: '﻿{"uid":"0xA1B2","entries":[]}' }, steps: [list(), save()] },
  {
    name: 'invalid UTF-8 in the index',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: { hex: Buffer.concat([Buffer.from('{"uid":"0xA1B2","entries":[{"id":"x","label":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","filename":"x_x.json","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [`${DIR}/x_x.json`]: { hex: Buffer.concat([Buffer.from('body '), Buffer.from([0xc3])]).toString('hex') },
    },
    steps: [list(), load('x'), rename('x', 'Good')],
  },
  {
    name: 'the 50-entry cap counts live entries only',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        ...Array.from({ length: 50 }, (_, i) => v1(`live-${i}`, `2026-01-01T00-00-00.000Z_live-${i}.json`)),
        v1('dead-0', '2026-01-01T00-00-00.000Z_dead-0.json', { deletedAt: t(-MIN) }),
        v1('dead-1', '2026-01-01T00-00-00.000Z_dead-1.json', { deletedAt: t(-MIN) }),
      ]),
      [`${DIR}/2026-01-01T00-00-00.000Z_dead-0.json`]: 'dead body',
    },
    steps: [
      save('Over the cap'),
      load('dead-0'),
      del('live-3'),
      at(MIN),
      save('Fits', '{}', 'summary'),
      save('Over again'),
      update('dead-0', 'revived over the cap'),
      list(),
    ],
  },
  {
    name: 'updates: user saves and revivals',
    time: T0,
    tree: {},
    steps: [
      save('L', '{"v":1}', 'S'),
      at(MIN),
      update(uuid(1), '{"v":2}'),
      at(2 * MIN),
      update(uuid(1), '{"v":2}'),
      at(3 * MIN),
      del(uuid(1)),
      load(uuid(1)),
      at(4 * MIN),
      update(uuid(1), '{"v":3}'),
      load(uuid(1)),
      list(),
    ],
  },
  {
    name: 'a body that is gone',
    time: T0,
    tree: { [`${DIR}/index.json`]: index([v1('a', '2026-01-01T00-00-00.000Z_a.json')]) },
    steps: [load('a'), update('a', 'written again'), load('a')],
  },
  {
    name: 'uids that are not one path segment',
    time: T0,
    tree: {},
    steps: ['', '.', '..', 'a/b', 'a\\b', '../x'].flatMap((uid) => [
      list(uid),
      save('L', '{}', undefined, uid),
      load('x', uid),
      update('x', '{}', uid),
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
        { id: 'up', filename: '../escape.json' },
        { id: 'none' },
        { id: 'null', filename: null },
        { id: 'empty', filename: '' },
        { id: 'dot', filename: '..' },
      ]),
    },
    steps: ['up', 'none', 'null', 'empty', 'dot'].flatMap((id) => [load(id), update(id, '{}')]),
  },
]

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

async function run(step: Exclude<Step, { op: 'at' }>): Promise<unknown> {
  const ev = {}
  switch (step.op) {
    case 'list': return handler(IpcChannels.ANALYZE_FILTER_STORE_LIST)(ev, step.uid)
    case 'save': return handler(IpcChannels.ANALYZE_FILTER_STORE_SAVE)(ev, step.uid, step.json, step.label, step.summary)
    case 'load': return handler(IpcChannels.ANALYZE_FILTER_STORE_LOAD)(ev, step.uid, step.id)
    case 'update': return handler(IpcChannels.ANALYZE_FILTER_STORE_UPDATE)(ev, step.uid, step.id, step.json)
    case 'rename': return handler(IpcChannels.ANALYZE_FILTER_STORE_RENAME)(ev, step.uid, step.id, step.label)
    case 'delete': return handler(IpcChannels.ANALYZE_FILTER_STORE_DELETE)(ev, step.uid, step.id)
    case 'hubPostId': return handler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID)(ev, step.uid, step.id, step.hubPostId)
    case 'hubPrivate': return handler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_PRIVATE)(ev, step.uid, step.id, step.link)
  }
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
  buildTree(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: (string | null)[] = []
    for (const step of scenario.steps) {
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push(null)
      } else {
        outcomes.push(outcomeText(await run(step)))
      }
    }
    return { outcomes, notified: [...notified], after: recordTree(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('analyze filter store fixtures', () => {
  it('records each scenario’s responses, notified units and files', async () => {
    setupAnalyzeFilterStore()
    root = mkdtempSync(join(tmpdir(), 'analyze-filter-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const capped = results.find((r) => r.name.startsWith('the 50-entry cap'))
    expect(capped?.outcomes[0]).toBe('{"success":false,"error":"max entries reached"}')
  })
})
