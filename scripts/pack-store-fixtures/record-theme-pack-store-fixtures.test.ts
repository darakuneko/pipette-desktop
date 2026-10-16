// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the theme pack store of
// src-tauri/crates/pipette-pack-stores: runs the real THEME_PACK_* handlers
// of src/main/theme-pack-ipc.ts through the scenarios below and records
// what they answer, report and leave behind (pack-fixture-harness.ts).
//
// The Tauri build checks a pack with validateThemePack in the page (the
// shim) before the backend sees it, as the Electron store does before it
// takes its lock. An import-apply step whose pack fails that check records
// the shim's answer (`pageError`, the check's errors joined); the crate
// compares that answer with the handler's and does not call the backend.
//
// A step whose handler broadcasts THEME_PACK_CHANGED records `changed`, so
// the crate's replay checks the backend sends the event after the same
// steps.

import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { type CommonStep, type Raw, type Scenario, handler, playAll, rawValue, uuid } from './pack-fixture-harness'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  ids: { next: 1 },
  dialogs: { answer: null as string[] | null, defaultPath: undefined as string | undefined },
  broadcasts: [] as string[],
}))

vi.mock('electron', async () => (await import('./pack-fixture-harness')).electronMock(state))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => state.notified.push(unit) }))
vi.mock('../../src/main/logger', () => ({ log: () => undefined }))
vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string) => state.broadcasts.push(channel),
}))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  // uuid() of pack-fixture-harness.ts, which imports this module.
  const randomUUID = (): string => `00000000-0000-4000-8000-${String(state.ids.next++).padStart(12, '0')}`
  return { ...actual, default: { ...actual, randomUUID }, randomUUID }
})

import { setupThemePackStore } from '../../src/main/theme-pack-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { validateThemePack } from '../../src/shared/theme/validate'
import { THEME_COLOR_KEYS } from '../../src/shared/types/theme-store'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-pack-stores/tests/fixtures/ts_theme_pack_store_scenarios.json')

type Step =
  | CommonStep
  | { op: 'list' }
  | { op: 'get'; id: unknown }
  | { op: 'hasName'; name: unknown; excludeId?: unknown }
  | { op: 'rename'; id: unknown; name: unknown }
  | { op: 'reorder'; ids: unknown }
  | { op: 'delete'; id: unknown }
  | { op: 'hubPostId'; id: unknown; hubPostId: unknown; uploaderName?: unknown; hubUpdatedAt?: unknown }
  /** `pageError` is filled in when the pack fails the page's check. */
  | { op: 'importApply'; raw: Raw; options?: unknown; pageError?: string }

/** Filled in on a step whose handler broadcast THEME_PACK_CHANGED. */
type Recorded<S> = S & { changed?: true }

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const DAY = 24 * 60 * MIN
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })

const INDEX = 'sync/themes/index.json'
const body = (id: string): string => `sync/themes/packs/${id}.json`
const pretty = (value: unknown): string => JSON.stringify(value, null, 2)
const colors = (): Record<string, string> => Object.fromEntries(THEME_COLOR_KEYS.map((key, i) => [key, `#${String(i).padStart(6, '0')}`]))
const theme = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name, version: '1.0.0', colorScheme: 'dark', colors: colors(), ...extra })

const list: Step = { op: 'list' }
const get = (id: unknown): Step => ({ op: 'get', id })
const apply = (value: unknown, options?: unknown): Step => ({ op: 'importApply', raw: { value }, options })
const applyFile = (fromFile: string, options?: unknown): Step => ({ op: 'importApply', raw: { fromFile }, options })
const rename = (id: unknown, name: unknown): Step => ({ op: 'rename', id, name })
const del = (id: unknown): Step => ({ op: 'delete', id })
const exportTo = (id: unknown, dialog: string | null): Step => ({ op: 'export', id, dialog })

/** A v1 meta (no clocks). */
const v1 = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, filename: `packs/${id}.json`, name, version: '0.1.0', savedAt: t(-2 * DAY), updatedAt: t(-DAY), ...extra,
})
/** A v2 meta. */
const v2 = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ ...v1(id, name, extra), clocks: { created: t(-DAY), body: t(-DAY) } })

