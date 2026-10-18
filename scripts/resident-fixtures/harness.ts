// SPDX-License-Identifier: GPL-2.0-or-later
// The harness the resident fixture generators boot Electron's main process
// (src/main/index.ts) in. setup.ts installs it before every test file and
// electron-mock.ts is the `electron` module. It keeps the code away from
// everything real:
//   - `net.fetch` answers from the generator's script and never connects;
//     with no script left it throws, and the global `fetch` always throws;
//   - `os.homedir()` answers a temporary HOME the generator made, and throws
//     with none or when it would answer the real HOME (or a directory in it),
//     so the autostart entry is only ever written under a temporary HOME;
//   - `app.getPath` answers a temporary userData and throws for the real
//     userData of Pipette or of Electron;
//   - `shell.openExternal` throws.
// The calls the code makes on windows, the tray, the screen and the app
// are recorded with the fake clock's time since the boot.
//
// The state lives on `globalThis` so it survives `vi.resetModules()`, which
// every boot does to get fresh module state in index.ts and app-behavior.ts.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** The clock at boot (2026-10-18T00:00:00Z). */
export const FIXED_NOW = Date.UTC(2026, 9, 18, 0, 0, 0)

export interface RecordedCall {
  /** Milliseconds of the fake clock since the boot. */
  t: number
  call: string
  args: unknown[]
}

export type ScriptedResponse =
  | {
      status: number
      /** The response body as text; null for no body. */
      body: string | null
      contentType?: string
    }
  /** The request fails before a response, as a network error does. */
  | { networkError: string }

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  hasSignal: boolean
}

export type Handler = (...args: unknown[]) => unknown

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Display {
  id: number
  bounds: Rect
  workArea: Rect
}

/** The window electron-mock.ts builds, as the generators drive it. */
export interface HarnessWindow {
  webContents: unknown
  frame: { width: number; height: number }
  maximized: boolean
  fullScreen: boolean
  emit(event: string, ...args: unknown[]): void
  destroy(): void
  getBounds(): Rect
}

/** The tray electron-mock.ts builds. */
export interface HarnessTray {
  destroyed: boolean
  menu: MenuItem[] | null
  emit(event: string): void
}

export interface MenuItem {
  type?: string
  label?: string
  enabled?: boolean
  click?: () => void
}

export interface ResidentState {
  home: string | null
  userData: string | null
  tempDirs: string[]
  calls: RecordedCall[]
  logs: { level: string; message: string }[]
  handlers: Map<string, Handler>
  configListeners: ((key: string, value: unknown) => void)[]
  readyCallbacks: (() => void)[]
  responses: ScriptedResponse[]
  requests: RecordedRequest[]
  config: Record<string, unknown>
  windowState: Rect & { maximized?: boolean }
  displays: Display[]
  isPackaged: boolean
  /** The frame (outer minus content size) of the windows built next. */
  frame: { width: number; height: number }
  windows: HarnessWindow[]
  trays: HarnessTray[]
  appListeners: Map<string, ((...args: unknown[]) => void)[]>
  screenListeners: Map<string, ((...args: unknown[]) => void)[]>
}

export const DEFAULT_DISPLAY: Display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}

function freshState(): ResidentState {
  return {
    home: null,
    userData: null,
    tempDirs: [],
    calls: [],
    logs: [],
    handlers: new Map(),
    configListeners: [],
    readyCallbacks: [],
    responses: [],
    requests: [],
    // Set by every boot (boot.ts).
    config: {},
    windowState: { x: -1, y: -1, width: 0, height: 0 },
    displays: [DEFAULT_DISPLAY],
    isPackaged: false,
    frame: { width: 0, height: 0 },
    windows: [],
    trays: [],
    appListeners: new Map(),
    screenListeners: new Map(),
  }
}

const KEY = Symbol.for('pipette.resident-fixtures.state')

/** The harness state shared by every module instance. */
export function harnessState(): ResidentState {
  const holder = globalThis as unknown as Record<symbol, ResidentState | undefined>
  holder[KEY] ??= freshState()
  return holder[KEY]
}

const REAL_HOME_KEY = Symbol.for('pipette.resident-fixtures.real-home')

/** The real HOME the guards compare against, or '' before setup.ts's mock
 *  of `node:os` recorded it (on `globalThis`, under this key). */
export function realHome(): string {
  return (globalThis as unknown as Record<symbol, string | undefined>)[REAL_HOME_KEY] ?? ''
}

/** Removes the temporary directories and forgets everything recorded. */
export function resetHarness(): void {
  const holder = globalThis as unknown as Record<symbol, ResidentState | undefined>
  for (const dir of harnessState().tempDirs) rmSync(dir, { recursive: true, force: true })
  holder[KEY] = freshState()
}

