// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the language pack store of
// src-tauri/crates/pipette-pack-stores: runs the real I18N_PACK_* handlers
// of src/main/i18n-pack-ipc.ts through the scenarios below and records
// what they answer, report and leave behind (pack-fixture-harness.ts).

import { describe, expect, it, vi } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { resolve } from 'node:path'
import { type CommonStep, type Raw, type Scenario, handler, playAll, rawValue, uuid } from './pack-fixture-harness'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  ids: { next: 1 },
  dialogs: { answer: null as string[] | null, defaultPath: undefined as string | undefined },
}))

vi.mock('electron', async () => (await import('./pack-fixture-harness')).electronMock(state))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => state.notified.push(unit) }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  // uuid() of pack-fixture-harness.ts, which imports this module.
  const randomUUID = (): string => `00000000-0000-4000-8000-${String(state.ids.next++).padStart(12, '0')}`
  return { ...actual, default: { ...actual, randomUUID }, randomUUID }
})

import { setupI18nPackStore } from '../../src/main/i18n-pack-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-pack-stores/tests/fixtures/ts_i18n_pack_store_scenarios.json')

type Step =
  | CommonStep
  | { op: 'list' }
  | { op: 'get'; id: unknown }
  | { op: 'hasName'; name: unknown; excludeId?: unknown }
  | { op: 'rename'; id: unknown; name: unknown }
  | { op: 'setEnabled'; id: unknown; enabled: unknown }
  | { op: 'refreshCoverage'; id: unknown; values: unknown }
  | { op: 'reorder'; ids: unknown }
  | { op: 'delete'; id: unknown }
  | { op: 'hubPostId'; id: unknown; hubPostId: unknown; uploaderName?: unknown; hubUpdatedAt?: unknown }
  | { op: 'importApply'; raw: Raw; options?: unknown }

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const DAY = 24 * 60 * MIN
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })

const INDEX = 'sync/i18n/index.json'
const body = (id: string): string => `sync/i18n/packs/${id}.json`
const pretty = (value: unknown): string => JSON.stringify(value, null, 2)
const pack = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name, version: '1.0.0', common: { save: `Save (${name})` }, ...extra })

const list: Step = { op: 'list' }
const get = (id: unknown): Step => ({ op: 'get', id })
const apply = (value: unknown, options?: unknown): Step => ({ op: 'importApply', raw: { value }, options })
const applyFile = (fromFile: string, options?: unknown): Step => ({ op: 'importApply', raw: { fromFile }, options })
const rename = (id: unknown, name: unknown): Step => ({ op: 'rename', id, name })
const setEnabled = (id: unknown, enabled: unknown): Step => ({ op: 'setEnabled', id, enabled })
const del = (id: unknown): Step => ({ op: 'delete', id })
const exportTo = (id: unknown, dialog: string | null): Step => ({ op: 'export', id, dialog })

const FULL = {
  enabled: true,
  appVersionAtImport: '1.2.3',
  matchedBaseVersion: '0.9.0',
  coverage: { totalKeys: 10, coveredKeys: 10 },
  dangerousKeyCount: 0,
}
const PARTIAL = { ...FULL, matchedBaseVersion: null, coverage: { totalKeys: 10, coveredKeys: 7 } }

/** A v1 meta (no clocks). */
const v1 = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, filename: `packs/${id}.json`, name, version: '0.1.0', enabled: true,
  savedAt: t(-2 * DAY), updatedAt: t(-DAY), ...extra,
})

const SAMPLES = ['Japanese', 'Japanese_-_ギャル', 'Japanese_-_京言葉', 'Japanese_-_紳士']
const sample = (name: string): string => `sample-packs/i18n/i18n-packs-${name}.json`