const SAMPLES = ['catppuccin-mocha', 'gruvbox-light', 'tokyo-night', 'solarized-dark']
const sample = (name: string): string => `sample-packs/themes/${name}.json`

const SCENARIOS: Scenario<Step>[] = [
  {
    name: 'saves, names, Hub links and deletes',
    time: T0,
    tree: {},
    steps: [
      list,
      apply(theme('Alpha')),
      apply(theme('  Beta  ', { version: ' 2.0.0 ', colorScheme: 'light' })),
      at(MIN),
      { op: 'hasName', name: ' alpha ' },
      { op: 'hasName', name: 'Alpha', excludeId: uuid(1) },
      { op: 'hasName', name: 'beta', excludeId: 7 },
      { op: 'hasName', name: 5 },
      rename(uuid(1), '  Renamed  '),
      rename(uuid(1), 'BETA'),
      rename(uuid(1), 'x'.repeat(65)),
      rename(uuid(1), '😀'.repeat(32)),
      rename(uuid(1), '😀'.repeat(32) + 'x'),
      rename(uuid(1), ' 　 '),
      rename(uuid(1), 7),
      rename(5, 'x'),
      rename('missing', 'x'),
      { op: 'hubPostId', id: uuid(1), hubPostId: ' post-1 ', uploaderName: ' alice ', hubUpdatedAt: ' 2026-05-01T00:00:00.000Z ' },
      { op: 'hubPostId', id: uuid(1), hubPostId: 'post-1', hubUpdatedAt: ' ' },
      { op: 'hubPostId', id: uuid(1), hubPostId: 'post-2', uploaderName: '', hubUpdatedAt: '2026-06-01T00:00:00.000Z' },
      { op: 'hubPostId', id: uuid(1), hubPostId: null, uploaderName: 'bob' },
      { op: 'hubPostId', id: uuid(2), hubPostId: 5, uploaderName: 5, hubUpdatedAt: 5 },
      { op: 'hubPostId', id: 'missing', hubPostId: 'p' },
      { op: 'hubPostId', id: 5, hubPostId: 'p' },
      at(3 * MIN),
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
      { op: 'hasName', name: 'beta' },
      list,
    ],
  },
  {
    name: 'saves over packs: same name, kept names, revived tombstones, explicit ids and three-state fields',
    time: T0,
    tree: {},
    steps: [
      apply(theme('Gamma'), { hubPostId: '', uploaderName: 'carol', hubUpdatedAt: '2026-01-01T00:00:00.000Z', id: 5 }),
      at(MIN),
      apply(theme('gamma ', { version: '1.1.0' }), { uploaderName: ' ', hubUpdatedAt: '' }),
      rename(uuid(1), 'Gamma Renamed'),
      at(2 * MIN),
      apply(theme('Gamma', { version: '1.2.0' }), { id: uuid(1), hubPostId: 7 }),
      apply(theme('Gamma Renamed'), {}),
      apply(theme('Delta'), { hubPostId: 'post-d', uploaderName: 'dave' }),
      del(uuid(2)),
      at(3 * MIN),
      apply(theme('Delta', { version: '3.0.0' }), {}),
      apply(theme('Epsilon'), { id: uuid(2) }),
      at(4 * MIN),
      apply(theme('Delta'), { id: uuid(2) }),
      apply(theme('Zeta'), { id: '../bad' }),
      apply(theme('Zeta'), { id: 'custom_id-1', hubPostId: 'post-z' }),
      apply(theme('zeta', { version: '1.1.0' }), { id: '' }),
      apply(theme('Omega'), { id: '' }),
      apply(theme('Eta'), 'not an object'),
      apply(theme('Theta'), [1, 2]),
      { op: 'importApply', raw: { value: theme('Iota') } },
      apply({ '2': 'index key', ...theme('Kappa'), nested: [1, 2.5, 1e21], text: 'Lone \ud800' }, { uploaderName: '\ud800' }),
      get('custom_id-1'),
      list,
    ],
  },
  {
    name: 'packs the page refuses never reach the store',
    time: T0,
    tree: {},
    steps: [
      apply({ name: 'No colors', version: '1.0.0', colorScheme: 'dark' }, {}),
      apply([theme('Array')], {}),
      apply('just text', {}),
      apply(null, {}),
      { op: 'importApply', raw: { absent: true }, options: {} },
      apply(theme('Bad version', { version: '1' }), {}),
      apply(theme(' '), {}),
      apply(theme('x'.repeat(65)), {}),
      apply(theme('Scheme', { colorScheme: 'blue' }), {}),
      apply(theme('Colors', { colors: { ...colors(), accent: 'red', surface: 5, extra: '#fff' } }), {}),
      apply(JSON.parse(`{"name":"Proto","version":"1.0.0","colorScheme":"dark","colors":${JSON.stringify(colors())},"__proto__":1}`), {}),
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
      apply(theme('A')),
      apply(theme('B')),
      apply(theme('C')),
      del(uuid(2)),
      at(MIN),
      { op: 'reorder', ids: [uuid(3), 'missing', uuid(2), uuid(3)] },
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
      [INDEX]: pretty({ metas: [v2('dup', 'First'), v1('other', 'Other'), v2('dup', 'Second')] }),
    },
    steps: [{ op: 'reorder', ids: ['dup'] }, list, { op: 'reorder', ids: ['other'] }, list],
  },
  {
    name: 'a v1 index: body clocks from the body files, other fields kept',
    time: T0,
    tree: {
      [INDEX]: '{\n  "first": true,\n  "metas": [\n' + [
        JSON.stringify(v1('v1-a', 'Vee One', { extra: 'kept' })),
        JSON.stringify(v1('v1-no-body', 'No Body')),
        JSON.stringify(v1('bad id!', 'Unsafe')),
        JSON.stringify(v1('v1-dead', 'Dead', { deletedAt: t(-DAY) })),
        JSON.stringify({ ...v1('v2-waiting', 'Waiting'), clocks: { created: t(-DAY), body: '1970-01-01T00:00:00.000Z' } }),
        JSON.stringify({ ...v1('array-clocks', 'Array Clocks'), clocks: [] }),
        JSON.stringify(v2('v1-a', 'Vee One Twin')),
        'null', '"text"', '{"name":"no id"}', '{"id":7}',
      ].map((line) => `    ${line}`).join(',\n') + '\n  ],\n  "last": 1\n}\n',
      [body('v1-a')]: pretty(theme('Vee One')),
      [body('v1-dead')]: pretty(theme('Dead')),
      [body('v2-waiting')]: pretty(theme('Waiting')),
      [body('array-clocks')]: pretty(theme('Array Clocks')),
    },
    mtimes: {
      [body('v1-a')]: '2026-10-01T01:02:03.500Z',
      [body('v1-dead')]: '2026-10-03T00:00:00.250Z',
      [body('v2-waiting')]: '2026-10-04T00:00:00.000Z',
      [body('array-clocks')]: '2026-10-05T00:00:00.000Z',
    },
    steps: [
      get('v1-a'),
      list,
      get('v2-waiting'),
      { op: 'hasName', name: 'vee one' },
      rename('v1-a', 'Vee One Renamed'),
    ],
  },
  {
    name: 'a v1 index whose body file is dated before the epoch',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [v1('old', 'Old')] }),
      [body('old')]: pretty(theme('Old')),
    },
    mtimes: { [body('old')]: '1969-12-31T23:59:59.000Z' },
    steps: [list],
  },
  { name: 'an index that is not JSON', time: T0, tree: { [INDEX]: 'not json', [body('x')]: pretty(theme('X')) }, steps: [get('x'), list, apply(theme('New'))] },
  { name: 'an index that is an array', time: T0, tree: { [INDEX]: '[{"metas":[]}]' }, steps: [list] },
  { name: 'an index that is null', time: T0, tree: { [INDEX]: 'null' }, steps: [{ op: 'hasName', name: 'x' }, list] },
  { name: 'an index whose metas is not a list', time: T0, tree: { [INDEX]: '{"keep":1,"metas":{"0":{"id":"x"}}}' }, steps: [list, apply(theme('New'))] },
  { name: 'an index with a byte order mark', time: T0, tree: { [INDEX]: '﻿{"metas":[]}' }, steps: [list] },
  {
    name: 'invalid UTF-8 in the index and a body',
    time: T0,
    tree: {
      [INDEX]: { hex: Buffer.concat([Buffer.from('{"metas":[{"id":"x","filename":"packs/x.json","name":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","version":"1.0.0","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [body('x')]: { hex: Buffer.concat([Buffer.from('{"name":"X","version":"1.0.0","note":"'), Buffer.from([0xc3]), Buffer.from('"}')]).toString('hex') },
    },
    mtimes: { [body('x')]: '2026-09-01T00:00:00.000Z' },
    steps: [get('x'), list],
  },
  {
    name: 'metas whose name is not a string',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [
        { ...v2('num', 'x'), name: 5 },
        { ...v2('none', 'x'), name: undefined },
        { ...v2('nul', 'x'), name: null },
      ] }),
      [body('num')]: pretty(theme('Num')),
      [body('none')]: pretty(theme('None')),
      [body('nul')]: pretty({ version: '1.0.0' }),
      'exports/': null,
    },
    steps: [
      get('num'),
      get('none'),
      get('nul'),
      { op: 'hasName', name: 'x' },
      rename('num', 'Fine'),
      apply(theme('Other')),
      apply(theme('Other'), { id: 'nul' }),
      exportTo('num', 'exports/num.json'),
      exportTo('none', 'exports/none.json'),
      exportTo('nul', 'exports/nul.json'),
      list,
    ],
  },
  {
    name: 'imports read through the dialog and saved, sample themes included',
    time: T0,
    tree: {
      'imports/': null,
      'imports/good.json': JSON.stringify(theme('Good')),
      'imports/bom.json': '﻿' + JSON.stringify(theme('Bom')),
      'imports/not-json.json': '{ not valid json',
      'imports/bad-utf8.json': { hex: Buffer.concat([Buffer.from(JSON.stringify(theme('Bad UTF-8')).slice(0, -1) + ',"x":"'), Buffer.from([0xff]), Buffer.from('"}')]).toString('hex') },
      'imports/array.json': '[1,2]',
      'imports/lone.json': JSON.stringify(theme('Lone')).replace('"Lone"', '"Lone \\ud800"'),
      ...Object.fromEntries(SAMPLES.map((name) => [`imports/${name}.json`, { copyOf: sample(name) }])),
      'exports/': null,
    },
    steps: [
      { op: 'import', dialog: ['imports/good.json', 'imports/bom.json', 'imports/not-json.json', 'imports/bad-utf8.json', 'imports/array.json', 'imports/lone.json', 'imports/missing.json', 'imports'] },
      { op: 'import', dialog: SAMPLES.map((name) => `imports/${name}.json`) },
      { op: 'import', dialog: null },
      { op: 'import', dialog: [] },
      applyFile('imports/good.json'),
      applyFile('imports/bad-utf8.json'),
      applyFile('imports/lone.json'),
      applyFile('imports/array.json'),
      ...SAMPLES.map((name) => applyFile(`imports/${name}.json`)),
      at(MIN),
      applyFile(`imports/${SAMPLES[0]}.json`, { hubPostId: 'post-s' }),
      list,
      get(uuid(4)),
      rename(uuid(4), 'テーマ / テスト'),
      exportTo(uuid(4), 'exports/ja.json'),
      exportTo(uuid(4), null),
      exportTo(uuid(1), 'exports/good.json'),
      exportTo('missing', 'exports/missing.json'),
      exportTo('../x', 'exports/x.json'),
      exportTo(5, 'exports/x.json'),
      exportTo(uuid(1), 'no-such-dir/good.json'),
      del(uuid(2)),
      exportTo(uuid(2), 'exports/deleted.json'),
    ],
  },
  {
    name: 'a body that is not an object is spread into one',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [
        v2('arr', 'Array Body'),
        v2('str', 'String Body'),
        v2('num', 'Number Body'),
        v2('nul', 'Null Body'),
        v2('named', 'Named Body'),
        v2('bad', 'Bad Body'),
        v2('gone', 'No Body'),
      ] }),
      [body('arr')]: '[1,{"name":"inner"},"x"]',
      [body('str')]: '"a😀\\ud800"',
      [body('num')]: '5',
      [body('nul')]: 'null',
      [body('named')]: '{"10":"ten","name":"Old","2":"two","colors":{}}',
      [body('bad')]: '{',
      'exports/': null,
    },
    steps: [
      get('arr'), get('str'), get('num'), get('nul'), get('named'), get('bad'), get('gone'),
      exportTo('arr', 'exports/arr.json'),
      exportTo('str', 'exports/str.json'),
      exportTo('nul', 'exports/nul.json'),
      exportTo('bad', 'exports/bad.json'),
    ],
  },
  {
    name: 'old tombstones stay (no garbage collection outside sync)',
    time: T0,
    tree: {
      [INDEX]: pretty({ metas: [{ ...v2('ancient', 'Ancient'), deletedAt: t(-90 * DAY), clocks: { created: t(-100 * DAY), body: t(-100 * DAY) } }] }),
      [body('ancient')]: pretty(theme('Ancient')),
    },
    steps: [list, apply(theme('Fresh')), { op: 'reorder', ids: [uuid(1)] }, del(uuid(1)), list],
  },
]

