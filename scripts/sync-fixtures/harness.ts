// SPDX-License-Identifier: GPL-2.0-or-later
// The harness the sync fixture generators run the Electron main process's
// sync code in (setup.ts installs it before every test file). It keeps the
// code away from everything real:
//   - `fetch` (and Electron's `net.fetch`) sends only to 127.0.0.1, each
//     redirect included, and throws for any other destination before
//     connecting, so no request reaches Google or Drive;
//   - `app.getPath` answers directories under a temporary userData the
//     test seeds, and throws when it would answer the real userData of
//     Pipette or of Electron (`~/.config/pipette-desktop`,
//     `~/.config/Electron` and their places on the other systems), or
//     when no userData is seeded;
//   - `shell.openExternal` records the URL and opens nothing; `safeStorage`
//     encrypts with a fixed transformation, never with the OS key store;
//   - the clock, `Math.random`, `randomUUID` and `randomBytes` give the same
//     values on every run.

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { random32 } from '../fixture-random'

/** The clock of every test: `Date.now()` until a test moves it. */
export const FIXED_NOW = Date.UTC(2026, 9, 16, 0, 0, 0)

/** The installation id a seeded userData gets (`local/installation-id`),
 *  so the machine hash is the same on every run. */
export const FIXED_INSTALLATION_ID = '00000000-0000-4000-8000-00000000f1f0'

const RANDOM_SEED = 0x5eed

/** A userData tree: file path → UTF-8 content, or null for a directory. */
export type Tree = Record<string, string | null>

interface HarnessState {
  userData: string | null
  tempDirs: string[]
  openedUrls: string[]
  nextUuid: number
  random: () => number
}

const state: HarnessState = {
  userData: null,
  tempDirs: [],
  openedUrls: [],
  nextUuid: 1,
  random: random32(RANDOM_SEED),
}

/** Puts the harness back to its start and removes the seeded userData. */
export function resetHarness(): void {
  for (const dir of state.tempDirs) rmSync(dir, { recursive: true, force: true })
  state.userData = null
  state.tempDirs = []
  state.openedUrls = []
  state.nextUuid = 1
  state.random = random32(RANDOM_SEED)
}

// --- Destinations ---

function isLoopbackUrl(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === '127.0.0.1'
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString())
}

/** `fetch` that sends only to 127.0.0.1 and follows only redirects that
 *  stay there; throws for any other destination before connecting. */
export function guardedFetch(realFetch: typeof fetch): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit, hops = 0): Promise<Response> => {
    const url = requestUrl(input)
    if (!isLoopbackUrl(url)) throw new Error(`sync fixture harness: refused a request to ${url.host || url.href}`)
    if (hops > 20) throw new Error('sync fixture harness: too many redirects')
    const response = await realFetch(input, { ...init, redirect: 'manual' })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null
    if (location === null || init?.redirect === 'manual') return response
    const next = new URL(location, url)
    // As fetch does: 303, and 301 / 302 of a POST, go on as a GET.
    const method = (init?.method ?? 'GET').toUpperCase()
    const asGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')
    return guarded(next, asGet ? { ...init, method: 'GET', body: undefined } : init, hops + 1)
  }
  return ((input: string | URL | Request, init?: RequestInit) => guarded(input, init)) as typeof fetch
}

// --- Paths ---

/** The real userData directories of Pipette and of Electron. */
function forbiddenRoots(): string[] {
  const home = homedir()
  const configRoots = [
    join(home, '.config'),
    process.env.XDG_CONFIG_HOME,
    join(home, 'Library', 'Application Support'),
    process.env.APPDATA,
  ].filter((root): root is string => typeof root === 'string' && root !== '')
  return configRoots.flatMap((root) => [join(root, 'pipette-desktop'), join(root, 'Electron')]).map((dir) => resolve(dir))
}

/** `path` with every symlink on it resolved, a dangling one included (its
 *  target is where a write would go). */
