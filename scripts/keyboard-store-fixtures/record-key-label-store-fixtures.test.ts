// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the key label store of
// src-tauri/crates/pipette-keyboard-stores: runs the real KEY_LABEL_STORE_*
// handlers of src/main/key-label-ipc.ts on a userData directory built in a
// temp directory, at fixed times and with a fixed sequence of new ids. The
// file dialogs answer paths under userData (or are cancelled). It records
// each step's response, the dialogs shown, the sync units reported to
// notifyChange, and every file and directory left behind (path → content).
//
// Texts the crate does not copy are recorded as placeholders: a file-system
// error's (the OS's and Node's) as `<os error>`, a JSON.parse error's (V8's)
// as `<parse error>`, and the userData path in an answer as `<userData>`.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const { handlers, notified, paths, ids, dialogs } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  ids: { next: 1 },
  /** The paths the next dialog answers, under userData; null cancels it.
   *  `shown` records the options of every dialog of the step. */
  dialogs: { answer: null as string[] | null, shown: [] as Record<string, unknown>[] },
}))

vi.mock('electron', () => {
  const chosen = (): string[] => (dialogs.answer ?? []).map((path) => `${paths.userData}/${path}`)
  return {
    app: { getPath: () => paths.userData },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: {
      showSaveDialog: (_win: unknown, options: Record<string, unknown>) => {
        dialogs.shown.push(options)
        const [filePath] = chosen()
        return Promise.resolve({ canceled: filePath === undefined, filePath })
      },
      showOpenDialog: (_win: unknown, options: Record<string, unknown>) => {
        dialogs.shown.push(options)
        const filePaths = chosen()
        return Promise.resolve({ canceled: filePaths.length === 0, filePaths })
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

import { setupKeyLabelStore } from '../../src/main/key-label-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_key_label_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

type Step =
  | { op: 'list' }
  | { op: 'listAll' }
  | { op: 'get'; id: unknown }
  | { op: 'rename'; id: unknown; name: unknown }
  | { op: 'delete'; id: unknown }
  | { op: 'hubPostId'; id: unknown; hubPostId: unknown }
  | { op: 'reorder'; ids: unknown }
  | { op: 'hasName'; name: unknown; excludeId?: unknown }
  /** The dialog answers `dialog` (paths under userData), or is cancelled. */
  | { op: 'import'; dialog: string[] | null }
  | { op: 'export'; id: unknown; dialog: string | null }
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

const DIR = 'sync/key-labels'
const index = (entries: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...extra, entries }, null, 2)
const v1 = (id: string, name: unknown, filename: string, extra: Record<string, unknown> = {}) => ({
  id, name, filename, savedAt: t(-60 * MIN), ...extra,
})
const QWERTY_V1 = v1('qwerty', 'QWERTY', 'qwerty_builtin.json', { savedAt: '1970-01-01T00:00:00.000Z' })
const label = (name: unknown, map: unknown = { KC_A: 'A' }, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, map, ...extra })

const list: Step = { op: 'list' }
const listAll: Step = { op: 'listAll' }
const get = (id: unknown): Step => ({ op: 'get', id })
const rename = (id: unknown, name: unknown): Step => ({ op: 'rename', id, name })
const del = (id: unknown): Step => ({ op: 'delete', id })
const hub = (id: unknown, hubPostId: unknown): Step => ({ op: 'hubPostId', id, hubPostId })
const reorder = (orderedIds: unknown): Step => ({ op: 'reorder', ids: orderedIds })
const hasName = (name: unknown, excludeId?: unknown): Step =>
  excludeId === undefined ? { op: 'hasName', name } : { op: 'hasName', name, excludeId }
const importFiles = (...dialog: string[]): Step => ({ op: 'import', dialog })
const exportTo = (id: unknown, dialog: string | null): Step => ({ op: 'export', id, dialog })

const EXPORTS: Tree = { 'exports/': null }

/** 99 and 98 `a`s and an emoji (two UTF-16 units): 101 and 100 units. */
const NAME_101 = `${'a'.repeat(99)}😀`
const NAME_100 = `${'b'.repeat(98)}😀`

const SCENARIOS: Scenario[] = [
  {
    name: 'a fresh store creates QWERTY, which cannot be deleted',
    time: T0,
    tree: { ...EXPORTS },
    steps: [
      get('qwerty'),
      hasName('qwerty'),
      list,
      list,
      listAll,
      get('qwerty'),
      hasName(' Qwerty '),
      hasName('QWERTY', 'qwerty'),
      del('qwerty'),
      exportTo('qwerty', 'exports/qwerty.json'),
      rename('qwerty', 'Base'),
      list,
    ],
  },
  {
    name: 'imports, renames, hub ids, deletes, reorders and exports',
    time: T0,
    tree: {
      ...EXPORTS,
      'in/alpha.json': label('Alpha', { KC_A: 'Å', KC_B: 'b' }, { composite_labels: { KC_C: 'C' }, keymap_applicable: true }),
      'in/beta.json': label('  Beta  ', ['x', 'y'], { compositeLabels: null, composite_labels: { KC_D: 'D' } }),
      'in/gamma.json': label('Gamma', {}, { compositeLabels: {}, keymapApplicable: 'yes', author: 'kept out' }),
      'in/alpha-again.json': label('ALPHA', { KC_Z: 'Z' }, { keymapApplicable: false }),
      'in/long.json': label(NAME_101),
      'in/hundred.json': label(NAME_100),
      'in/blank.json': label('   '),
      'in/no-map.json': JSON.stringify({ name: 'No map' }),
      'in/proto.json': '{"name":"Proto","map":{"KC_A":"A","__proto__":"x"}}',
      'in/ctor.json': label('Ctor', { KC_A: 'A' }, { composite_labels: { constructor: 'x' } }),
      'in/bad-composite.json': label('Bad composite', { KC_A: 'A' }, { compositeLabels: 'x' }),
      'in/number-value.json': label('Number', { KC_A: 1 }),
      'in/not-json.json': '{"name":',
      'in/bom.json': `﻿${label('Bom')}`,
      'in/array.json': '[]',
      'in/lone.json': '{"name":"Lone \\ud800","map":{"KC_A":"\\udc00"}}',
      'in/bad-utf8.json': { hex: Buffer.concat([Buffer.from('{"name":"Bad '), Buffer.from([0xff, 0xc3]), Buffer.from('","map":{}}')]).toString('hex') },
    },
    steps: [
      importFiles('in/alpha.json', 'in/beta.json', 'in/gamma.json', 'in/missing.json', 'in/not-json.json', 'in/bom.json', 'in/array.json'),
      at(MIN),
      importFiles('in/alpha-again.json', 'in/long.json', 'in/hundred.json', 'in/blank.json', 'in/no-map.json', 'in/proto.json', 'in/ctor.json', 'in/bad-composite.json', 'in/number-value.json', 'in/lone.json', 'in/bad-utf8.json'),
      { op: 'import', dialog: null },
      list,
      get(uuid(1)),
      get(uuid(2)),
      get(uuid(3)),
      get(5),
      get('missing'),
      at(2 * MIN),
      rename(uuid(1), '  Alpha Prime  '),
      rename(uuid(2), 'alpha prime'),
      rename(uuid(2), 'beta'),
      rename(uuid(2), NAME_101),
      rename(uuid(2), ' '),
      rename('missing', 'x'),
      rename(7, 'x'),
      rename(uuid(2), 7),
      hasName('ALPHA PRIME'),
      hasName('alpha prime', uuid(1)),
      hasName('alpha prime', 5),
      hasName(5),
      hub(uuid(1), ' post-1 '),
      hub(uuid(1), 'post-2'),
      hub(uuid(2), '　'),
      hub(uuid(3), 5),
      hub(uuid(3), null),
      hub('missing', 'p'),
      hub(9, 'p'),
      at(3 * MIN),
      importFiles('in/alpha.json'),
      del(uuid(2)),
      at(4 * MIN),
      del(uuid(2)),
      del('missing'),
      del(3),
      get(uuid(2)),
      rename(uuid(2), 'Back'),
      hub(uuid(2), 'post-3'),
      importFiles('in/beta.json'),
      listAll,
      reorder([uuid(3), 'missing', uuid(2), uuid(3), 'qwerty']),
      reorder('not a list'),
      reorder([uuid(1), 5]),
      list,
      listAll,
      exportTo(uuid(1), 'exports/alpha.json'),
      exportTo(uuid(3), 'exports/gamma.json'),
      exportTo(uuid(4), 'exports/beta.json'),
      exportTo(uuid(1), null),
      exportTo(uuid(2), 'exports/deleted.json'),
      exportTo('missing', 'exports/missing.json'),
      exportTo(5, 'exports/x.json'),
      exportTo(uuid(1), 'no-such-dir/alpha.json'),
    ],
  },
  {
    name: 'a v1 index with legacy names, unknown fields and a QWERTY without an author',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: '{\n  "before": [1, 2.50, 1e21],\n  "entries": [\n'
        + [
          JSON.stringify({ ...QWERTY_V1, extra: { keep: true } }),
          JSON.stringify(v1('a', 'Legacy A', '2026-10-16T11-00-00.000Z.json', { uploaderName: 'someone', hubPostId: 'hub-a', updatedAt: t(-30 * MIN) })),
          JSON.stringify(v1('b', 'Legacy B', '2026-10-16T11-00-00.000Z.json')),
          JSON.stringify(v1('gone', 'Gone', '2026-10-16T10-00-00.000Z.json', { deletedAt: t(-10 * MIN) })),
          JSON.stringify({
            note: 'first', id: 'future', name: 'Future', filename: 'future_2030-01-01T00-00-00.000Z.json',
            savedAt: '2030-01-01T00:00:00.000Z',
            clocks: { created: '2030-01-01T00:00:00.000Z', body: '2030-01-01T00:00:00.000Z', name: '2030-01-02T00:00:00.000Z', hub: 'nonsense' },
            updatedAt: '2031-01-01T00:00:00.000Z',
          }),
          '"a string entry"', 'null', '42', '{"name":"no id"}', '{"id":7,"name":"numeric id"}',
        ].map((line) => `    ${line}`).join(',\n')
        + '\n  ],\n  "after": "kept"\n}\n',
      [`${DIR}/qwerty_builtin.json`]: '{"name":"QWERTY","map":{}}',
      [`${DIR}/2026-10-16T11-00-00.000Z.json`]: label('Legacy', { KC_A: 'a' }, { composite_labels: { KC_B: 'b' }, keymap_applicable: true }),
      [`${DIR}/2026-10-16T10-00-00.000Z.json`]: label('Gone', {}),
      [`${DIR}/future_2030-01-01T00-00-00.000Z.json`]: label('Future', { KC_F: 'f' }),
      ...EXPORTS,
      'in/legacy-a.json': label('legacy a', { KC_N: 'n' }),
      'in/gone.json': label('Gone', { KC_G: 'g' }),
    },
    steps: [
      get('a'),
      hasName('legacy b'),
      list,
      listAll,
      get('a'),
      get('b'),
      get('gone'),
      exportTo('a', 'exports/a.json'),
      rename('future', 'Renamed future'),
      importFiles('in/legacy-a.json', 'in/gone.json'),
      listAll,
      reorder(['b', 'qwerty']),
      listAll,
    ],
  },
  {
    name: 'a QWERTY entry with an author is not rewritten by a list',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([{ ...QWERTY_V1, uploaderName: 'pipette' }], { first: true }),
      [`${DIR}/qwerty_builtin.json`]: '{"name":"QWERTY","map":{}}',
    },
    steps: [list, listAll, get('qwerty')],
  },
  {
    name: 'a QWERTY tombstone gets its author back and stays deleted',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([{ ...QWERTY_V1, uploaderName: '', deletedAt: t(-MIN) }]),
      'in/qwerty.json': label('qwerty', { KC_Q: 'q' }),
    },
    steps: [list, listAll, get('qwerty'), importFiles('in/qwerty.json'), listAll],
  },
  {
    name: 'an import over the QWERTY name overwrites the built-in entry',
    time: T0,
    tree: { 'in/qwerty.json': label(' Qwerty ', { KC_Q: 'q' }, { composite_labels: { KC_W: 'w' } }), ...EXPORTS },
    steps: [list, importFiles('in/qwerty.json'), list, get('qwerty'), exportTo('qwerty', 'exports/qwerty.json')],
  },
  {
    name: 'duplicate ids and names that are not strings',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        { ...QWERTY_V1, uploaderName: 'pipette' },
        v1('dup', 'First', 'dup_first.json'),
        v1('dup', 'Second', 'dup_second.json'),
        v1('n', 5, 'n_n.json'),
        v1('nul', null, 'nul_nul.json'),
        { id: 'u', filename: 'u_u.json', savedAt: t(-MIN) },
      ]),
      [`${DIR}/dup_first.json`]: label('First'),
      [`${DIR}/dup_second.json`]: label('Second'),
      [`${DIR}/n_n.json`]: label('N'),
      [`${DIR}/nul_nul.json`]: label('Nul'),
      [`${DIR}/u_u.json`]: label('U'),
      ...EXPORTS,
      'in/zzz.json': label('Zzz'),
    },
    steps: [
      hasName('first'),
      hasName('second'),
      hasName('zzz'),
      get('dup'),
      get('n'),
      get('nul'),
      get('u'),
      exportTo('n', 'exports/n.json'),
      exportTo('nul', 'exports/nul.json'),
      exportTo('u', 'exports/u.json'),
      rename('dup', 'zzz'),
      importFiles('in/zzz.json'),
      hub('n', 'p'),
      reorder(['n', 'dup']),
      listAll,
    ],
  },
  {
    name: 'body files that are unsafe, missing or malformed',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        { ...QWERTY_V1, uploaderName: 'pipette' },
        v1('up', 'Up', '../escape.json'),
        v1('none', 'None', 'missing_none.json'),
        v1('not-json', 'Not JSON', 'not-json_x.json'),
        v1('bad-map', 'Bad map', 'bad-map_x.json'),
        v1('bad-composite', 'Bad composite', 'bad-composite_x.json'),
        v1('aliases', 'Renamed in the index', 'aliases_x.json'),
        v1('array', 'Array', 'array_x.json'),
        v1('empty', 'Empty', ''),
        { id: 'no-file', name: 'No file', savedAt: t(0) },
      ]),
      'sync/escape.json': label('Up'),
      [`${DIR}/not-json_x.json`]: 'nope',
      [`${DIR}/bad-map_x.json`]: label('Bad map', { KC_A: ['A'] }),
      [`${DIR}/bad-composite_x.json`]: label('Bad composite', {}, { composite_labels: 5 }),
      [`${DIR}/aliases_x.json`]: label('Aliases', { KC_A: 'A' }, { extra: 1, composite_labels: { KC_B: 'B' }, keymap_applicable: true, keymapApplicable: null, name: 'Last name' }),
      [`${DIR}/array_x.json`]: '["name","map"]',
      ...EXPORTS,
    },
    steps: [
      ...['up', 'none', 'not-json', 'bad-map', 'bad-composite', 'aliases', 'array', 'empty', 'no-file']
        .flatMap((id) => [get(id), exportTo(id, `exports/${id}.json`)]),
      del('none'),
      at(MIN),
      importFiles(),
      listAll,
    ],
  },
  { name: 'an index that is not JSON', time: T0, tree: { [`${DIR}/index.json`]: 'not json!!!' }, steps: [get('x'), list, listAll] },
  { name: 'an index that is null', time: T0, tree: { [`${DIR}/index.json`]: 'null' }, steps: [list] },
  { name: 'an index that is an array', time: T0, tree: { [`${DIR}/index.json`]: '[{"entries":[]}]' }, steps: [list] },
  { name: 'an index without an entries list', time: T0, tree: { [`${DIR}/index.json`]: '{"keep":1,"entries":{"0":{"id":"x"}}}' }, steps: [list] },
  { name: 'an index with a byte order mark', time: T0, tree: { [`${DIR}/index.json`]: '﻿{"entries":[]}' }, steps: [list] },
  {
    name: 'invalid UTF-8 in the index',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: { hex: Buffer.concat([Buffer.from('{"entries":[{"id":"x","name":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","filename":"x_x.json","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [`${DIR}/x_x.json`]: label('X'),
    },
    steps: [hasName('bad ��'), list, get('x'), rename('x', 'Good')],
  },
  {
    name: 'a save over the index keeps no other top-level field, a rename keeps them',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([{ ...QWERTY_V1, uploaderName: 'pipette' }, v1('a', 'A', 'a_a.json')], { version: 9 }),
      [`${DIR}/a_a.json`]: label('A'),
      'in/b.json': label('B'),
    },
    steps: [rename('a', 'A2'), importFiles('in/b.json'), rename('a', 'A3')],
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
  const ev = { sender: {} }
  switch (step.op) {
    case 'list': return handler(IpcChannels.KEY_LABEL_STORE_LIST)(ev)
    case 'listAll': return handler(IpcChannels.KEY_LABEL_STORE_LIST_ALL)(ev)
    case 'get': return handler(IpcChannels.KEY_LABEL_STORE_GET)(ev, step.id)
    case 'rename': return handler(IpcChannels.KEY_LABEL_STORE_RENAME)(ev, step.id, step.name)
    case 'delete': return handler(IpcChannels.KEY_LABEL_STORE_DELETE)(ev, step.id)
    case 'hubPostId': return handler(IpcChannels.KEY_LABEL_STORE_SET_HUB_POST_ID)(ev, step.id, step.hubPostId)
    case 'reorder': return handler(IpcChannels.KEY_LABEL_STORE_REORDER)(ev, step.ids)
    case 'hasName': return handler(IpcChannels.KEY_LABEL_STORE_HAS_NAME)(ev, step.name, step.excludeId)
    case 'import': return handler(IpcChannels.KEY_LABEL_STORE_IMPORT)(ev)
    case 'export': return handler(IpcChannels.KEY_LABEL_STORE_EXPORT)(ev, step.id)
  }
}

/** `error` with the texts the crate does not copy replaced. */
function recordedError(error: string): string {
  if (/^Error: E[A-Z]+:/.test(error)) return '<os error>'
  if (error.startsWith('SyntaxError: ')) return '<parse error>'
  return error
}

/** The response as JSON text, with the texts the crate does not copy replaced. */
function outcome(response: unknown, dir: string): string | null {
  const text = JSON.stringify(response, (key, value: unknown) => {
    if (key === 'error' && typeof value === 'string') return recordedError(value)
    if (key === 'filePath' && typeof value === 'string') return value.replace(dir, '<userData>')
    return value
  })
  return text ?? null
}

interface Played {
  outcomes: (string | null)[]
  /** The options of the dialogs each step showed. */
  dialogs: Record<string, unknown>[][]
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
    const shown: Record<string, unknown>[][] = []
    for (const step of scenario.steps) {
      dialogs.shown = []
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push(null)
        shown.push([])
        continue
      }
      dialogs.answer = step.op === 'import' ? step.dialog : step.op === 'export' && step.dialog !== null ? [step.dialog] : null
      outcomes.push(outcome(await run(step), dir))
      shown.push(dialogs.shown)
    }
    return { outcomes, dialogs: shown, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('key label store fixtures', () => {
  it('records each scenario’s responses, dialogs, notified units and files', async () => {
    setupKeyLabelStore()
    root = mkdtempSync(join(tmpdir(), 'key-label-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const fresh = results[0]
    expect(fresh.outcomes[2]).toContain('"id":"qwerty"')
  })
})
