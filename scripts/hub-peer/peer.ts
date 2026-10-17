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
// the end. The tests print counts only, never names, ids or contents.

import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
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
 *  outside the real userData directories; `null` when none is given. */
export function realSource(): string | null {
  const source = process.env.PIPETTE_HUB_PEER_USER_DATA
  if (!source) return null
  return assertSafePath(resolve(source))
}

/** Whether a path of the source stays out of the copies. */
function copied(source: string, path: string): boolean {
  const rel = relative(source, path).split(sep).join('/')
  if (rel === 'config.json' || rel === 'local/auth' || rel.startsWith('local/auth/')) return false
  return !rel.endsWith('.enc')
}

function copyInto(source: string, dir: string): void {
  cpSync(source, dir, { recursive: true, filter: (path) => copied(source, path) })
}

/** A copy of `source` as the harness's userData (the Electron side). */
export function electronCopy(source: string): string {
  const dir = seedUserData()
  copyInto(source, dir)
  return dir
}

/** A copy of `source` in a temporary directory of its own (the Rust side). */
export function rustCopy(source: string): string {
  const dir = assertSafePath(mkdtempSync(join(tmpdir(), 'pipette-hub-peer-')))
  tempDirs.push(dir)
  copyInto(source, dir)
  return dir
}

/** Removes the Rust side's copies and the peer's files. */
export function removePeerDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export interface PeerRun<T> {
  output: T
  elapsedMs: number
  maxRssKb: number | null
}

/** Runs the peer on `userData` with `command`; its output. */
export async function runPeer<T>(userData: string, now: number, command: Record<string, unknown>): Promise<PeerRun<T>> {
  if (!existsSync(PEER)) {
    throw new Error(`the Rust peer ${PEER} is missing: run cargo build -p pipette-hub --example hub_peer in src-tauri`)
  }
  const dir = assertSafePath(mkdtempSync(join(tmpdir(), 'pipette-hub-peer-io-')))
  tempDirs.push(dir)
  const input = join(dir, 'input.json')
  const out = join(dir, 'output.json')
  writeFileSync(input, JSON.stringify({ userData, out, now, hubBase: HUB_BASE, command }))
  const { stdout } = await execFileAsync(PEER, [input], { timeout: PEER_TIMEOUT_MS, env: { ...process.env, TZ: process.env.TZ ?? 'UTC' } })
  const printed = JSON.parse(stdout) as { elapsedMs: number; maxRssKb: number | null }
  const output = JSON.parse(readFileSync(out, 'utf8')) as T
  rmSync(dir, { recursive: true, force: true })
  return { output, ...printed }
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
