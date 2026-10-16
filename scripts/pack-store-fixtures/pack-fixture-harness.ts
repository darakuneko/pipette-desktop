// SPDX-License-Identifier: GPL-2.0-or-later
// What the fixture generators of the pack stores share: the stubs their
// Electron mocks answer with, building a userData tree, playing a
// scenario's steps through the real handlers, and recording what the steps
// answered, reported and left behind.
//
// Each generator runs the real handlers of one store's IPC module on a
// userData directory built in a temp directory, at fixed times and with a
// fixed sequence of new ids. The file dialogs answer paths under userData
// (or are cancelled). It records each step's response, the sync units
// reported to notifyChange, and every file and directory left behind
// (path → content).
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

import { vi } from 'vitest'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { REPO_ROOT } from '../fixture-vitest-config'

/** The state the generator's mocks read, made with `vi.hoisted`. */
export interface RecorderState {
  handlers: Map<string, (...args: unknown[]) => unknown>
  notified: string[]
  paths: { userData: string }
  ids: { next: number }
  /** The paths the next dialog answers, under userData; null cancels it. */
  dialogs: { answer: string[] | null; defaultPath: string | undefined }
}

/** The `electron` module the handlers see: the app's userData and dialogs
 *  that answer what the state says. */
export function electronMock(state: RecorderState): Record<string, unknown> {
  const chosen = (): string[] => (state.dialogs.answer ?? []).map((path) => `${state.paths.userData}/${path}`)
  return {
    app: { getPath: () => state.paths.userData },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: {
      showSaveDialog: (_win: unknown, options: { defaultPath?: string }) => {
        state.dialogs.defaultPath = options.defaultPath
        const [filePath] = chosen()
        return Promise.resolve({ canceled: filePath === undefined, filePath })
      },
      showOpenDialog: () => {
        const filePaths = chosen()
        return Promise.resolve({ canceled: state.dialogs.answer === null, filePaths })
      },
    },
  }
}

/** The ids the crate's tests hand out: `00000000-0000-4000-8000-{n:012}`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** Content larger than this is recorded by its hash. */
export const INLINE_LIMIT = 4096

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8, `{ copyOf }` for a file of the repository, `{ sha256, size }`
 *  for a large recorded file), or null for a directory. */
export type Node = string | { hex: string } | { copyOf: string } | { sha256: string; size: number } | null
export type Tree = Record<string, Node>

/** A JSON value given as is, or read from a file under userData when the
 *  step runs (`{ fromFile }`, parsed with JSON.parse). */
export type Raw = { value: unknown } | { fromFile: string } | { absent: true }

/** The steps every pack store's scenarios have; each store adds its own. */
export type CommonStep =
  /** The dialog answers `dialog` (paths under userData), or is cancelled. */
  | { op: 'import'; dialog: string[] | null }
  | { op: 'export'; id: unknown; dialog: string | null }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

export interface Scenario<S> {
  name: string
  time: string
  tree: Tree
  /** Modification times set after the tree is built: path → ISO time. */
  mtimes?: Record<string, string>
  steps: S[]
}

export function build(dir: string, tree: Tree): void {
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

/** The registered handler of `channel`. */
export function handler(state: RecorderState, channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = state.handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

/** The arguments `raw` stands for: none given is `undefined`. */
export function rawValue(raw: Raw, dir: string): unknown[] {
  if ('absent' in raw) return [undefined]
  if ('value' in raw) return [raw.value]
  return [JSON.parse(readFileSync(join(dir, raw.fromFile), 'utf-8'))]
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

export interface Played {
  /** The modification time each file of `mtimes` got, in nanoseconds since
   *  the epoch. */
  mtimesNs: Record<string, string>
  outcomes: unknown[]
  /** The default file name each export's save dialog offered. */
  defaultPaths: (string | null)[]
  notified: string[]
  after: Tree
}

/** Runs a step other than `at` through the handlers, given the userData
 *  directory. */
export type RunStep<S> = (step: Exclude<S, { op: 'at' }>, dir: string) => Promise<unknown>

async function play<S extends { op: string }>(
  state: RecorderState,
  scenario: Scenario<S>,
  dir: string,
  run: RunStep<S>,
): Promise<Played> {
  state.paths.userData = dir
  state.notified.length = 0
  state.ids.next = 1
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
      state.dialogs.defaultPath = undefined
      // Every scenario's steps include the common ones (CommonStep).
      const common = step as { op: string; time?: unknown; dialog?: unknown }
      if (common.op === 'at') {
        vi.setSystemTime(new Date(common.time as string))
        outcomes.push(null)
      } else {
        state.dialogs.answer = common.op === 'import'
          ? (common.dialog as string[] | null)
          : common.op === 'export' && common.dialog !== null ? [common.dialog as string] : null
        try {
          outcomes.push(outcome(await run(step as Exclude<S, { op: 'at' }>, dir), dir))
        } catch (err) {
          outcomes.push({ rejected: String(err) })
        }
      }
      defaultPaths.push(state.dialogs.defaultPath ?? null)
    }
    return { mtimesNs, outcomes, defaultPaths, notified: [...state.notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

/** Plays every scenario, each in its own directory under a temp root
 *  removed afterwards, and answers each with what it played. */
export async function playAll<S extends { op: string }>(
  state: RecorderState,
  scenarios: Scenario<S>[],
  run: RunStep<S>,
  tempPrefix: string,
): Promise<(Scenario<S> & Played)[]> {
  const root = mkdtempSync(join(tmpdir(), tempPrefix))
  try {
    const results: (Scenario<S> & Played)[] = []
    for (const [i, scenario] of scenarios.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(state, scenario, dir, run)) })
    }
    return results
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