const SCENARIOS: Scenario<Step>[] = [
  {
    name: 'English on the first list, then saves, renames, enabling, coverage, Hub links and deletes',
    time: T0,
    tree: {},
    steps: [
      list,
      list,
      get('builtin-english'),
      apply(pack('Alpha'), FULL),
      apply(pack('Beta', { version: ' 2.0.0 ', name: '  Beta  ' }), PARTIAL),
      at(MIN),
      { op: 'hasName', name: ' alpha ' },
      { op: 'hasName', name: 'Alpha', excludeId: uuid(1) },
      { op: 'hasName', name: 'english', excludeId: 7 },
      { op: 'hasName', name: 5 },
      rename(uuid(1), '  Renamed  '),
      rename(uuid(1), 'ENGLISH'),
      rename(uuid(1), 'x'.repeat(65)),
      rename(uuid(1), '😀'.repeat(32)),
      rename(uuid(1), '😀'.repeat(32) + 'x'),
      rename(uuid(1), ' 　 '),
      rename(uuid(1), 7),
      rename(5, 'x'),
      rename('missing', 'x'),
      rename('builtin-english', 'Englisch'),
      setEnabled(uuid(1), false),
      at(2 * MIN),
      setEnabled(uuid(1), false),
      setEnabled(uuid(1), 'yes'),
      setEnabled('missing', true),
      { op: 'refreshCoverage', id: uuid(2), values: { matchedBaseVersion: '0.9.1', coverage: { totalKeys: 12, coveredKeys: 12 }, measuredBodyClock: t(0) } },
      { op: 'refreshCoverage', id: uuid(2), values: { matchedBaseVersion: '0.9.1', coverage: { totalKeys: 12, coveredKeys: 12 }, measuredBodyClock: t(1) } },
      { op: 'refreshCoverage', id: uuid(2), values: { matchedBaseVersion: '0.9.1', coverage: { totalKeys: 12 }, measuredBodyClock: t(0) } },
      { op: 'refreshCoverage', id: uuid(2), values: null },
      { op: 'refreshCoverage', id: 'missing', values: { matchedBaseVersion: 'x', coverage: { totalKeys: 1, coveredKeys: 1 }, measuredBodyClock: t(0) } },
      { op: 'hubPostId', id: uuid(1), hubPostId: ' post-1 ', uploaderName: ' alice ', hubUpdatedAt: ' 2026-05-01T00:00:00.000Z ' },
      { op: 'hubPostId', id: uuid(1), hubPostId: 'post-1', hubUpdatedAt: ' ' },
      { op: 'hubPostId', id: uuid(1), hubPostId: 'post-2', uploaderName: '', hubUpdatedAt: '2026-06-01T00:00:00.000Z' },
      { op: 'hubPostId', id: uuid(1), hubPostId: null, uploaderName: 'bob' },
      { op: 'hubPostId', id: uuid(2), hubPostId: 5, uploaderName: 5, hubUpdatedAt: 5 },
      { op: 'hubPostId', id: 'missing', hubPostId: 'p' },
      at(3 * MIN),
      del('builtin-english'),
      del(uuid(2)),
      at(4 * MIN),
      del(uuid(2)),
      del('missing'),
      del(5),
      { op: 'hubPostId', id: uuid(2), hubPostId: 'post-3' },
      get(uuid(2)),
      get(uuid(1)),
      get('../x'),
      get(5),
      list,
    ],
  },
  {
    name: 'saves over packs: same name, kept names, revived tombstones, explicit ids and three-state fields',
    time: T0,
    tree: {},
    steps: [
      apply(pack('Gamma'), { ...FULL, hubPostId: '', uploaderName: 'carol', hubUpdatedAt: '2026-01-01T00:00:00.000Z', id: 5 }),
      at(MIN),
      apply(pack('gamma ', { version: '1.1.0' }), { enabled: false, matchedBaseVersion: null, coverage: null, dangerousKeyCount: null, uploaderName: ' ', hubUpdatedAt: '' }),
      rename(uuid(1), 'Gamma Renamed'),
      at(2 * MIN),
      apply(pack('Gamma', { version: '1.2.0' }), { id: uuid(1), coverage: { totalKeys: 3, coveredKeys: 'x' }, dangerousKeyCount: 'x', matchedBaseVersion: 7 }),
      apply(pack('Gamma Renamed'), {}),
      apply(pack('Delta'), {}),
      del(uuid(2)),
      at(3 * MIN),
      apply(pack('Delta', { version: '3.0.0' }), { enabled: false }),
      apply(pack('Epsilon'), { id: uuid(2) }),
      at(4 * MIN),
      apply(pack('Delta'), { id: uuid(2) }),
      apply(pack('Hacked'), { id: 'builtin-english' }),
      list,
      apply(pack('ENGLISH'), {}),
      apply(pack('Zeta'), { id: '../bad' }),
      apply(pack('Zeta'), { id: 'custom_id-1', hubPostId: 'post-z' }),
      apply(pack('zeta', { version: '1.1.0' }), { id: '' }),
      apply(pack('Omega'), { id: '' }),
      apply({ name: 'No version' }, {}),
      apply({ name: ' ', version: '1' }, {}),
      apply([{ name: 'Array', version: '1' }], {}),
      apply('just text', {}),
      { op: 'importApply', raw: { absent: true }, options: {} },
      apply(pack('Eta'), 'not an object'),
      apply(pack('Theta'), [1, 2]),
      { op: 'importApply', raw: { value: pack('Iota') } },
      apply(JSON.parse('{"name":"Kappa","version":"1","__proto__":"kept","2":"index key","nested":[1,2.5,1e21]}'), FULL),
      get('custom_id-1'),
      list,
    ],
  },
  {
    name: 'reorder: listed ids first, tombstones and unlisted ids after, other index fields dropped',
    time: T0,
    tree: {
      [INDEX]: pretty({ note: 'top', metas: [], after: [1] }),
    },
    steps: [
      list,
      apply(pack('A'), {}),
      apply(pack('B'), {}),
      apply(pack('C'), {}),
      del(uuid(2)),
      at(MIN),
      { op: 'reorder', ids: [uuid(3), 'missing', uuid(2), uuid(3), 'builtin-english'] },
      list,
      { op: 'reorder', ids: [uuid(1)] },
      { op: 'reorder', ids: [] },
      { op: 'reorder', ids: 'nope' },
      { op: 'reorder', ids: ['a', 5] },
      list,
    ],
  },
  {
    name: 'reorder with duplicate ids keeps the last meta of a listed id',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [
        { ...v1('dup', 'First'), clocks: { created: t(-DAY), body: t(-DAY) } },
        v1('other', 'Other'),
        { ...v1('dup', 'Second'), clocks: { created: t(-DAY), body: t(-DAY) } },
      ] }),
    },
    steps: [{ op: 'reorder', ids: ['dup'] }, list, { op: 'reorder', ids: ['other'] }, list],
  },
  {
    name: 'a v1 index: body clocks from the body files, other fields kept',
    time: T0,
    tree: {
      [INDEX]: '{\n  "first": true,\n  "metas": [\n' + [
        JSON.stringify(v1('v1-a', 'Vee One', { coverage: { totalKeys: 2, coveredKeys: 1 }, extra: 'kept' })),
        JSON.stringify(v1('v1-no-body', 'No Body')),
        JSON.stringify(v1('builtin-english', 'English', { version: '0.0.0' })),
        JSON.stringify(v1('bad id!', 'Unsafe')),
        JSON.stringify(v1('v1-dead', 'Dead', { deletedAt: t(-DAY) })),
        JSON.stringify({ ...v1('v2-waiting', 'Waiting'), clocks: { created: t(-DAY), body: '1970-01-01T00:00:00.000Z' } }),
        JSON.stringify({ ...v1('array-clocks', 'Array Clocks'), clocks: [] }),
        JSON.stringify({ ...v1('v1-a', 'Vee One Twin'), clocks: { created: t(-DAY), body: t(-DAY) } }),
        'null', '"text"', '{"name":"no id"}', '{"id":7}',
      ].map((line) => `    ${line}`).join(',\n') + '\n  ],\n  "last": 1\n}\n',
      [body('v1-a')]: pretty(pack('Vee One')),
      [body('builtin-english')]: pretty({ name: 'English', version: '0.0.0' }),
      [body('v1-dead')]: pretty(pack('Dead')),
      [body('v2-waiting')]: pretty(pack('Waiting')),
      [body('array-clocks')]: pretty(pack('Array Clocks')),
    },
    mtimes: {
      [body('v1-a')]: '2026-10-01T01:02:03.500Z',
      [body('builtin-english')]: '2026-10-02T00:00:00.000Z',
      [body('v1-dead')]: '2026-10-03T00:00:00.250Z',
      [body('v2-waiting')]: '2026-10-04T00:00:00.000Z',
      [body('array-clocks')]: '2026-10-05T00:00:00.000Z',
    },
    steps: [
      get('v1-a'),
      { op: 'refreshCoverage', id: 'v1-a', values: { matchedBaseVersion: '0.9.0', coverage: { totalKeys: 2, coveredKeys: 2 }, measuredBodyClock: '2026-10-01T01:02:03.500Z' } },
      list,
      get('v2-waiting'),
      { op: 'hasName', name: 'vee one' },
      setEnabled('v1-a', false),
    ],
  },
  {
    name: 'a v1 index whose body file is dated before the epoch',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [v1('old', 'Old')] }),
      [body('old')]: pretty(pack('Old')),
    },
    mtimes: { [body('old')]: '1969-12-31T23:59:59.000Z' },
    steps: [list],
  },
  { name: 'an index that is not JSON', time: T0, tree: { [INDEX]: 'not json', [body('x')]: pretty(pack('X')) }, steps: [get('x'), list, apply(pack('New'), {})] },
  { name: 'an index that is an array', time: T0, tree: { [INDEX]: '[{"metas":[]}]' }, steps: [list] },
  { name: 'an index that is null', time: T0, tree: { [INDEX]: 'null' }, steps: [{ op: 'hasName', name: 'x' }, list] },
  { name: 'an index whose metas is not a list', time: T0, tree: { [INDEX]: '{"keep":1,"metas":{"0":{"id":"x"}}}' }, steps: [list] },
  { name: 'an index with a byte order mark', time: T0, tree: { [INDEX]: '﻿{"metas":[]}' }, steps: [list] },
  {
    name: 'invalid UTF-8 in the index and a body',
    time: T0,
    tree: {
      [INDEX]: { hex: Buffer.concat([Buffer.from('{"metas":[{"id":"x","filename":"packs/x.json","name":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","version":"1","enabled":true,"savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [body('x')]: { hex: Buffer.concat([Buffer.from('{"name":"X","version":"1","note":"'), Buffer.from([0xc3]), Buffer.from('"}')]).toString('hex') },
    },
    mtimes: { [body('x')]: '2026-09-01T00:00:00.000Z' },
    steps: [get('x'), list],
  },
  {
    name: 'the English entry without its body file gets the body back',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [{ id: 'builtin-english', filename: 'packs/builtin-english.json', name: 'English', version: '0.0.0', enabled: true, uploaderName: 'pipette', savedAt: 'now', updatedAt: 'now' }] }),
    },
    steps: [get('builtin-english'), list, get('builtin-english'), list],
  },
  {
    name: 'metas whose name is not a string',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [
        { ...v1('num', 'x'), name: 5, clocks: { created: t(-DAY), body: t(-DAY) } },
        { ...v1('none', 'x'), name: undefined, clocks: { created: t(-DAY), body: t(-DAY) } },
        { ...v1('nul', 'x'), name: null, clocks: { created: t(-DAY), body: t(-DAY) } },
      ] }),
      [body('num')]: pretty(pack('Num')),
      [body('none')]: pretty(pack('None')),
      [body('nul')]: pretty({ version: '1' }),
      'exports/': null,
    },
    steps: [
      get('num'),
      get('none'),
      get('nul'),
      { op: 'hasName', name: 'x' },
      rename('num', 'Fine'),
      apply(pack('Other'), {}),
      apply(pack('Other'), { id: 'nul' }),
      exportTo('num', 'exports/num.json'),
      exportTo('none', 'exports/none.json'),
      list,
    ],
  },
  {
    name: 'imports read through the dialog and saved, sample packs included',
    time: T0,
    tree: {
      'imports/': null,
      'imports/good.json': JSON.stringify(pack('Good')),
      'imports/bom.json': '﻿' + JSON.stringify(pack('Bom')),
      'imports/not-json.json': '{ not valid json',
      'imports/bad-utf8.json': { hex: Buffer.concat([Buffer.from('{"name":"Bad","version":"1","x":"'), Buffer.from([0xff]), Buffer.from('"}')]).toString('hex') },
      'imports/array.json': '[1,2]',
      'imports/lone.json': '{"name":"Lone \\ud800","version":"1"}',
      ...Object.fromEntries(SAMPLES.map((name) => [`imports/${name}.json`, { copyOf: sample(name) }])),
      'exports/': null,
    },
    steps: [
      { op: 'import', dialog: ['imports/good.json', 'imports/bom.json', 'imports/not-json.json', 'imports/bad-utf8.json', 'imports/array.json', 'imports/lone.json', 'imports/missing.json', 'imports'] },
      { op: 'import', dialog: SAMPLES.map((name) => `imports/${name}.json`) },
      { op: 'import', dialog: null },
      { op: 'import', dialog: [] },
      applyFile('imports/good.json', FULL),
      applyFile('imports/bad-utf8.json', PARTIAL),
      applyFile('imports/lone.json', PARTIAL),
      ...SAMPLES.map((name, i) => applyFile(`imports/${name}.json`, { ...FULL, coverage: { totalKeys: 1000, coveredKeys: 990 + i } })),
      at(MIN),
      applyFile('imports/Japanese.json', PARTIAL),
      list,
      get(uuid(4)),
      rename(uuid(4), '日本語 / テスト'),
      exportTo(uuid(4), 'exports/ja.json'),
      exportTo(uuid(4), null),
      exportTo(uuid(1), 'exports/good.json'),
      exportTo('builtin-english', 'exports/en.json'),
      exportTo('missing', 'exports/missing.json'),
      exportTo('../x', 'exports/x.json'),
      exportTo(5, 'exports/x.json'),
      exportTo(uuid(1), 'no-such-dir/good.json'),
      del(uuid(2)),
      exportTo(uuid(2), 'exports/deleted.json'),
    ],
  },
  {
    name: 'a body that is not an object is answered and exported as it is',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [
        { ...v1('arr', 'Array Body'), clocks: { created: t(-DAY), body: t(-DAY) } },
        { ...v1('str', 'String Body'), clocks: { created: t(-DAY), body: t(-DAY) } },
        { ...v1('bad', 'Bad Body'), clocks: { created: t(-DAY), body: t(-DAY) } },
        { ...v1('gone', 'No Body'), clocks: { created: t(-DAY), body: t(-DAY) } },
      ] }),
      [body('arr')]: '[1,{"name":"inner"}]',
      [body('str')]: '"text"',
      [body('bad')]: '{',
      'exports/': null,
    },
    steps: [get('arr'), get('str'), get('bad'), get('gone'), exportTo('arr', 'exports/arr.json'), exportTo('str', 'exports/str.json'), exportTo('bad', 'exports/bad.json')],
  },
  {
    name: 'old tombstones stay (no garbage collection outside sync)',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [{ ...v1('ancient', 'Ancient', { deletedAt: t(-90 * DAY) }), clocks: { created: t(-100 * DAY), body: t(-100 * DAY) } }] }),
      [body('ancient')]: pretty(pack('Ancient')),
    },
    steps: [list, apply(pack('Fresh'), {}), { op: 'reorder', ids: [uuid(1)] }, del(uuid(1)), list],
  },
]

