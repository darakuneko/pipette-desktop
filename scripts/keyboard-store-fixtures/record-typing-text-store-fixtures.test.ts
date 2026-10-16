// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the typing test text store of
// src-tauri/crates/pipette-keyboard-stores: runs the real TYPING_TEST_TEXT_*
// handlers of src/main/typing-test-text-ipc.ts, and the store's own
// saveRecord / listAllMetas (the catalog import and the sync side use them),
// on a userData directory built in a temp directory, at fixed times and
// with a fixed sequence of new ids. Each scenario loads the store afresh,
// so the romajiCapable cache and the import held for confirmation start
// empty. The import dialog answers a path under userData (or is
// cancelled). It records each step's response, the dialogs shown, the sync
// units reported to notifyChange, and every file and directory left behind
// (path → content).
//
// Texts the crate does not copy are recorded as placeholders: a file-system
// error's (the OS's and Node's) as `<os error>`, and a JSON.parse error's
// (V8's) as `<parse error>`.
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
  /** The path the next dialog answers, under userData; null cancels it.
   *  `shown` records the options of every dialog of the step. */
  dialogs: { answer: null as string | null, shown: [] as Record<string, unknown>[] },
}))

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: {
    showOpenDialog: (_win: unknown, options: Record<string, unknown>) => {
      dialogs.shown.push(options)
      const filePaths = dialogs.answer === null ? [] : [`${paths.userData}/${dialogs.answer}`]
      return Promise.resolve({ canceled: filePaths.length === 0, filePaths })
    },
  },
}))
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

import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_typing_text_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

interface SaveInput {
  id?: string
  name: string
  text: string
  source?: { provider: string; workId: string }
  keepCurrentName?: boolean
}

type Step =
  | { op: 'list' }
  | { op: 'get'; id: unknown }
  | { op: 'rename'; id: unknown; name: unknown }
  | { op: 'delete'; id: unknown }
  /** The dialog answers `dialog` (a path under userData), or is cancelled. */
  | { op: 'import'; dialog: string | null }
  | { op: 'confirm' }
  /** The store's `saveRecord`, which the catalog import calls. */
  | { op: 'save'; input: SaveInput }
  /** The store's `listAllMetas`, tombstones included. */
  | { op: 'listAll' }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }
  /** A file under userData is written: `content`, or `size` bytes of `unit` repeated. */
  | { op: 'write'; path: string; content: string }
  | { op: 'fill'; path: string; size: number; unit: string }
  | { op: 'remove'; path: string }

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
/** The body file a save at `time` gives the entry `id`. */
const body = (id: string, time = T0): string => `${DIR}/${id}_${time.replace(/:/g, '-')}.json`

const DIR = 'sync/typing-test-texts'
const v1 = (id: string, name: unknown, filename: string, extra: Record<string, unknown> = {}) => ({
  id, name, wordCount: 1, lineCount: 1, filename, savedAt: t(-60 * MIN), ...extra,
})
const text = (name: unknown, content: unknown): string => JSON.stringify({ name, text: content })

const list: Step = { op: 'list' }
const listAll: Step = { op: 'listAll' }
const confirm: Step = { op: 'confirm' }
const get = (id: unknown): Step => ({ op: 'get', id })
const rename = (id: unknown, name: unknown): Step => ({ op: 'rename', id, name })
const del = (id: unknown): Step => ({ op: 'delete', id })
const importFile = (dialog: string | null): Step => ({ op: 'import', dialog })
const save = (input: SaveInput): Step => ({ op: 'save', input })
const write = (path: string, content: string): Step => ({ op: 'write', path, content })

/** 99 and 98 `a`s and an emoji (two UTF-16 units): 101 and 100 units. */
const NAME_101 = `${'a'.repeat(99)}😀`
const NAME_100 = `${'b'.repeat(98)}😀`
/** JavaScript's `\s` (U+00A0, U+2028, U+FEFF, U+3000) next to characters it
 *  does not count (U+0085, U+200B). */
const SPACES = 'a b c\u0085d​e﻿f　g\u000bh\u000ci'
/** Seven one-letter words a line, 5,003 words: past the 5,000-word cap
 *  mid-line. */
