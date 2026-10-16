// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the language store of
// src-tauri/crates/pipette-typing-datasets: runs the real LANG_* and
// TYPING_DATASET_* handlers of src/main/language-store.ts on a userData
// directory built in a temp directory, with `net.fetch` answering from
// recorded replies. It records each step's response, the URLs fetched,
// and every file and directory left behind (path → content), so the crate
// can replay each scenario and compare the bytes.
//
// Error texts the crate does not copy are recorded in place of the text: a
// file-system error (`Error: ENOENT: …`) as `<os error>`, a `JSON.parse`
// error (`SyntaxError: …`) as `<parse error>`. A rejected call is recorded
// as `{"rejected": <message>}`.
//
// Run: pnpm run generate:typing-dataset-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

/** A recorded HTTP reply: a body as UTF-8 text or hex, or a rejected fetch. */
type Reply = { status: number; body: string } | { status: number; hex: string } | { error: string }

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: { userData: '', replies: [] as Reply[], urls: [] as string[] },
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  net: {
    fetch: async (url: string) => {
      state.urls.push(url)
      const reply = state.replies.shift()
      if (!reply) throw new Error(`no reply recorded for ${url}`)
      if ('error' in reply) throw new Error(reply.error)
      const body = 'hex' in reply ? Buffer.from(reply.hex, 'hex') : Buffer.from(reply.body, 'utf-8')
      return new Response(body, { status: reply.status })
    },
  },
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))

import { IpcChannels } from '../../src/shared/ipc/channels'
import { TYPING_TEST_PROVIDER_DEFAULTS } from '../../src/shared/data/typing-test-providers'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-typing-datasets/tests/fixtures/ts_language_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

type Step =
  | { op: 'list'; provider?: string }
  | { op: 'get'; name: string; provider?: string }
  | { op: 'download'; name: string; provider?: string; replies: Reply[] }
  | { op: 'delete'; name: string; provider?: string }
  | { op: 'check'; provider?: string; replies: Reply[] }
  | { op: 'update'; provider?: string; replies: Reply[] }
  /** A new process on the same userData: the caches are gone and the
   *  legacy download move runs again. */
  | { op: 'restart' }

interface Scenario {
  name: string
  tree: Tree
  steps: Step[]
}

const HUB = 'https://pipette-hub-worker.keymaps.workers.dev'
const BASE = 'https://hub.example/languages'
const LANG = 'local/downloads/languages'
const OVERRIDES = 'local/typing-test-dataset.json'
const MONKEYTYPE = TYPING_TEST_PROVIDER_DEFAULTS[0]
const GERMAN_SIZE = MONKEYTYPE.languages.find((e) => e.name === 'german')!.fileSize

const ok = (data: unknown): Reply => ({ status: 200, body: JSON.stringify({ ok: true, data }) })
const version = (provider: string, v: string): Reply => ok({ provider, version: v })
const status = (code: number): Reply => ({ status: code, body: '' })
const offline: Reply = { error: 'net::ERR_INTERNET_DISCONNECTED' }

/** `text` padded with spaces to `size` UTF-8 bytes. */
function padded(text: string, size: number): string {
  const length = Buffer.byteLength(text, 'utf-8')
  if (length > size) throw new Error(`${text} is longer than ${size} bytes`)
  return text + ' '.repeat(size - length)
}

const entry = (name: string, fileSize: number, extra: Record<string, unknown> = {}) =>
  ({ name, wordCount: 3, rightToLeft: false, fileSize, ...extra })
const dataset = (provider: string, v: string, languages: unknown[], extra: Record<string, unknown> = {}) =>
  ({ provider, version: v, downloadUrlBase: BASE, languages, ...extra })

const list = (provider?: string): Step => ({ op: 'list', ...(provider !== undefined ? { provider } : {}) })
const get = (name: string, provider?: string): Step => ({ op: 'get', name, ...(provider !== undefined ? { provider } : {}) })
const del = (name: string, provider?: string): Step => ({ op: 'delete', name, ...(provider !== undefined ? { provider } : {}) })
const download = (name: string, replies: Reply[], provider?: string): Step =>
  ({ op: 'download', name, replies, ...(provider !== undefined ? { provider } : {}) })
