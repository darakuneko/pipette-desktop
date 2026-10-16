// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the Aozora Bunko import of
// src-tauri/crates/pipette-typing-datasets: runs the real AOZORA_IMPORT
// handler of src/main/aozora/aozora-ipc.ts, with the real language store
// (the catalog from local/typing-test-dataset.json) and typing test text
// store behind it, on a userData directory built in a temp directory, at a
// fixed time, with a fixed sequence of new ids and `net.fetch` answering
// from recorded replies (small Shift_JIS zips). It records each step's
// response, the URLs fetched, the sync units reported to notifyChange, and
// every file and directory left behind (path → content).
//
// A rejected call is recorded as `{"rejected": <message>}`.
//
// Runs under Electron acting as Node (see the generate:typing-text-fixtures
// script), so the zips decode with Electron's TextDecoder('shift_jis').
//
// Run: pnpm run generate:typing-text-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { shiftJisEncoder, zip } from './aozora-cases'
import { AOZORA_SAMPLE } from './text-cases'

/** A recorded HTTP reply: a body in hex, or a rejected fetch. */
type Reply = { status: number; hex: string } | { error: string }

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: { userData: '', replies: [] as Reply[], urls: [] as string[], notified: [] as string[], nextId: 1 },
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  net: {
    fetch: async (url: string) => {
      state.urls.push(url)
      const reply = state.replies.shift()
      if (!reply) throw new Error(`no reply recorded for ${url}`)
      if ('error' in reply) throw new Error(reply.error)
      return new Response(Buffer.from(reply.hex, 'hex'), { status: reply.status })
    },
  },
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => state.notified.push(unit) }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  /** The ids the crate's tests hand out: `00000000-0000-4000-8000-{n:012}`. */
  const randomUUID = (): string => `00000000-0000-4000-8000-${String(state.nextId++).padStart(12, '0')}`
  return { ...actual, default: { ...actual, randomUUID }, randomUUID }
})

import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-typing-datasets/tests/fixtures/ts_aozora_import_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

interface Step {
  op: 'import'
  /** The argument as the renderer sent it; absent for no argument. */
  workId?: unknown
  replies: Reply[]
}

interface Scenario {
  name: string
  time: string
  tree: Tree
  steps: Step[]
}

const T0 = '2026-10-16T12:00:00.000Z'
const BASE = 'https://hub.example/aozora/cards'
const OVERRIDES = 'local/typing-test-dataset.json'
const TEXTS = 'sync/typing-test-texts'

const encode = shiftJisEncoder((bytes) => new TextDecoder('shift_jis').decode(bytes))
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)
/** A zip of one Shift_JIS `work.txt`, its text after a blank line so the
 *  cleaning keeps it whole. */
const workZip = (text: string): Uint8Array => zip({ 'work.txt': encode(`\r\n${text}\r\n`) })

const SAMPLE = zip({ 'dir/work.txt': encode(AOZORA_SAMPLE.replaceAll('\n', '\r\n')) })
const KANA = workZip('あいうえお　かきくけこ')
const PLAIN = workZip('本文の一行目。\r\n二行目。')
const NOT_A_ZIP = ascii('This is not a zip file, just some text that is long enough.')
const NO_TEXT = zip({ 'image.png': new Uint8Array([1, 2, 3]), '__MACOSX/work.txt': encode('x') })
const UNMAPPED = zip({ 'work.txt': new Uint8Array(100).fill(0xa0) })
const TITLE_ONLY = zip({ 'work.txt': ascii('OnlyTitleLine') })
const GAIJI = workZip('前※［＃U+110000］後')

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const ok = (bytes: Uint8Array): Reply => ({ status: 200, hex: hex(bytes) })
const status = (code: number): Reply => ({ status: code, hex: '' })
const offline: Reply = { error: 'net::ERR_INTERNET_DISCONNECTED' }
const importWork = (workId: unknown, replies: Reply[] = []): Step => ({ op: 'import', workId, replies })
const NO_ARGUMENT: Step = { op: 'import', replies: [] }

const entry = (name: string, fileSize: number, extra: Record<string, unknown> = {}) =>
  ({ name, wordCount: 3, rightToLeft: false, fileSize, ...extra })
const catalog = (languages: unknown[], extra: Record<string, unknown> = {}): Tree => ({
  [OVERRIDES]: JSON.stringify({ aozora: { provider: 'aozora', version: 'a1', downloadUrlBase: BASE, languages, ...extra } }),
})

const W1 = '000001/files/1_ruby_1.zip'
const W2 = '000002/files/2_ruby_2.zip'
const W3 = '000003/files/3.zip'
const ID1 = '00000000-0000-4000-8000-000000000001'

