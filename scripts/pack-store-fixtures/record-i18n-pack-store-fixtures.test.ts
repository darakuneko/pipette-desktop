// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the language pack store of
// src-tauri/crates/pipette-pack-stores: runs the real I18N_PACK_* handlers
// of src/main/i18n-pack-ipc.ts on a userData directory built in a temp
// directory, at fixed times and with a fixed sequence of new ids. The file
// dialogs answer paths under userData (or are cancelled). It records each
// step's response, the sync units reported to notifyChange, and every file
// and directory left behind (path → content).
//
// The import dialog's answer is recorded as the renderer gets it. The
// Tauri build reads the files in the backend and parses them in the shim,
// so the crate rebuilds the same answer from the files it reads.
//
// Recorded values are normalized where the two builds differ on purpose:
// - a path under userData starts with `<userData>/`;
// - the text of a file-system error is the OS's and Node's (`<os error>`),
//   and that of a JSON.parse failure the JavaScript engine's
//   (`<parse error>`);
// - a response longer than 4 KiB is recorded as the SHA-256 of its JSON,
//   and a file larger than 4 KiB as `{ sha256, size }` (the sample packs).
//
// A scenario's tree can copy a file of the repository (`{ copyOf }`) and
// set modification times (`mtimes`), which the v1 metas' body clock reads.
// The times the files got are recorded in nanoseconds (`mtimesNs`), so the
// crate sets the same ones.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const { handlers, notified, paths, ids, dialogs } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  ids: { next: 1 },
  /** The paths the next dialog answers, under userData; null cancels it. */
  dialogs: { answer: null as string[] | null, defaultPath: undefined as string | undefined },
}))

vi.mock('electron', () => {
  const chosen = (): string[] => (dialogs.answer ?? []).map((path) => `${paths.userData}/${path}`)
  return {
    app: { getPath: () => paths.userData },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: {
      showSaveDialog: (_win: unknown, options: { defaultPath?: string }) => {
        dialogs.defaultPath = options.defaultPath
        const [filePath] = chosen()
        return Promise.resolve({ canceled: filePath === undefined, filePath })
      },
      showOpenDialog: () => {
        const filePaths = chosen()
        return Promise.resolve({ canceled: dialogs.answer === null, filePaths })
      },
    },
  }
})
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

import { setupI18nPackStore } from '../../src/main/i18n-pack-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-pack-stores/tests/fixtures/ts_i18n_pack_store_scenarios.json')

/** Content larger than this is recorded by its hash. */
const INLINE_LIMIT = 4096

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8, `{ copyOf }` for a file of the repository, `{ sha256, size }`
 *  for a large recorded file), or null for a directory. */
type Node = string | { hex: string } | { copyOf: string } | { sha256: string; size: number } | null
type Tree = Record<string, Node>

/** A JSON value given as is, or read from a file under userData when the
 *  step runs (`{ fromFile }`, parsed with JSON.parse). */
type Raw = { value: unknown } | { fromFile: string } | { absent: true }

type Step =
  | { op: 'list' }
  | { op: 'get'; id: unknown }
  | { op: 'hasName'; name: unknown; excludeId?: unknown }
  | { op: 'rename'; id: unknown; name: unknown }
  | { op: 'setEnabled'; id: unknown; enabled: unknown }
  | { op: 'refreshCoverage'; id: unknown; values: unknown }
  | { op: 'reorder'; ids: unknown }
  | { op: 'delete'; id: unknown }
  | { op: 'hubPostId'; id: unknown; hubPostId: unknown; uploaderName?: unknown; hubUpdatedAt?: unknown }
  /** The dialog answers `dialog` (paths under userData), or is cancelled. */
  | { op: 'import'; dialog: string[] | null }
  | { op: 'importApply'; raw: Raw; options?: unknown }
  | { op: 'export'; id: unknown; dialog: string | null }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

interface Scenario {
  name: string
  time: string
  tree: Tree
  /** Modification times set after the tree is built: path → ISO time. */
  mtimes?: Record<string, string>
  steps: Step[]
}

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const DAY = 24 * 60 * MIN
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

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

const SCENARIOS: Scenario[] = [
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
    if (typeof content === 'string') writeFileSync(target, content)
    else if ('hex' in content) writeFileSync(target, Buffer.from(content.hex, 'hex'))
    else if ('copyOf' in content) writeFileSync(target, readFileSync(resolve(REPO_ROOT, content.copyOf)))
    else throw new Error(`cannot build ${path}`)
  }
}

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

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
      if (bytes.length > INLINE_LIMIT) tree[`${prefix}${name}`] = { sha256: sha256(bytes), size: bytes.length }
      else tree[`${prefix}${name}`] = Buffer.from(text, 'utf-8').equals(bytes) ? text : { hex: bytes.toString('hex') }
    }
  }
  return tree
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

