// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the run log store of
// src-tauri/crates/pipette-keyboard-stores: runs the real saveRunLog /
// listRunLogs / getRunLog of src/main/typing-run-log-store.ts (the
// TYPING_RUN_LOG_* handlers call them as they are) on a userData directory
// built in a temp directory, at fixed times and with the recording consent
// set per step. It records each step's response, the sync units reported
// to notifyChange, and every file and directory left behind (path →
// content), so the crate can replay each scenario and compare the bytes.
//
// A log crosses to the Tauri backend as the text of JSON.stringify(log), so
// each save step records that text (`logText`, absent for no log) and the
// crate reads the log from it; this records what the handler answers for
// the log itself, NaN and Infinity included. To keep the fixture small,
// `keys` replaces the log's words, after the text is taken, with one word
// of that many keystrokes `{"pressMs":0,"keycode":4,"row":0,"col":1}`, and
// `pad` then adds a `note` of that many `x`.
//
// The handler reads `startedAt` with `new Date(text)`, which also takes the
// forms only V8's fallback parser knows; the crate takes the ECMAScript
// date-time string forms only. The steps marked `v8Only` record the
// handler's answer for such a form, and the crate refuses them instead.
//
// A file-system error's text is the OS's and Node's, and a JSON.parse
// error's V8's, which the crate does not copy: they are recorded as
// `<os error>` and `<syntax error>`.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { type Tree, buildTree, outcomeText, recordTree } from './fixture-tree'

const { notified, paths, consent } = vi.hoisted(() => ({
  notified: [] as string[],
  paths: { userData: '' },
  consent: { accepted: true },
}))

vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => notified.push(unit) }))
vi.mock('../../src/main/app-config', () => ({
  getAppConfigStore: () => ({
    get: (key: string) => (key === 'typingRecordingConsentAccepted' ? consent.accepted : undefined),
  }),
}))

import { getRunLog, listRunLogs, saveRunLog } from '../../src/main/typing-run-log-store'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_run_log_store_scenarios.json')

type Step =
  | { op: 'list'; uid: string }
  | { op: 'save'; uid: string; log?: unknown; keys?: number; pad?: number; v8Only?: true }
  | { op: 'get'; uid: string; runId: string }
  /** The recording consent is set to this. */
  | { op: 'consent'; accepted: boolean }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

interface Scenario {
  name: string
  time: string
  tree: Tree
  steps: Step[]
}

/** A step as recorded: the log of a save as its JSON text. */
type RecordedStep =
  | Exclude<Step, { op: 'save' }>
  | { op: 'save'; uid: string; logText?: string; keys?: number; pad?: number; v8Only?: true }

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })

const UID = '0xA1B2'
const DIR = `sync/keyboards/${UID}/runs`
const index = (entries: unknown[], uid = UID): string => JSON.stringify({ uid, entries }, null, 2)

type Log = Record<string, unknown>

const key = (pressMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ pressMs, keycode: 4, row: 0, col: 1, ...extra })
const word = (index: number, keystrokes: unknown[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ index, display: `w${index}`, typed: `w${index}`, correct: true, keystrokes, ...extra })

/** A valid log of `runId` with four words. */
function log(runId = 'run-1', extra: Log = {}): Log {
  return {
    runId,
    uid: UID,
    startedAt: '2026-10-16T11:59:00.000Z',
    durationMs: 5000,
    mode: 'words',
    language: 'english',
    words: [
      word(0, [key(0, { releaseMs: 80, expectedChar: 'h', correct: true }), key(100, { releaseMs: 180, overlapped: false })]),
      word(1, [key(200, { typedChar: 'x', mistakeKey: 'kyaa', correct: false })]),
      word(2),
      word(3, [key(4999)], { partial: true, correct: false }),
    ],
    ...extra,
  }
}

const list = (uid = UID): Step => ({ op: 'list', uid })
const save = (value: unknown, uid = UID): Step => ({ op: 'save', uid, log: value })
const get = (runId: string, uid = UID): Step => ({ op: 'get', uid, runId })
/** A save of a log with one word holding `keystrokes`. */
const saveKeys = (...keystrokes: unknown[]): Step => save(log('k', { words: [word(0, keystrokes)] }))

/** An index entry as a v1 build wrote it. */
const v1 = (id: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
  id, startedAt, filename: `2026-10-01T00-00-00.000Z_${id}.json`, savedAt: '2026-10-01T00:00:00.000Z', ...extra,
})