const check = (replies: Reply[], provider?: string): Step =>
  ({ op: 'check', replies, ...(provider !== undefined ? { provider } : {}) })
const update = (replies: Reply[], provider?: string): Step =>
  ({ op: 'update', replies, ...(provider !== undefined ? { provider } : {}) })
/** An update whose version probe fails: answers the effective version. */
const currentVersion = (provider?: string): Step => update([status(500)], provider)

const PACK = JSON.stringify({ name: 'pack', words: ['a', 'b', 'c'] })
const SIZE = Buffer.byteLength(PACK, 'utf-8')
const overrides = (value: unknown): Tree => ({ [OVERRIDES]: JSON.stringify(value) })
/** A monkeytype override whose manifest lists `languages`. */
const smallMonkeytype = (languages: unknown[]): Tree =>
  overrides({ monkeytype: dataset('monkeytype', 'v-small', languages) })

const SCENARIOS: Scenario[] = [
  {
    name: 'the bundled defaults',
    tree: {},
    steps: [
      list(),
      list('tatoeba'),
      list('aozora'),
      get('english'),
      get('nonexistent'),
      get('../etc/passwd'),
      get('a\\b'),
      get(''),
      get('english', 'tatoeba'),
      download('english', []),
      download('../etc/passwd', []),
      download('', []),
      download('not_in_manifest', []),
      download('german', [{ status: 200, body: padded(PACK, GERMAN_SIZE) }]),
      get('german'),
      get('german', 'no-such-provider'),
      del('english'),
      del('missing'),
      del('x/y'),
      del('german', '../..'),
      get('german'),
      del('german'),
      get('german'),
      update([version('monkeytype', MONKEYTYPE.version)]),
    ],
  },
  {
    name: 'download failures and what a download writes',
    tree: smallMonkeytype([
      entry('a', SIZE),
      entry('a', 1),
      entry('missing', 10),
      entry('short', 100),
      entry('offline', 10),
      entry('badjson', 8),
      entry('bom', SIZE + 3),
      entry('invalid-utf8', Buffer.byteLength('{"name":"x","words":["ab"]}')),
      entry('empty-words', Buffer.byteLength('{"name":"x","words":[]}')),
      entry('number-word', Buffer.byteLength('{"name":"x","words":["a",1]}')),
      entry('no-name', Buffer.byteLength('{"words":["a"]}')),
      entry('array', 2),
      entry('null', 4),
      entry('half', 2.5),
      entry('huge', 1e21),
      entry('a b?#c', SIZE),
      entry('extra', Buffer.byteLength('{"7":1,"name":"x","words":["w"],"name":"y","z":[1e21]}')),
    ]),
    steps: [
      download('a', [{ status: 200, body: PACK }]),
      download('missing', [status(404)]),
      download('short', [{ status: 200, body: PACK }]),
      download('offline', [offline]),
      download('badjson', [{ status: 200, body: 'not json' }]),
      download('bom', [{ status: 200, hex: 'efbbbf' + Buffer.from(PACK).toString('hex') }]),
      download('invalid-utf8', [{
        status: 200,
        hex: Buffer.concat([Buffer.from('{"name":"x","words":["a'), Buffer.from([0xff]), Buffer.from('"]}')]).toString('hex'),
      }]),
      download('empty-words', [{ status: 200, body: '{"name":"x","words":[]}' }]),
      download('number-word', [{ status: 200, body: '{"name":"x","words":["a",1]}' }]),
      download('no-name', [{ status: 200, body: '{"words":["a"]}' }]),
      download('array', [{ status: 200, body: '[]' }]),
      download('null', [{ status: 200, body: 'null' }]),
      download('half', [{ status: 200, body: 'xx' }]),
      download('huge', [{ status: 200, body: 'xx' }]),
      download('a b?#c', [{ status: 200, body: PACK }]),
      download('extra', [{ status: 200, body: '{"7":1,"name":"x","words":["w"],"name":"y","z":[1e21]}' }]),
      list(),
      get('a'),
      get('bom'),
      get('invalid-utf8'),
      get('a b?#c'),
      get('extra'),
      del('a'),
      list(),
    ],
  },
  {
    name: 'reading downloaded files',
    tree: {
      ...smallMonkeytype([entry('bom', 1), entry('dir', 1), entry('ok', 1)]),
      [`${LANG}/monkeytype/bom.json`]: '﻿{"name":"bom","words":["a"]}',
      [`${LANG}/monkeytype/dir.json/`]: null,
      [`${LANG}/monkeytype/ok.json`]: { hex: Buffer.concat([Buffer.from('{"words":["x'), Buffer.from([0xc3]), Buffer.from('"],"name":"ok","n":-0}')]).toString('hex') },
      [`${LANG}/monkeytype/nowords.json`]: '{"name":"nowords"}',
      [`${LANG}/monkeytype/notjson.json`]: 'not json',
      [`${LANG}/monkeytype/notes.txt`]: 'not a language',
      [`${LANG}/monkeytype/x.json.json`]: '{}',
      [`${LANG}/tatoeba/ok.json`]: '{"name":"tatoeba ok","words":["Hello there."]}',
    },
    steps: [
      list(),
      get('bom'),
      get('dir'),
      get('ok'),
      get('nowords'),
      get('notjson'),
      get('ok', 'tatoeba'),
      del('dir'),
      del('notes'),
      del('x.json'),
      list(),
    ],
  },
  {
    name: 'legacy flat downloads move into the monkeytype directory',
    tree: {
      [`${LANG}/german.json`]: '{"name":"german","words":["hallo"]}',
      [`${LANG}/french.json`]: '{"name":"french","words":["bonjour"]}',
      [`${LANG}/notes.txt`]: 'stays',
      [`${LANG}/folder.json/`]: null,
      [`${LANG}/monkeytype/french.json`]: '{"name":"french","words":["old"]}',
    },
    steps: [get('german'), get('french'), { op: 'restart' }, get('german')],
  },
  {
    name: 'no legacy move when the monkeytype directory cannot be made',
    tree: {
      [`${LANG}/german.json`]: '{"name":"german","words":["hallo"]}',
      [`${LANG}/monkeytype`]: 'a file in the way',
    },
    steps: [get('german'), download('german', [{ status: 200, body: padded(PACK, GERMAN_SIZE) }])],
  },
  {
    name: 'check and update a provider',
    tree: {
      [`${LANG}/monkeytype/german.json`]: '{}',
      [`${LANG}/monkeytype/notes.txt`]: 'kept',
      [`${LANG}/monkeytype/dir.json/`]: null,
      [`${LANG}/tatoeba/english.json`]: '{}',
    },
    steps: [
      check([version('monkeytype', 'v2')]),
      check([]),
      check([], ''),
      update([
        version('monkeytype', 'v2'),
        ok({
          languages: [
            { fileSize: SIZE, name: 'spanish', rightToLeft: false, wordCount: 3, extra: { kept: true } },
            entry('english', 1, { title: 't', author: 'a', authorKana: 'k' }),
          ],
          extra: 'dropped',
          downloadUrlBase: BASE,
          version: 'v2',
          provider: 'monkeytype',
        }),
      ]),
      check([]),
      list(),
      get('english'),
      download('spanish', [{ status: 200, body: PACK }]),
      { op: 'restart' },
      check([version('monkeytype', 'v2')]),
      update([version('monkeytype', 'v3'), ok(dataset('monkeytype', 'v3', [], { model: 'pack' }))]),
      update([version('tatoeba', 't1'), ok(dataset('tatoeba', 't1', [entry('english', SIZE)]))], 'tatoeba'),
      list('tatoeba'),
    ],
  },
  {
    name: 'updates that change nothing',
    tree: {},
    steps: [
      update([version('monkeytype', MONKEYTYPE.version)]),
      update([status(500)]),
      update([offline]),
      update([{ status: 200, body: 'not json' }]),
      update([{ status: 200, hex: 'efbbbf' + Buffer.from(JSON.stringify({ ok: true, data: { version: 'bom' } })).toString('hex') }]),
      update([{ status: 200, body: 'null' }]),
      update([{ status: 200, body: '"text"' }]),
      update([{ status: 200, body: JSON.stringify({ ok: false, data: { version: 'v2' } }) }]),
      update([{ status: 200, body: JSON.stringify({ ok: true, data: { version: 2 } }) }]),
      update([{ status: 200, body: JSON.stringify({ ok: true, data: null }) }]),
      update([version('monkeytype', 'v2'), status(404)]),
      update([version('monkeytype', 'v2'), offline]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', MONKEYTYPE.version, []))]),
      update([version('monkeytype', 'v2'), ok(dataset('evil', 'v2', []))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [], { downloadUrlBase: 'http://hub.example/x' }))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [], { model: 'bogus' }))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [], { model: null }))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [entry('x', 1, { title: 5 })]))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [entry('x', 1, { authorKana: null })]))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [{ name: 'x', wordCount: 1, rightToLeft: 0, fileSize: 1 }]))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [null]))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [], { languages: {} }))]),
      update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', [], { version: 3 }))]),
      update([version('monkeytype', 'v2'), { status: 200, body: JSON.stringify({ ok: true, data: [] }) }]),
      check([status(503)]),
      check([offline]),
      check([version('monkeytype', 'v2')]),
      check([]),
    ],
  },
  {
    name: 'a truthy ok and the key order of what an update writes',
    tree: {},
    steps: [
      update([
        { status: 200, body: JSON.stringify({ data: { version: 'v2' }, ok: 1 }) },
        { status: 200, body: JSON.stringify({ ok: 'yes', data: { languages: [{ '1': 'one', fileSize: 2, name: 'n', wordCount: -0, rightToLeft: true }], model: 'catalog', downloadUrlBase: 'https://x', version: 'v2', provider: 'monkeytype' } }) },
      ]),
      list(),
      download('n', []),
    ],
  },
  {
    name: 'the overrides of other providers are kept',
    tree: {
      [OVERRIDES]: JSON.stringify({
        foo: { anything: [1, 2] },
        tatoeba: dataset('tatoeba', 't0', [entry('english', 1)]),
        monkeytype: { version: 5 },
        7: 'seven',
        custom: dataset('custom', 'c1', [entry('x', 1)]),
        'a b/é': dataset('a b/é', 'e1', []),
      }),
      [`${LANG}/custom/x.json`]: '{"name":"x","words":["w"]}',
    },
    steps: [
      currentVersion(),
      list('tatoeba'),
      update([version('tatoeba', 't1'), ok(dataset('tatoeba', 't1', [entry('german', 2)]))], 'tatoeba'),
      list('tatoeba'),
      download('x', [], 'custom'),
      check([version('custom', 'c2')], 'custom'),
      update([version('custom', 'c2'), ok(dataset('custom', 'c2', []))], 'custom'),
      check([version('a b/é', 'e2')], 'a b/é'),
      check([], 'nope'),
      update([], 'nope'),
      update([], '7'),
      { op: 'restart' },
      currentVersion('tatoeba'),
      currentVersion('custom'),
    ],
  },
  {
    name: 'an overrides file that is an array',
    tree: { [OVERRIDES]: JSON.stringify([{ a: 1 }, 'b']) },
    steps: [currentVersion(), update([version('monkeytype', 'v2'), ok(dataset('monkeytype', 'v2', []))])],
  },
  ...['﻿{"tatoeba":{}}', 'null', '"text"', '5', 'not json', '{"tatoeba":1,'].map((content) => ({
    name: `an overrides file that is not an object: ${JSON.stringify(content)}`,
    tree: { [OVERRIDES]: content },
    steps: [currentVersion('tatoeba'), update([version('tatoeba', 't1'), ok(dataset('tatoeba', 't1', []))], 'tatoeba')],
  })),
  {
    name: 'overrides that are not used',
    tree: overrides({
      monkeytype: dataset('monkeytype', 'm1', [], { downloadUrlBase: 'http://hub.example/x' }),
      tatoeba: dataset('tatoeba', 't1', [], { model: 'bogus' }),
      aozora: dataset('aozora', 'a1', [entry('x', 1, { title: null })]),
    }),
    steps: [currentVersion(), currentVersion('tatoeba'), currentVersion('aozora'), list('aozora')],
  },
  ...[
    { version: 1 },
    { downloadUrlBase: 5 },
    { downloadUrlBase: 'HTTPS://hub.example' },
    { languages: 'x' },
    { languages: [{ name: 'x', wordCount: '1', rightToLeft: false, fileSize: 1 }] },
    { languages: [{ name: 'x', wordCount: 1, rightToLeft: false }] },
  ].map((patch) => ({
    name: `an invalid override: ${JSON.stringify(patch)}`,
    tree: overrides({ tatoeba: dataset('tatoeba', 't1', [], patch) }),
    steps: [currentVersion('tatoeba'), list('tatoeba')],
  })),
  {
    name: 'catalog datasets',
    tree: overrides({
      aozora: dataset('aozora', 'a1', [entry('001257/files/x.zip', 10, { title: 'タイトル', author: '著者', authorKana: 'ちょしゃ' }), entry('work', 10)]),
      monkeytype: dataset('monkeytype', 'm1', [entry('work', SIZE)], { model: 'catalog' }),
      tatoeba: dataset('tatoeba', 't1', [entry('work', SIZE)], { model: 'pack' }),
    }),
    steps: [
      list('aozora'),
      get('work', 'aozora'),
      download('work', [], 'aozora'),
      del('work', 'aozora'),
      download('work', []),
      get('work'),
      del('work'),
      download('work', [{ status: 200, body: PACK }], 'tatoeba'),
      get('work', 'tatoeba'),
    ],
  },
  {
    name: 'an aozora override without a model is a catalog',
    tree: overrides({ aozora: dataset('aozora', 'a1', [entry('work', 10)]) }),
    steps: [download('work', [], 'aozora'), list('aozora')],
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

/** Loads a fresh copy of the store, as a new process would, and registers
 *  its handlers (which starts the legacy download move). */
async function start(): Promise<void> {
  vi.resetModules()
  handlers.clear()
  const { setupLanguageStore } = await import('../../src/main/language-store')
  setupLanguageStore()
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

async function run(step: Exclude<Step, { op: 'restart' }>): Promise<unknown> {
  const ev = {}
  switch (step.op) {
    case 'list': return handler(IpcChannels.LANG_LIST)(ev, step.provider)
    case 'get': return handler(IpcChannels.LANG_GET)(ev, step.name, step.provider)
    case 'download': return handler(IpcChannels.LANG_DOWNLOAD)(ev, step.name, step.provider)
    case 'delete': return handler(IpcChannels.LANG_DELETE)(ev, step.name, step.provider)
    case 'check': return handler(IpcChannels.TYPING_DATASET_CHECK)(ev, step.provider)
    case 'update': return handler(IpcChannels.TYPING_DATASET_UPDATE)(ev, step.provider)
  }
}

/** The response as JSON text, with the error texts the crate does not copy
 *  replaced. */
function outcome(response: unknown): string {
  const r = response as { error?: unknown }
  if (typeof r?.error === 'string' && /^Error: E[A-Z]+:/.test(r.error)) {
    return JSON.stringify({ ...r, error: '<os error>' })
  }
  if (typeof r?.error === 'string' && r.error.startsWith('SyntaxError: ')) {
    return JSON.stringify({ ...r, error: '<parse error>' })
  }
  return JSON.stringify(response)
}

interface Played {
  outcomes: (string | null)[]
  urls: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string): Promise<Played> {
  state.userData = dir
  state.urls = []
  build(dir, scenario.tree)
  await start()
  const outcomes: (string | null)[] = []
  for (const step of scenario.steps) {
    if (step.op === 'restart') {
      await start()
      outcomes.push(null)
      continue
    }
    state.replies = 'replies' in step ? [...step.replies] : []
    try {
      outcomes.push(outcome(await run(step)))
    } catch (err) {
      outcomes.push(JSON.stringify({ rejected: (err as Error).message }))
    }
    if (state.replies.length > 0) {
      throw new Error(`${scenario.name}: ${state.replies.length} replies left after ${JSON.stringify(step)}`)
    }
  }
  return { outcomes, urls: [...state.urls], after: record(dir) }
}

describe('language store fixtures', () => {
  it('records each scenario’s responses, fetched URLs and files', async () => {
    root = mkdtempSync(join(tmpdir(), 'language-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    expect(results[0].urls[0]).toBe(`${MONKEYTYPE.downloadUrlBase}/german.json`)
    expect(results.some((r) => r.urls.some((url) => url.startsWith(`${HUB}/api/typing-test/datasets/`)))).toBe(true)
  })
})