const SCENARIOS: Scenario[] = [
  {
    name: 'imports works into the text store',
    time: T0,
    tree: catalog([
      entry(W1, SAMPLE.byteLength, { title: 'タイトル', author: '著者名', authorKana: 'ちょしゃめい' }),
      entry(W2, KANA.byteLength, { title: 'かな' }),
      entry(W3, PLAIN.byteLength, { title: '' }),
      entry('padded', PLAIN.byteLength, { title: '  Padded  ', author: '' }),
      entry(W1, 1, { title: 'Second entry of the same name' }),
    ]),
    steps: [
      importWork(W1, [ok(SAMPLE)]),
      importWork(W2, [ok(KANA)]),
      importWork(W3, [ok(PLAIN)]),
      importWork('padded', [ok(PLAIN)]),
      importWork(W1, [ok(SAMPLE)]),
      importWork(5),
      importWork(''),
      importWork(null),
      NO_ARGUMENT,
      importWork('missing/work.zip'),
    ],
  },
  {
    name: 'download, archive and text failures',
    time: T0,
    tree: catalog([
      entry('size', SAMPLE.byteLength + 1, { title: 'T' }),
      entry('half', 2.5),
      entry('huge', 1e21),
      entry('http', 10),
      entry('server', 10),
      entry('offline', 10),
      entry('not-a-zip', NOT_A_ZIP.byteLength),
      entry('no-text', NO_TEXT.byteLength),
      entry('unmapped', UNMAPPED.byteLength),
      entry('title-only', TITLE_ONLY.byteLength),
      entry('long-name', PLAIN.byteLength, { title: 'a'.repeat(120), author: 'b' }),
      entry('gaiji', GAIJI.byteLength),
      entry('empty-body', 0),
    ]),
    steps: [
      importWork('size', [ok(SAMPLE)]),
      importWork('half', [ok(ascii('xx'))]),
      importWork('huge', [ok(ascii('xx'))]),
      importWork('http', [status(404)]),
      importWork('server', [status(500)]),
      importWork('offline', [offline]),
      importWork('not-a-zip', [ok(NOT_A_ZIP)]),
      importWork('no-text', [ok(NO_TEXT)]),
      importWork('unmapped', [ok(UNMAPPED)]),
      importWork('title-only', [ok(TITLE_ONLY)]),
      importWork('long-name', [ok(PLAIN)]),
      importWork('gaiji', [ok(GAIJI)]),
      importWork('empty-body', [ok(new Uint8Array(0))]),
    ],
  },
  {
    name: 'a deleted text keeps no name from a new import',
    time: T0,
    tree: {
      ...catalog([entry(W1, PLAIN.byteLength, { title: 'タイトル', author: '著者名' })]),
      [`${TEXTS}/index.json`]: JSON.stringify({
        entries: [{
          id: 'old',
          name: 'タイトル（著者名）',
          wordCount: 1,
          lineCount: 1,
          filename: 'old_2026-10-16T11-00-00.000Z.json',
          savedAt: '2026-10-16T11:00:00.000Z',
          updatedAt: '2026-10-16T11:30:00.000Z',
          deletedAt: '2026-10-16T11:30:00.000Z',
          source: { provider: 'aozora', workId: W1 },
        }],
      }, null, 2),
      [`${TEXTS}/old_2026-10-16T11-00-00.000Z.json`]: JSON.stringify({ name: 'タイトル（著者名）', text: 'x' }, null, 2),
    },
    steps: [importWork(W1, [ok(PLAIN)]), importWork(W1, [ok(PLAIN)])],
  },
  {
    name: 'an aozora override that is pack-shaped',
    time: T0,
    tree: catalog([entry(W1, PLAIN.byteLength)], { model: 'pack' }),
    steps: [importWork(W1)],
  },
  {
    name: 'an aozora override without a model is a catalog',
    time: T0,
    tree: catalog([entry(W1, PLAIN.byteLength, { title: 'T', author: 'A' })]),
    steps: [importWork(W1, [ok(PLAIN)])],
  },
  {
    name: 'an override that is not used leaves the empty bundled catalog',
    time: T0,
    tree: catalog([entry(W1, PLAIN.byteLength, { title: null })]),
    steps: [importWork(W1)],
  },
  {
    name: 'the bundled catalog is empty',
    time: T0,
    tree: {},
    steps: [importWork(W1)],
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

/** Loads fresh copies of the handler and the stores behind it, as a new
 *  process would. */
async function start(): Promise<(...args: unknown[]) => Promise<unknown>> {
  vi.resetModules()
  handlers.clear()
  const { setupAozoraIpc } = await import('../../src/main/aozora/aozora-ipc')
  setupAozoraIpc()
  const handler = handlers.get(IpcChannels.AOZORA_IMPORT)
  if (!handler) throw new Error('AOZORA_IMPORT is not registered')
  return handler as (...args: unknown[]) => Promise<unknown>
}

interface Played {
  outcomes: string[]
  urls: string[]
  notified: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string): Promise<Played> {
  state.userData = dir
  state.urls = []
  state.notified = []
  state.nextId = 1
  build(dir, scenario.tree)
  const handler = await start()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: string[] = []
    for (const step of scenario.steps) {
      state.replies = [...step.replies]
      try {
        const args = 'workId' in step ? [step.workId] : []
        outcomes.push(JSON.stringify(await handler({}, ...args)))
      } catch (err) {
        outcomes.push(JSON.stringify({ rejected: (err as Error).message }))
      }
      if (state.replies.length > 0) {
        throw new Error(`${scenario.name}: ${state.replies.length} replies left after ${JSON.stringify(step)}`)
      }
    }
    return { outcomes, urls: [...state.urls], notified: [...state.notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('Aozora import fixtures', () => {
  it('runs under Electron', () => {
    expect(process.versions.electron).toBeDefined()
  })

  it('records each scenario’s responses, fetched URLs, notified units and files', async () => {
    root = mkdtempSync(join(tmpdir(), 'aozora-import-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const first = JSON.parse(results[0].outcomes[0]) as { success: boolean; meta?: { id: string } }
    expect(first.success).toBe(true)
    expect(first.meta?.id).toBe(ID1)
    expect(results[0].urls[0]).toBe(`${BASE}/${W1}`)
    expect(results[1].outcomes.at(-2)).toContain('rejected')
  })
})