/** `n` live entries (`old-0` started first) and their bodies. */
function fullIndex(n: number, extra: unknown[] = []): Tree {
  const entries = Array.from({ length: n }, (_, i) => v1(`old-${i}`, t((i - 100) * MIN)))
  const tree: Tree = { [`${DIR}/index.json`]: index([...entries, ...extra]) }
  for (const entry of entries) tree[`${DIR}/${entry.filename}`] = `{"runId":"${entry.id}"}`
  return tree
}

const SCENARIOS: Scenario[] = [
  {
    name: 'save, list and get',
    time: T0,
    tree: {},
    steps: [
      list(),
      get('run-1'),
      save(log('run-1')),
      at(MIN),
      save(log('run-2', { startedAt: '2026-10-16T12:00:30.000Z', lineBreaks: [0, 2], romajiInput: true, charCorrelationUnavailable: false })),
      list(),
      get('run-1'),
      get('run-2'),
      get('missing'),
      list('0xOTHER'),
    ],
  },
  {
    name: 'the recording consent',
    time: T0,
    tree: {},
    steps: [
      { op: 'consent', accepted: false },
      save(log('run-1')),
      save({}),
      save(log('run-1'), '../x'),
      list(),
      { op: 'consent', accepted: true },
      save(log('run-1')),
      list(),
    ],
  },
  {
    name: 'logs that are not objects or lack a field',
    time: T0,
    tree: {},
    steps: [
      { op: 'save', uid: UID },
      save(null),
      save(42),
      save('text'),
      save(true),
      save([]),
      save([log()]),
      save({}),
      save({ ...log(), runId: '../x' }),
      save({ ...log(), runId: '' }),
      save({ ...log(), runId: '..' }),
      save({ ...log(), runId: 7 }),
      save({ ...log(), uid: '0xOTHER' }),
      save({ ...log(), uid: undefined }),
      save({ ...log(), startedAt: 'nope' }),
      save({ ...log(), startedAt: 1760000000000 }),
      save({ ...log(), startedAt: '+275760-09-13T00:00:00.001Z' }),
      save({ ...log(), durationMs: Number.NaN }),
      save({ ...log(), durationMs: Number.POSITIVE_INFINITY }),
      save({ ...log(), durationMs: -1 }),
      save({ ...log(), durationMs: '5000' }),
      save({ ...log(), durationMs: null }),
      save({ ...log(), mode: 1 }),
      save({ ...log(), language: null }),
      save({ ...log(), charCorrelationUnavailable: 'yes' }),
      save({ ...log(), charCorrelationUnavailable: null }),
      save({ ...log(), romajiInput: 1 }),
      save({ ...log(), words: {} }),
      save({ ...log(), words: undefined }),
      list(),
    ],
  },
  {
    name: 'words and keystrokes that are not valid',
    time: T0,
    tree: {},
    steps: [
      save(log('k', { words: [null] })),
      save(log('k', { words: [[]] })),
      save(log('k', { words: [word(-1)] })),
      save(log('k', { words: [word(1.5)] })),
      save(log('k', { words: [word(Number.NaN)] })),
      save(log('k', { words: [word(0, [], { partial: 'yes' })] })),
      save(log('k', { words: [word(0, [], { display: undefined })] })),
      save(log('k', { words: [word(0, [], { typed: 5 })] })),
      save(log('k', { words: [word(0, [], { correct: null })] })),
      save(log('k', { words: [word(0, [], { keystrokes: {} })] })),
      saveKeys(null),
      saveKeys([]),
      saveKeys(key(Number.NaN)),
      saveKeys(key(-1)),
      saveKeys(key(10_001)),
      saveKeys(key(100, { releaseMs: 99 })),
      saveKeys(key(100, { releaseMs: 10_001 })),
      saveKeys(key(100, { releaseMs: Number.NaN })),
      saveKeys(key(100, { releaseMs: null })),
      saveKeys(key(0, { row: -1 })),
      saveKeys(key(0, { col: 1.5 })),
      saveKeys(key(0, { keycode: Number.POSITIVE_INFINITY })),
      saveKeys(key(0, { keycode: '4' })),
      saveKeys(key(0, { expectedChar: 5 })),
      saveKeys(key(0, { correct: 'x' })),
      saveKeys(key(0, { overlapped: 1 })),
      saveKeys(key(0, { typedChar: 'x'.repeat(33) })),
      saveKeys(key(0, { mistakeKey: '😀'.repeat(17) })),
      saveKeys(key(0, { mistakeKey: 42 })),
      { op: 'save', uid: UID, log: log('k'), keys: 10_001 },
      list(),
    ],
  },
  {
    name: 'edge values that are valid',
    time: T0,
    tree: {},
    steps: [
      saveKeys(key(10_000, { releaseMs: 10_000, typedChar: 'x'.repeat(32), mistakeKey: '😀'.repeat(16), expectedChar: '' })),
      at(1),
      save(log('zero', { durationMs: -0, words: [word(0, [key(-0, { releaseMs: 5000, row: -0 })])], lineBreaks: [] })),
      at(2),
      save(log('numbers', {
        durationMs: 1e21,
        words: [word(0, [key(0.1 + 0.2, { releaseMs: 1e21, keycode: -5e-7 }), key(123456789012, { keycode: 1.5e300 })])],
        extra: { nested: [1, 'two', { three: null }], text: 'tab\t"quote"   é 😀 \uD800 \u0001' },
      })),
      at(3),
      save(log('dates', { startedAt: '2026-10-16' })),
      save(log('offset', { startedAt: '2026-10-16T21:00:00.000+09:00' })),
      save(log('local', { startedAt: '2026-10-16T12:00' })),
      save(log('max-year', { startedAt: '+275760-09-13T00:00:00.000Z' })),
      save(log('bc', { startedAt: '-000001-01-01T00:00:00Z' })),
      list(),
      get('numbers'),
      get('zero'),
    ],
  },
  {
    name: 'line breaks',
    time: T0,
    tree: {},
    steps: [
      save(log('a', { lineBreaks: 'nope' })),
      save(log('a', { lineBreaks: [1.5] })),
      save(log('a', { lineBreaks: [2, 1] })),
      save(log('a', { lineBreaks: [1, 1] })),
      save(log('a', { lineBreaks: [3] })),
      save(log('a', { lineBreaks: [-1] })),
      save(log('a', { lineBreaks: [null] })),
      save(log('a', { words: [], lineBreaks: [] })),
      save(log('b', { words: [word(0)], lineBreaks: [0] })),
      save(log('c', { lineBreaks: [2] })),
      list(),
    ],
  },
  {
    name: 'a log over the size cap',
    time: T0,
    tree: {},
    steps: [
      { op: 'save', uid: UID, log: log('big'), pad: 1_000_000 },
      list(),
    ],
  },
  {
    name: 'startedAt forms only V8 reads',
    time: T0,
    tree: {},
    steps: [
      { op: 'save', uid: UID, log: log('v8-a', { startedAt: 'Oct 16 2026' }), v8Only: true },
      { op: 'save', uid: UID, log: log('v8-b', { startedAt: '2026-10-16 12:00:00' }), v8Only: true },
      { op: 'save', uid: UID, log: log('v8-c', { startedAt: '2026-1-1' }), v8Only: true },
    ],
  },
  {
    name: 'a run saved again replaces its entry and body',
    time: T0,
    tree: {},
    steps: [
      save(log('dup')),
      at(5000),
      save(log('dup', { durationMs: 6000 })),
      list(),
      get('dup'),
      // The same millisecond: the same body name, written over.
      save(log('dup', { mode: 'again' })),
      list(),
    ],
  },
  {
    name: 'a tombstoned run is brought back by a save',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        v1('gone', t(-10 * MIN), { deletedAt: t(-MIN) }),
        v1('kept', t(-20 * MIN), { extra: 'field' }),
      ]),
      [`${DIR}/2026-10-01T00-00-00.000Z_kept.json`]: '{"runId":"kept"}',
    },
    steps: [list(), get('gone'), save(log('gone')), list(), get('gone'), get('kept')],
  },
  {
    name: 'bodies no entry names are removed',
    time: T0,
    tree: {
      [`${DIR}/2020-01-01T00-00-00.000Z_orphan.json`]: '{"runId":"orphan"}',
      [`${DIR}/notes.txt`]: 'not a body',
      [`${DIR}/plain.json`]: 'no underscore',
      [`${DIR}/index.json.tmp`]: 'a temp file',
      [`${DIR}/sub_dir.json/`]: null,
    },
    steps: [save(log('run-1')), list()],
  },
  {
    name: 'legacy names without the id move on a save',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: JSON.stringify({
        uid: UID,
        entries: [{ id: 'old', startedAt: '2025-01-01T00:00:00.000Z', filename: 'legacy.json', savedAt: '2025-01-01T00:00:00.000Z' }],
      }),
      [`${DIR}/legacy.json`]: '{"runId":"old"}',
    },
    steps: [get('old'), save(log('run-1')), list(), get('old')],
  },
  {
    name: 'the 51st run trims the run that started first',
    time: T0,
    tree: fullIndex(50, [v1('dead', t(-500 * MIN), { deletedAt: t(-MIN) })]),
    steps: [
      save(log('new')),
      list(),
      get('old-0'),
      at(MIN),
      // Starts before every kept run: trimmed by its own save.
      save(log('older', { startedAt: t(-1000 * MIN) })),
      list(),
    ],
  },
  {
    name: 'runs that started at the same time are trimmed by id',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        ...Array.from({ length: 49 }, (_, i) => v1(`same-${String(i).padStart(2, '0')}`, t(-MIN))),
        v1('bad-date', 'not a date'),
      ]),
    },
    steps: [save(log('same-50', { startedAt: t(-MIN) })), save(log('same-51', { startedAt: t(-MIN) })), list()],
  },
  {
    name: 'an index that is not JSON is replaced by the next save',
    time: T0,
    tree: { [`${DIR}/index.json`]: 'not json!!!' },
    steps: [list(), get('x'), save(log()), list()],
  },
  {
    name: 'an index of another uid is replaced by the next save',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([v1('other', t(-MIN))], '0xFFFF'),
      [`${DIR}/2026-10-01T00-00-00.000Z_other.json`]: '{"runId":"other"}',
    },
    steps: [list(), get('other'), save(log()), list()],
  },
  { name: 'an index that is an array', time: T0, tree: { [`${DIR}/index.json`]: '[{"uid":"0xA1B2","entries":[]}]' }, steps: [list(), save(log())] },
  { name: 'an index with a byte order mark', time: T0, tree: { [`${DIR}/index.json`]: '﻿{"uid":"0xA1B2","entries":[]}' }, steps: [list(), save(log())] },
  {
    name: 'invalid UTF-8 in the index and a body',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: { hex: Buffer.concat([Buffer.from('{"uid":"0xA1B2","entries":[{"id":"x","startedAt":"2026-01-01T00:00:00.000Z","note":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","filename":"x_x.json","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [`${DIR}/x_x.json`]: { hex: Buffer.concat([Buffer.from('{"runId":"x","text":"'), Buffer.from([0xc3]), Buffer.from('"}')]).toString('hex') },
    },
    steps: [list(), get('x'), save(log())],
  },
  {
    name: 'bodies that cannot be read',
    time: T0,
    tree: {
      [`${DIR}/index.json`]: index([
        v1('not-json', t(0)),
        v1('bom', t(0)),
        v1('missing', t(0)),
        { id: 'up', startedAt: t(0), filename: '../escape.json' },
        { id: 'none', startedAt: t(0) },
        { id: 'null', startedAt: t(0), filename: null },
        { id: 'empty', startedAt: t(0), filename: '' },
      ]),
      [`${DIR}/2026-10-01T00-00-00.000Z_not-json.json`]: '{"runId":',
      [`${DIR}/2026-10-01T00-00-00.000Z_bom.json`]: '﻿{"runId":"bom"}',
    },
    steps: ['not-json', 'bom', 'missing', 'up', 'none', 'null', 'empty'].map((id) => get(id)),
  },
  {
    name: 'uids that are not one path segment',
    time: T0,
    tree: {},
    steps: ['', '.', '..', 'a/b', 'a\\b', '../x'].flatMap((uid) => [
      list(uid),
      save({ ...log(), uid }, uid),
      get('run-1', uid),
    ]),
  },
]

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The log the shim sends for `step`: JSON.stringify(log), then the pad. */
function recordedStep(step: Step): RecordedStep {
  if (step.op !== 'save') return step
  const { log: value, ...rest } = step
  const logText = JSON.stringify(value)
  return logText === undefined ? rest : { ...rest, logText }
}

async function run(step: Exclude<Step, { op: 'at' | 'consent' }>): Promise<unknown> {
  switch (step.op) {
    case 'list': return listRunLogs(step.uid)
    case 'get': return getRunLog(step.uid, step.runId)
    case 'save': {
      let value = step.log
      if (step.keys !== undefined) value = { ...(value as Log), words: [word(0, Array.from({ length: step.keys }, () => key(0)))] }
      if (step.pad !== undefined) value = { ...(value as Log), note: 'x'.repeat(step.pad) }
      return saveRunLog(step.uid, value)
    }
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
  consent.accepted = true
  buildTree(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: (string | null)[] = []
    for (const step of scenario.steps) {
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push(null)
      } else if (step.op === 'consent') {
        consent.accepted = step.accepted
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

describe('run log store fixtures', () => {
  it('records each scenario’s responses, notified units and files', async () => {
    root = mkdtempSync(join(tmpdir(), 'run-log-store-fixtures-'))
    const results: unknown[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      const played = await play(scenario, dir)
      results.push({ ...scenario, steps: scenario.steps.map(recordedStep), ...played })
      if (scenario.name === 'startedAt forms only V8 reads') {
        // The forms the crate refuses are ones the handler takes.
        expect(played.outcomes.every((o) => o?.startsWith('{"success":true'))).toBe(true)
      }
    }
    writeJsonFixture(OUT, results)
  })
})