function rawValue(raw: Raw, dir: string): unknown[] {
  if ('absent' in raw) return [undefined]
  if ('value' in raw) return [raw.value]
  return [JSON.parse(readFileSync(join(dir, raw.fromFile), 'utf-8'))]
}

async function run(step: Exclude<Step, { op: 'at' }>, dir: string): Promise<unknown> {
  const ev = { sender: {} }
  switch (step.op) {
    case 'list': return handler(IpcChannels.I18N_PACK_STORE_LIST)(ev)
    case 'get': return handler(IpcChannels.I18N_PACK_STORE_GET)(ev, step.id)
    case 'hasName': return handler(IpcChannels.I18N_PACK_STORE_HAS_NAME)(ev, step.name, step.excludeId)
    case 'rename': return handler(IpcChannels.I18N_PACK_STORE_RENAME)(ev, step.id, step.name)
    case 'setEnabled': return handler(IpcChannels.I18N_PACK_STORE_SET_ENABLED)(ev, step.id, step.enabled)
    case 'refreshCoverage': return handler(IpcChannels.I18N_PACK_STORE_REFRESH_COVERAGE)(ev, step.id, step.values)
    case 'reorder': return handler(IpcChannels.I18N_PACK_STORE_REORDER)(ev, step.ids)
    case 'delete': return handler(IpcChannels.I18N_PACK_STORE_DELETE)(ev, step.id)
    case 'hubPostId':
      return handler(IpcChannels.I18N_PACK_STORE_SET_HUB_POST_ID)(ev, step.id, step.hubPostId, step.uploaderName, step.hubUpdatedAt)
    case 'import': return handler(IpcChannels.I18N_PACK_IMPORT)(ev)
    // The preload passes `options ?? {}`.
    case 'importApply': return handler(IpcChannels.I18N_PACK_IMPORT_APPLY)(ev, ...rawValue(step.raw, dir), step.options ?? {})
    case 'export': return handler(IpcChannels.I18N_PACK_EXPORT)(ev, step.id)
  }
}

/** The response as recorded (see the module doc). */
function outcome(response: unknown, dir: string): unknown {
  const text = JSON.stringify(response, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    if (value.startsWith(`${dir}/`)) return `<userData>/${value.slice(dir.length + 1)}`
    return value
  })
  const r = JSON.parse(text) as { error?: unknown; files?: { parseError?: unknown }[] }
  if (typeof r.error === 'string' && /^Error: E[A-Z]+:/.test(r.error)) r.error = '<os error>'
  if (typeof r.error === 'string' && r.error.startsWith('SyntaxError:')) r.error = '<parse error>'
  for (const file of r.files ?? []) {
    if (typeof file.parseError === 'string') file.parseError = /^Error: E[A-Z]+:/.test(file.parseError) ? '<os error>' : '<parse error>'
  }
  const normalized = JSON.stringify(r)
  return normalized.length > INLINE_LIMIT ? { sha256: sha256(normalized) } : normalized
}

interface Played {
  /** The modification time each file of `mtimes` got, in nanoseconds since
   *  the epoch. */
  mtimesNs: Record<string, string>
  outcomes: unknown[]
  /** The default file name each export's save dialog offered. */
  defaultPaths: (string | null)[]
  notified: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string): Promise<Played> {
  paths.userData = dir
  notified.length = 0
  ids.next = 1
  build(dir, scenario.tree)
  const mtimesNs: Record<string, string> = {}
  for (const [path, time] of Object.entries(scenario.mtimes ?? {})) {
    const when = new Date(time)
    utimesSync(join(dir, path), when, when)
    mtimesNs[path] = statSync(join(dir, path), { bigint: true }).mtimeNs.toString()
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: unknown[] = []
    const defaultPaths: (string | null)[] = []
    for (const step of scenario.steps) {
      dialogs.defaultPath = undefined
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push(null)
      } else {
        dialogs.answer = step.op === 'import' ? step.dialog : step.op === 'export' && step.dialog !== null ? [step.dialog] : null
        try {
          outcomes.push(outcome(await run(step, dir), dir))
        } catch (err) {
          outcomes.push({ rejected: String(err) })
        }
      }
      defaultPaths.push(dialogs.defaultPath ?? null)
    }
    return { mtimesNs, outcomes, defaultPaths, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('i18n pack store fixtures', () => {
  it('records each scenario’s responses, dialogs, notified units and files', async () => {
    setupI18nPackStore()
    root = mkdtempSync(join(tmpdir(), 'i18n-pack-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const first = results[0]
    expect(first.notified[0]).toBe('i18n/index')
    expect(first.notified).not.toContain('i18n/packs/builtin-english')
  })
})