function realPath(path: string, depth = 0): string {
  const parts = resolve(path).split(sep)
  let current = parts[0] === '' ? sep : `${parts[0]}${sep}`
  for (let i = 1; i < parts.length; i++) {
    const next = join(current, parts[i])
    let isLink: boolean
    try {
      isLink = lstatSync(next).isSymbolicLink()
    } catch {
      return join(next, ...parts.slice(i + 1))
    }
    if (isLink) {
      if (depth > 40) throw new Error(`sync fixture harness: too many symlinks in ${path}`)
      return realPath(join(resolve(dirname(next), readlinkSync(next)), ...parts.slice(i + 1)), depth + 1)
    }
    current = next
  }
  return current
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Throws when `path` is, or is inside, a real userData directory. */
export function assertSafePath(path: string): string {
  const candidates = [resolve(path), realPath(path)]
  for (const root of forbiddenRoots()) {
    for (const candidate of [root, realPath(root)]) {
      if (candidates.some((p) => isInside(p, candidate))) {
        throw new Error(`sync fixture harness: refused the real userData ${candidate}`)
      }
    }
  }
  return path
}

/** `app.getPath(name)`: the seeded userData, or a directory beside it. */
export function harnessPath(name: string): string {
  if (state.userData === null) throw new Error(`sync fixture harness: app.getPath('${name}') before seedUserData`)
  return assertSafePath(name === 'userData' ? state.userData : join(`${state.userData}-paths`, name))
}

// --- Seeded userData ---

/** Makes a new temporary userData with `tree` (and the fixed installation
 *  id unless `tree` has one) and answers it from `app.getPath`. */
export function seedUserData(tree: Tree = {}): string {
  const dir = assertSafePath(mkdtempSync(join(tmpdir(), 'pipette-sync-fixture-')))
  state.tempDirs.push(dir, `${dir}-paths`)
  writeTree(dir, { 'local/installation-id': FIXED_INSTALLATION_ID, ...tree })
  state.userData = dir
  return dir
}

/** Points `app.getPath('userData')` at `dir`, which must be safe; for the
 *  tests of the harness itself. */
export function useUserData(dir: string): void {
  state.userData = dir
}

/** Writes `tree` under `dir`. Every path must stay under `dir` (no
 *  absolute path, no `..` out of it); otherwise nothing is written. */
export function writeTree(dir: string, tree: Tree): void {
  for (const path of Object.keys(tree)) {
    if (isAbsolute(path) || !isInside(resolve(dir, path), resolve(dir))) {
      throw new Error(`sync fixture harness: refused the tree path ${path} outside ${dir}`)
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    const target = assertSafePath(join(dir, path))
    if (content === null) {
      mkdirSync(target, { recursive: true })
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
}

/** Every file (UTF-8) and empty directory under `dir`, by path. */
export function readTree(dir: string): Tree {
  const tree: Tree = {}
  const walk = (current: string): void => {
    const entries = readdirSync(current).sort()
    if (entries.length === 0 && current !== dir) tree[`${relative(dir, current).split(sep).join('/')}/`] = null
    for (const entry of entries) {
      const path = join(current, entry)
      if (lstatSync(path).isDirectory()) walk(path)
      else tree[relative(dir, path).split(sep).join('/')] = readFileSync(path, 'utf8')
    }
  }
  walk(dir)
  return tree
}

// --- Shell ---

export function recordOpenedUrl(url: string): void {
  state.openedUrls.push(url)
}

/** The URLs `shell.openExternal` was asked to open since the last reset. */
export function openedUrls(): readonly string[] {
  return state.openedUrls
}

// --- Randomness ---

export function fixedRandom(): number {
  return state.random() / 0x1_0000_0000
}

/** `randomUUID`: `00000000-0000-4000-8000-000000000001`, `…02`, … */
export function fixedUuid(): string {
  const n = state.nextUuid++
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

export function fixedRandomBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = state.random() & 0xff
  return bytes
}