async function run(step: Exclude<Step, { op: 'at' }>, dir: string): Promise<unknown> {
  const ev = { sender: {} }
  const call = (channel: string, ...args: unknown[]): Promise<unknown> => handler(state, channel)(ev, ...args)
  switch (step.op) {
    case 'list': return call(IpcChannels.I18N_PACK_STORE_LIST)
    case 'get': return call(IpcChannels.I18N_PACK_STORE_GET, step.id)
    case 'hasName': return call(IpcChannels.I18N_PACK_STORE_HAS_NAME, step.name, step.excludeId)
    case 'rename': return call(IpcChannels.I18N_PACK_STORE_RENAME, step.id, step.name)
    case 'setEnabled': return call(IpcChannels.I18N_PACK_STORE_SET_ENABLED, step.id, step.enabled)
    case 'refreshCoverage': return call(IpcChannels.I18N_PACK_STORE_REFRESH_COVERAGE, step.id, step.values)
    case 'reorder': return call(IpcChannels.I18N_PACK_STORE_REORDER, step.ids)
    case 'delete': return call(IpcChannels.I18N_PACK_STORE_DELETE, step.id)
    case 'hubPostId':
      return call(IpcChannels.I18N_PACK_STORE_SET_HUB_POST_ID, step.id, step.hubPostId, step.uploaderName, step.hubUpdatedAt)
    case 'import': return call(IpcChannels.I18N_PACK_IMPORT)
    // The preload passes `options ?? {}`.
    case 'importApply': return call(IpcChannels.I18N_PACK_IMPORT_APPLY, ...rawValue(step.raw, dir), step.options ?? {})
    case 'export': return call(IpcChannels.I18N_PACK_EXPORT, step.id)
  }
}

describe('i18n pack store fixtures', () => {
  it('records each scenario’s responses, dialogs, notified units and files', async () => {
    setupI18nPackStore()
    const results = await playAll(state, SCENARIOS, run, 'i18n-pack-store-fixtures-')
    writeJsonFixture(OUT, results)
    const first = results[0]
    expect(first.notified[0]).toBe('i18n/index')
    expect(first.notified).not.toContain('i18n/packs/builtin-english')
  })
})