export function record(call: string, ...args: unknown[]): void {
  const state = harnessState()
  state.calls.push({ t: Date.now() - FIXED_NOW, call, args: structuredClone(args) })
}

// --- HOME and userData ---

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** `path` with the symlinks of its longest existing ancestor resolved. */
function realPathOf(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(realPathOf(parent), relative(parent, absolute))
  }
}

function isUnder(path: string, roots: string[]): boolean {
  const candidates = [resolve(path), realPathOf(path)]
  return roots.some((root) => [resolve(root), realPathOf(root)].some((r) => candidates.some((c) => isInside(c, r))))
}

function knownRealHome(): string {
  const home = realHome()
  if (home === '') throw new Error('resident fixture harness: the real HOME is not known')
  return home
}

/** Throws when `home` is the real HOME or a directory inside it. */
export function assertTemporaryHome(home: string | null): string {
  if (home === null) throw new Error('resident fixture harness: os.homedir() before useTemporaryHome')
  if (isUnder(home, [knownRealHome()])) throw new Error(`resident fixture harness: refused the real HOME ${home}`)
  return home
}

/** Throws when `path` is, or is inside, the real userData of Pipette or of
 *  Electron (under `~/.config` or `XDG_CONFIG_HOME`). */
export function assertSafePath(path: string): string {
  const configRoots = [join(knownRealHome(), '.config'), process.env.XDG_CONFIG_HOME].filter(
    (root): root is string => typeof root === 'string' && root !== '',
  )
  const forbidden = configRoots.flatMap((root) => [join(root, 'pipette-desktop'), join(root, 'Electron')])
  if (isUnder(path, forbidden)) throw new Error(`resident fixture harness: refused the real userData ${path}`)
  return path
}

/** `os.homedir()` of the code under test. */
export function harnessHome(): string {
  return assertTemporaryHome(harnessState().home)
}

/** Makes a new temporary HOME and answers it from `os.homedir()`. */
export function useTemporaryHome(): string {
  const state = harnessState()
  const dir = mkdtempSync(join(tmpdir(), 'pipette-resident-home-'))
  state.tempDirs.push(dir)
  state.home = assertTemporaryHome(dir)
  return dir
}

/** Points `os.homedir()` at `dir`; for the tests of the harness itself. */
export function useHome(dir: string | null): void {
  harnessState().home = dir
}

/** Points `app.getPath('userData')` at `dir`; for the tests of the harness. */
export function useUserData(dir: string | null): void {
  harnessState().userData = dir
}

/** `app.getPath(name)`: a temporary userData, or a directory beside it. */
export function harnessPath(name: string): string {
  const state = harnessState()
  if (state.userData === null) {
    const dir = mkdtempSync(join(tmpdir(), 'pipette-resident-userdata-'))
    state.tempDirs.push(dir)
    state.userData = dir
  }
  return assertSafePath(name === 'userData' ? state.userData : join(`${state.userData}-paths`, name))
}

// --- Notification requests ---

/** Queues the answers `net.fetch` gives, in order. */
export function scriptResponses(...responses: ScriptedResponse[]): void {
  harnessState().responses.push(...responses)
}

/** `net.fetch`: records the request and answers from the script; never
 *  connects. */
export async function scriptedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const state = harnessState()
  const url = input instanceof Request ? input.url : input.toString()
  const next = state.responses.shift()
  if (next === undefined) throw new Error(`resident fixture harness: refused an unscripted request to ${url}`)
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value
  })
  state.requests.push({
    url,
    method: init?.method ?? 'GET',
    headers,
    body: typeof init?.body === 'string' ? init.body : String(init?.body),
    hasSignal: init?.signal instanceof AbortSignal,
  })
  if ('networkError' in next) throw new TypeError(next.networkError)
  return new Response(next.body, {
    status: next.status,
    headers: next.contentType === undefined ? {} : { 'Content-Type': next.contentType },
  })
}

/** The global `fetch` of the generators: nothing goes out. */
export function refusedFetch(input: string | URL | Request): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString()
  return Promise.reject(new Error(`resident fixture harness: refused a request to ${url}`))
}

// --- IPC ---

/** Calls the handler of `channel` as `ipcRenderer.invoke` would, with the
 *  first window's webContents as the sender. */
export async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const state = harnessState()
  const handler = state.handlers.get(channel)
  if (handler === undefined) throw new Error(`resident fixture harness: no handler for ${channel}`)
  return await handler({ sender: state.windows[0]?.webContents, senderFrame: { origin: 'file://' } }, ...args)
}

/** Tells the app-config listeners that `key` changed, as electron-store's
 *  setter does. */
export function changeConfig(key: string, value: unknown): void {
  for (const listener of harnessState().configListeners) listener(key, value)
}