const MANY_WORDS = Array.from({ length: 5003 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${i % 7 === 6 ? '\n' : ' '}`).join('')
const LIMIT = 5 * 1024 * 1024

const SCENARIOS: Scenario[] = [
  {
    name: 'a fresh store imports, reads, renames and deletes',
    time: T0,
    tree: { 'in/poem.txt': 'roses are red\nviolets  are blue' },
    steps: [
      list,
      get('x'),
      get(5),
      rename(5, 'x'),
      rename('x', 5),
      del(null),
      confirm,
      importFile(null),
      importFile('in/poem.txt'),
      list,
      get(uuid(1)),
      at(MIN),
      rename(uuid(1), '  Poem 2 '),
      rename(uuid(1), ' '),
      rename(uuid(1), NAME_101),
      rename(uuid(1), NAME_100),
      rename('missing', 'x'),
      importFile('in/poem.txt'),
      rename(uuid(2), NAME_100.toUpperCase()),
      at(2 * MIN),
      del(uuid(1)),
      del(uuid(1)),
      del('missing'),
      get(uuid(1)),
      rename(uuid(1), 'Back'),
      list,
      listAll,
    ],
  },
  {
    name: 'imports of files of every kind',
    time: T0,
    tree: {
      'in/bom.txt': '﻿hello world',
      'in/double-bom.txt': '﻿﻿x y',
      'in/crlf.txt': 'def f() {\r\n  return 1\r\n\r\n}\r\n',
      'in/cr.txt': 'a\rb  c\r\r',
      'in/kana.txt': 'こんにちは せかい\nありがとう',
      'in/kanji.txt': '漢字 かな',
      'in/words.txt': MANY_WORDS,
      'in/spaces.txt': SPACES,
      'in/blank.txt': '  \n\t 　\n',
      'in/empty.txt': '',
      'in/sjis.txt': { hex: '82a082a2' },
      'in/surrogate.txt': { hex: '61eda08062' },
      'in/.hidden': 'dot file',
      'in/a.b.c': 'dotted',
      'in/  spaced  .txt': 'spaced',
      'in/dot.': 'dot',
      [`in/${NAME_101}.txt`]: 'long',
      'in/dir/': null,
    },
    steps: [
      ...['bom.txt', 'double-bom.txt', 'crlf.txt', 'cr.txt', 'kana.txt', 'kanji.txt', 'words.txt', 'spaces.txt',
        'blank.txt', 'empty.txt', 'sjis.txt', 'surrogate.txt', '.hidden', 'a.b.c', '  spaced  .txt', 'dot.',
        `${NAME_101}.txt`, 'dir', 'missing.txt'].map((name) => importFile(`in/${name}`)),
      { op: 'fill', path: 'in/limit.txt', size: LIMIT, unit: 'ab ' },
      { op: 'fill', path: 'in/over.txt', size: LIMIT + 1, unit: 'ab ' },
      importFile('in/limit.txt'),
      importFile('in/over.txt'),
      { op: 'remove', path: 'in/limit.txt' },
      { op: 'remove', path: 'in/over.txt' },
      list,
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => get(uuid(n))),
    ],
  },
  {
    name: 'a same-named import waits for the confirmation',
    time: T0,
    tree: {
      'in/doc.txt': 'one two',
      'in/DOC.TXT': 'three four five',
      'in/other.txt': 'x',
      'in/ΣΑΣ.txt': 'sigma',
      'in/σας.txt': 'final sigma',
    },
    steps: [
      importFile('in/doc.txt'),
      at(MIN),
      write('in/doc.txt', 'one two three'),
      importFile('in/doc.txt'),
      list,
      rename(uuid(1), 'Renamed'),
      confirm,
      confirm,
      importFile('in/DOC.TXT'),
      importFile('in/DOC.TXT'),
      importFile('in/other.txt'),
      confirm,
      importFile('in/DOC.TXT'),
      at(2 * MIN),
      del(uuid(2)),
      confirm,
      importFile('in/ΣΑΣ.txt'),
      importFile('in/σας.txt'),
      importFile('in/doc.txt'),
      importFile('in/other.txt'),
      confirm,
      listAll,
      get(uuid(2)),
    ],
  },
  {
    name: 'saves from a catalog, with an id and with the current name kept',
    time: T0,
    tree: {},
    steps: [
      save({ name: '作品（作者）', text: 'かな カナ\nひらがな', source: { provider: 'aozora', workId: '001257/files/59898_ruby_70679.zip' } }),
      save({ id: uuid(1), name: 'Other', text: 'kanji 漢字', keepCurrentName: true }),
      save({ id: 'custom-id', name: 'Custom', text: 'a b' }),
      save({ name: 'custom', text: 'x' }),
      save({ name: '   ', text: 'x' }),
      save({ name: 'Blank', text: ' \n ' }),
      save({ name: NAME_101, text: 'x' }),
      save({ name: 'Lone \ud800', text: 'a\ud800b c\udc00 😀\n\ud83d' }),
      save({ name: 'Spaces', text: SPACES }),
      save({ name: 'Many', text: MANY_WORDS }),
      at(MIN),
      save({ id: 'custom-id', name: 'Custom 2', text: 'c', source: { provider: 'aozora', workId: 'w' } }),
      save({ id: 'custom-id', name: 'Ignored', text: 'c d', keepCurrentName: true }),
      del('custom-id'),
      at(2 * MIN),
      save({ id: 'custom-id', name: 'Revived', text: 'd', keepCurrentName: true }),
      save({ id: 'new-id', name: 'New', text: 'e', keepCurrentName: true }),
      list,
      listAll,
      get(uuid(1)),
      get('custom-id'),
      get(uuid(2)),
    ],
  },
  {
    name: 'a v1 index with legacy names, sources of every shape and unknown fields',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: '{\n  "version": 3,\n  "entries": [\n'
        + [
          JSON.stringify(v1('a', 'Legacy A', '2026-10-16T11-00-00.000Z.json', { source: { provider: 'aozora', workId: 'w1', extra: 1 }, note: 'kept' })),
          JSON.stringify(v1('b', 'Legacy B', '2026-10-16T11-00-00.000Z.json', { source: { workId: 'w2', provider: 'aozora' } })),
          JSON.stringify(v1('c', 'Bad source', 'c_c.json', { source: { provider: 'aozora', workId: 5 } })),
          JSON.stringify(v1('d', 'String source', 'd_d.json', { source: 'aozora' })),
          JSON.stringify(v1('e', 'Null source', 'e_e.json', { source: null })),
          JSON.stringify(v1('f', 'Array source', 'f_f.json', { source: ['aozora', 'w'] })),
          JSON.stringify(v1('gone', 'Gone', 'gone_g.json', { deletedAt: t(-10 * MIN) })),
          '"a string entry"', 'null', '{"name":"no id"}',
          JSON.stringify(v1('up', 'Up', '../escape.json')),
          JSON.stringify(v1('missing', 'Missing', 'missing_m.json')),
          JSON.stringify(v1('notjson', 'Not JSON', 'notjson_n.json')),
          JSON.stringify(v1('array', 'Array', 'array_a.json')),
          JSON.stringify(v1('numtext', 'Num text', 'numtext_n.json')),
          JSON.stringify(v1('noname', 'No name body', 'nnb_x.json')),
          JSON.stringify(v1('lone', 'Lone', 'lone_l.json')),
          JSON.stringify({ id: 'nofile', name: 'No file', savedAt: t(0) }),
          JSON.stringify({
            note: 'first', id: 'future', name: 'Future', wordCount: 1, filename: 'future_2030-01-01T00-00-00.000Z.json',
            savedAt: '2030-01-01T00:00:00.000Z',
            clocks: { created: '2030-01-01T00:00:00.000Z', body: '2030-01-01T00:00:00.000Z', name: '2030-01-02T00:00:00.000Z', hub: 'x' },
            updatedAt: '2031-01-01T00:00:00.000Z',
          }),
        ].map((line) => `    ${line}`).join(',\n')
        + '\n  ],\n  "after": "dropped by a write"\n}\n',
      [`${DIR}/2026-10-16T11-00-00.000Z.json`]: text('Legacy', 'かな'),
      [`${DIR}/c_c.json`]: text('C', 'c'),
      [`${DIR}/d_d.json`]: text('D', 'カタカナ'),
      [`${DIR}/e_e.json`]: text('E', 'e'),
      [`${DIR}/f_f.json`]: text('F', 'f'),
      [`${DIR}/gone_g.json`]: text('Gone', 'g'),
      'sync/escape.json': text('Up', 'up'),
      [`${DIR}/notjson_n.json`]: 'nope',
      [`${DIR}/array_a.json`]: '["name","text"]',
      [`${DIR}/numtext_n.json`]: '{"name":"x","text":5}',
      [`${DIR}/nnb_x.json`]: '{"text":"かな"}',
      [`${DIR}/lone_l.json`]: '{"name":"Lone","text":"\\ud800 \\u3042"}',
      [`${DIR}/future_2030-01-01T00-00-00.000Z.json`]: text('Future', 'ふゅーちゃー'),
      'in/legacy b.txt': 'new legacy b',
    },
    steps: [
      list,
      listAll,
      ...['a', 'b', 'c', 'd', 'e', 'f', 'gone', 'up', 'missing', 'notjson', 'array', 'numtext', 'noname', 'lone', 'nofile', 'future'].map(get),
      rename('a', 'A renamed'),
      listAll,
      importFile('in/legacy b.txt'),
      confirm,
      del('c'),
      rename('future', 'Future renamed'),
      listAll,
    ],
  },
  {
    name: 'names that are not strings',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: JSON.stringify({
        entries: [
          v1('nul', null, 'nul_n.json'),
          v1('n', 5, 'n_n.json'),
          { id: 'u', wordCount: 1, filename: 'u_u.json', savedAt: t(-MIN) },
          v1('ok', 'Ok', 'ok_o.json'),
        ],
      }),
      [`${DIR}/nul_n.json`]: text('Nul', 'n'),
      [`${DIR}/n_n.json`]: text('N', 'n'),
      [`${DIR}/u_u.json`]: text('U', 'u'),
      [`${DIR}/ok_o.json`]: text('Ok', 'o'),
      'in/x.txt': 'x',
    },
    steps: [
      list,
      get('nul'),
      get('n'),
      get('u'),
      importFile('in/x.txt'),
      rename('ok', 'Y'),
      save({ name: 'Z', text: 'z' }),
      del('nul'),
      importFile('in/x.txt'),
      del('n'),
      importFile('in/x.txt'),
      del('u'),
      importFile('in/x.txt'),
      listAll,
    ],
  },
  {
    name: 'the current name kept is not a string',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: JSON.stringify({ entries: [v1('k', 7, 'k_k.json')] }),
      [`${DIR}/k_k.json`]: text('K', 'k'),
    },
    steps: [save({ id: 'k', name: 'K', text: 'k', keepCurrentName: true }), save({ id: 'k', name: 'K', text: 'k' }), listAll],
  },
  {
    name: 'romajiCapable is cached by the body filename',
    time: T0,
    tree: { 'in/kana.txt': 'かな' },
    steps: [
      importFile('in/kana.txt'),
      list,
      write(body(uuid(1)), text('x', 'latin')),
      list,
      get(uuid(1)),
      at(MIN),
      rename(uuid(1), 'R'),
      list,
      save({ id: uuid(1), name: 'R', text: 'latin', keepCurrentName: true }),
      list,
      write(body(uuid(1), t(MIN)), text('x', 'かな')),
      list,
      get(uuid(1)),
    ],
  },
  { name: 'an index that is not JSON', time: T0, tree: { [`${DIR}/index.json`]: 'not json!!!', 'in/t.txt': 't' }, steps: [list, get('x'), importFile('in/t.txt')] },
  { name: 'an index that is null', time: T0, tree: { [`${DIR}/index.json`]: 'null' }, steps: [list] },
  { name: 'an index that is an array', time: T0, tree: { [`${DIR}/index.json`]: '[{"entries":[]}]' }, steps: [list] },
  { name: 'an index without an entries list', time: T0, tree: { [`${DIR}/index.json`]: '{"keep":1,"entries":{"0":{"id":"x"}}}', 'in/t.txt': 't' }, steps: [list, importFile('in/t.txt')] },
  {
    name: 'an index with a byte order mark',
    time: T0,
    tree: { [`${DIR}/index.json`]: `﻿${JSON.stringify({ entries: [v1('x', 'X', 'x_x.json')] })}`, [`${DIR}/x_x.json`]: text('X', 'x'), 'in/t.txt': 't' },
    steps: [list, get('x'), importFile('in/t.txt')],
  },
  {
    name: 'invalid UTF-8 in the index',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: { hex: Buffer.concat([Buffer.from('{"entries":[{"id":"x","name":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","filename":"x_x.json","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [`${DIR}/x_x.json`]: text('X', 'x'),
      'in/bad ��.txt': 'b',
    },
    steps: [list, get('x'), importFile('in/bad ��.txt'), rename('x', 'Good')],
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
      const content = bytes.toString('utf-8')
      tree[`${prefix}${name}`] = Buffer.from(content, 'utf-8').equals(bytes) ? content : { hex: bytes.toString('hex') }
    }
  }
  return tree
}

type Store = typeof import('../../src/main/typing-test-text-store')

/** The handlers and the store module, loaded afresh. */
async function loadStore(): Promise<Store> {
  vi.resetModules()
  handlers.clear()
  const { setupTypingTestTextStore } = await import('../../src/main/typing-test-text-ipc')
  setupTypingTestTextStore()
  return import('../../src/main/typing-test-text-store')
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

type Call = Exclude<Step, { op: 'at' | 'write' | 'fill' | 'remove' }>

async function run(step: Call, store: Store): Promise<unknown> {
  const ev = { sender: {} }
  switch (step.op) {
    case 'list': return handler(IpcChannels.TYPING_TEST_TEXT_LIST)(ev)
    case 'get': return handler(IpcChannels.TYPING_TEST_TEXT_GET)(ev, step.id)
    case 'rename': return handler(IpcChannels.TYPING_TEST_TEXT_RENAME)(ev, step.id, step.name)
    case 'delete': return handler(IpcChannels.TYPING_TEST_TEXT_DELETE)(ev, step.id)
    case 'import': return handler(IpcChannels.TYPING_TEST_TEXT_IMPORT)(ev)
    case 'confirm': return handler(IpcChannels.TYPING_TEST_TEXT_IMPORT_CONFIRM)(ev)
    case 'save': return store.saveRecord(step.input)
    case 'listAll': return store.listAllMetas()
  }
}

/** `error` with the texts the crate does not copy replaced. */
function recordedError(error: string): string {
  if (/^Error: E[A-Z]+:/.test(error)) return '<os error>'
  if (error.startsWith('SyntaxError: ')) return '<parse error>'
  return error
}

/** The response as JSON text, with the texts the crate does not copy replaced. */
function outcome(response: unknown): string | null {
  const recorded = JSON.stringify(response, (key, value: unknown) =>
    key === 'error' && typeof value === 'string' ? recordedError(value) : value)
  return recorded ?? null
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
  const store = await loadStore()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: (string | null)[] = []
    const shown: Record<string, unknown>[][] = []
    for (const step of scenario.steps) {
      dialogs.shown = []
      if (step.op === 'at' || step.op === 'write' || step.op === 'fill' || step.op === 'remove') {
        if (step.op === 'at') vi.setSystemTime(new Date(step.time))
        if (step.op === 'write') writeFileSync(join(dir, step.path), step.content)
        if (step.op === 'fill') writeFileSync(join(dir, step.path), step.unit.repeat(Math.ceil(step.size / step.unit.length)).slice(0, step.size))
        if (step.op === 'remove') rmSync(join(dir, step.path))
        outcomes.push(null)
        shown.push([])
        continue
      }
      dialogs.answer = step.op === 'import' ? step.dialog : null
      outcomes.push(outcome(await run(step, store)))
      shown.push(dialogs.shown)
    }
    return { outcomes, dialogs: shown, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('typing test text store fixtures', () => {
  it('records each scenario’s responses, dialogs, notified units and files', async () => {
    root = mkdtempSync(join(tmpdir(), 'typing-text-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const fresh = results[0]
    expect(fresh.outcomes[9]).toContain('"name":"poem"')
  })
})