async function run(step: Exclude<Step, { op: 'at' }>, dir: string): Promise<unknown> {
  state.broadcasts.length = 0
  try {
    return await runHandler(step, dir)
  } finally {
    const changed = state.broadcasts.filter((channel) => channel === IpcChannels.THEME_PACK_CHANGED)
    if (state.broadcasts.length !== changed.length || changed.length > 1) throw new Error(`unexpected broadcasts ${state.broadcasts.join()}`)
    if (changed.length === 1) (step as Recorded<typeof step>).changed = true
  }
}

async function runHandler(step: Exclude<Step, { op: 'at' }>, dir: string): Promise<unknown> {
  const ev = { sender: {} }
  const call = (channel: string, ...args: unknown[]): Promise<unknown> => handler(state, channel)(ev, ...args)
  switch (step.op) {
    case 'list': return call(IpcChannels.THEME_PACK_STORE_LIST)
    case 'get': return call(IpcChannels.THEME_PACK_STORE_GET, step.id)
    case 'hasName': return call(IpcChannels.THEME_PACK_STORE_HAS_NAME, step.name, step.excludeId)
    case 'rename': return call(IpcChannels.THEME_PACK_STORE_RENAME, step.id, step.name)
    case 'reorder': return call(IpcChannels.THEME_PACK_STORE_REORDER, step.ids)
    case 'delete': return call(IpcChannels.THEME_PACK_STORE_DELETE, step.id)
    case 'hubPostId':
      return call(IpcChannels.THEME_PACK_STORE_SET_HUB_POST_ID, step.id, step.hubPostId, step.uploaderName, step.hubUpdatedAt)
    case 'import': return call(IpcChannels.THEME_PACK_IMPORT)
    case 'importApply': {
      const [raw] = rawValue(step.raw, dir)
      const checked = validateThemePack(raw)
      if (!checked.ok) step.pageError = checked.errors.join('; ')
      // The preload passes `options ?? {}`.
      return call(IpcChannels.THEME_PACK_IMPORT_APPLY, raw, step.options ?? {})
    }
    case 'export': return call(IpcChannels.THEME_PACK_EXPORT, step.id)
  }
}

describe('theme pack store fixtures', () => {
  it('records each scenario’s responses, dialogs, notified units and files', async () => {
    setupThemePackStore()
    const results = await playAll(state, SCENARIOS, run, 'theme-pack-store-fixtures-')
    writeJsonFixture(OUT, results)
    const refused = results.find((r) => r.name.startsWith('packs the page refuses'))
    expect(refused?.notified).toEqual([])
    expect(refused?.steps.filter((s) => s.op === 'importApply').every((s) => 'pageError' in s)).toBe(true)
  })
})
