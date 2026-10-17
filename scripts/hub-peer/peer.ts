// SPDX-License-Identifier: GPL-2.0-or-later
// What the Hub peer comparisons (uploads.test.ts, analytics.test.ts) share:
// the userData they compare on, its copies, the Rust peer (src-tauri/
// crates/pipette-hub's example hub_peer) and the requests as both sides
// write them.
//
// The source is PIPETTE_HUB_PEER_USER_DATA, a copy of a real userData's
// `sync/` and `local/installation-id` made beforehand; without it each test
// uses a tree the repository's tests wrote. The source is only read: each
// side works on a copy of its own in the temporary directory, without
// `local/auth/`, `config.json` and `*.enc`, and the copies are removed at
// the end. A source with a symbolic link anywhere is refused (a link could
// lead a copy back into the real userData or to its secrets), and the
// copies are checked to hold none before any handler runs. The tests print
// counts only, never names, ids, paths or contents: a failing step is
// reported by its name, and the peer's stderr is dropped.

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { cargoTargetDir } from '../fixture-files'
import { assertSafePath, seedUserData } from '../sync-fixtures/harness'
import { HUB_BASE } from '../hub-fixtures/hub-harness'
import type { LoggedRequest } from '../hub-fixtures/request-log'

const execFileAsync = promisify(execFile)

/** The Rust peer: PIPETTE_HUB_PEER, or the debug build's. */
const PEER = process.env.PIPETTE_HUB_PEER
  ?? resolve(cargoTargetDir, 'debug/examples', process.platform === 'win32' ? 'hub_peer.exe' : 'hub_peer')
/** One run of the peer may take this long. */
const PEER_TIMEOUT_MS = 600_000

const tempDirs: string[] = []

/** The source userData given in PIPETTE_HUB_PEER_USER_DATA, checked to be
 *  outside the real userData directories and to hold no symbolic link;
 *  `null` when none is given. */
export function realSource(): string | null {
  const source = process.env.PIPETTE_HUB_PEER_USER_DATA
  if (!source) return null
  let dir: string
  let links: number
  try {
    dir = assertSafePath(resolve(source))
    links = countLinks(dir)
  } catch {
    throw new Error('hub peer: source check failed')
  }
  if (links > 0) throw new Error(`hub peer: the source holds ${links} symbolic link(s); refused`)
  return dir
}

/** The symbolic links at or under `dir` (never followed). */
export function countLinks(dir: string): number {
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) return 1
  if (!stat.isDirectory()) return 0
  return readdirSync(dir).reduce((sum, name) => sum + countLinks(join(dir, name)), 0)
}

/** Whether a path of the source (relative, `/`-separated) stays out of
 *  the copies. */
function excluded(rel: string): boolean {
  return rel === 'config.json' || rel === 'local/auth' || rel.startsWith('local/auth/') || rel.endsWith('.enc')
}

/** Copies the directories and regular files of `source` into `dir`,
 *  without the excluded paths. A symbolic link or any other kind of entry
 *  is never copied; it fails the copy. */
function copyTree(source: string, dir: string, rel = ''): void {
  for (const name of readdirSync(join(source, rel)).sort()) {
    const path = rel === '' ? name : `${rel}/${name}`
    if (excluded(path)) continue
    const stat = lstatSync(join(source, path))
    if (stat.isDirectory()) {
      mkdirSync(join(dir, path), { recursive: true })
      copyTree(source, dir, path)
    } else if (stat.isFile()) {
      copyFileSync(join(source, path), join(dir, path))
    } else {
      throw new Error('hub peer: the source holds an entry that is not a file or a directory')
    }
  }
}

/** `copyTree`, then a check that the copy holds no symbolic link. Errors
 *  name the side only. */
function copyInto(source: string, dir: string, side: string): void {
  try {
    copyTree(source, dir)
  } catch {
    throw new Error(`hub peer: the ${side} copy failed`)
  }
  const links = countLinks(dir)
  if (links > 0) throw new Error(`hub peer: the ${side} copy holds ${links} symbolic link(s)`)
}

/** A copy of `source` as the harness's userData (the Electron side). */
export function electronCopy(source: string): string {
  const dir = seedUserData()
  copyInto(source, dir, 'Electron')
  return dir
}

/** A copy of `source` in a temporary directory of its own (the Rust side). */
export function rustCopy(source: string): string {
  const dir = trackedTempDir('pipette-hub-peer-')
  copyInto(source, dir, 'Rust')
  return dir
}

/** A new temporary directory, removed by `removePeerDirs`. */
export function trackedTempDir(prefix: string): string {
  const dir = assertSafePath(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/** Removes every tracked directory, each on its own so one failure does
 *  not keep the others; the number that could not be removed. */
export function removePeerDirs(): number {
  let failed = 0
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      failed++
    }
  }
  return failed
}

export interface PeerRun<T> {
  output: T
  elapsedMs: number
  maxRssKb: number | null
}

/** Runs the peer on `userData` with `command`; its output. A failure is
 *  reported by the command's kind and the exit code only: the peer's
 *  stderr (which can name paths and requests) is dropped. */
export async function runPeer<T>(userData: string, now: number, command: Record<string, unknown>): Promise<PeerRun<T>> {
  const step = String(command.kind)
  if (!existsSync(PEER)) {
    throw new Error('hub peer: the Rust peer is missing: run cargo build -p pipette-hub --example hub_peer in src-tauri')
  }
  const dir = trackedTempDir('pipette-hub-peer-io-')
  const input = join(dir, 'input.json')
  const out = join(dir, 'output.json')
  writeFileSync(input, JSON.stringify({ userData, out, now, hubBase: HUB_BASE, command }))
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(PEER, [input], {
      timeout: PEER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TZ: process.env.TZ ?? 'UTC' },
    }))
  } catch (err) {
    const code = (err as { code?: unknown; signal?: unknown }).code ?? (err as { signal?: unknown }).signal
    throw new Error(`hub peer: hub_peer failed at ${step} (exit ${String(code)})`)
  }
  try {
    const printed = JSON.parse(stdout) as { elapsedMs: number; maxRssKb: number | null }
    const output = JSON.parse(readFileSync(out, 'utf8')) as T
    return { output, ...printed }
  } catch {
    throw new Error(`hub peer: the output of hub_peer at ${step} could not be read`)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // removePeerDirs tries again.
    }
  }
}

/** Runs `step`, turning any error but a failed assertion (whose message
 *  holds counts and booleans only) into one that names the step, so no
 *  name, id, path or content of the source reaches the output. */
export async function countsOnly(step: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    if (err instanceof Error && (err.name === 'AssertionError' || err.message.startsWith('hub peer:'))) throw err
    throw new Error(`hub peer: ${step} failed`)
  }
}

/** A request as the peer writes it. */
export interface PeerRequest {
  method: string
  path: string
  query: Array<[string, string]>
  headers: Record<string, string>
  bodyHex: string | null
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `request` with its query pairs in one order, for both sides. */
export function comparable(request: PeerRequest): PeerRequest {
  const query = [...request.query].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
  return { ...request, query }
}

/** A request the Electron code sent, as the peer writes one. */
export function fromLogged(request: LoggedRequest): PeerRequest {
  const body = request.body
  let bodyHex: string | null = null
  if (body !== undefined) {
    if ('multipart' in body) bodyHex = Buffer.from(body.multipart.normalized, 'base64').toString('hex')
    else if ('base64' in body) bodyHex = Buffer.from(body.base64, 'base64').toString('hex')
    else bodyHex = Buffer.from(body.text, 'utf8').toString('hex')
  }
  return comparable({ method: request.method, path: request.path, query: request.query, headers: request.headers, bodyHex })
}

/** The requests of both sides in one order (for requests sent at once). */
export function sortedRequests(requests: readonly PeerRequest[]): PeerRequest[] {
  return requests.map(comparable).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
}

/** The file `name` (a file name an index gives) in the store directory
 *  `store` (relative to the copy `root`), or `null` when the name is not a
 *  non-empty relative path that stays inside that directory: absolute,
 *  with a `..` part, or resolving outside it. */
export function storeFile(root: string, store: string, name: unknown): string | null {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return null
  if (name.split(/[\\/]/).includes('..')) return null
  const dir = resolve(root, store)
  const path = resolve(dir, name)
  const rel = relative(resolve(root), path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !path.startsWith(`${dir}${sep}`)) return null
  return path
}

/** A JSON file by its absolute path, `null` when missing or not JSON. */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** A JSON file of the copy, `null` when missing or not JSON. */
export function readJson(dir: string, path: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, path), 'utf8')) as unknown
  } catch {
    return null
  }
}

/** The live entries of an entry index (`{entries: [...]}`, or the
 *  `{metas: [...]}` of a pack index). */
export function liveEntries(index: unknown): Array<Record<string, unknown>> {
  const held = index as { entries?: unknown; metas?: unknown } | null
  const entries = held?.entries ?? held?.metas
  if (!Array.isArray(entries)) return []
  return entries.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && !entry.deletedAt,
  )
}
