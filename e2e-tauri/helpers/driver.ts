// SPDX-License-Identifier: GPL-2.0-or-later
//
// The processes behind one WebDriver session of the Tauri build: tauri-driver,
// which starts the platform WebDriver (WebKitWebDriver on Linux), which starts
// the app. The app inherits the environment of tauri-driver, so the variables
// set here are how a session picks the virtual keyboard and its own userData
// directory.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDevToolsBinary } from './hub-env'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The binary of `pnpm tauri:build:debug` (`mainBinaryName` in
 *  src-tauri/tauri.conf.json). A debug build of `tauri build` embeds the
 *  renderer of out-tauri/renderer; a plain `cargo build` would load the Vite
 *  dev server instead. */
export const APP_BINARY = join(
  PROJECT_ROOT,
  'src-tauri/target/debug',
  process.platform === 'win32' ? 'pipette.exe' : 'pipette',
)

export const DRIVER_HOST = '127.0.0.1'
export const DRIVER_PORT = 4444
const NATIVE_DRIVER_PORT = 4445
const DRIVER_READY_TIMEOUT_MS = 15_000
const DRIVER_READY_POLL_MS = 100
const LOG_TAIL_LINES = 200

/** tauri-driver from PATH (`cargo install` puts it in ~/.cargo/bin), or the
 *  path in TAURI_DRIVER. */
const DRIVER_COMMAND = process.env.TAURI_DRIVER ?? 'tauri-driver'

export interface DriverSession {
  driver: ChildProcess
  userDataDir: string
  /** The variables the session's app gets on top of {@link appEnv}'s. */
  env: Record<string, string>
}

let session: DriverSession | null = null
/** The userData directories of the sessions {@link retireDriver} ended
 *  earlier in this worker, kept until {@link stopDriver} decides on them. */
const retiredUserDataDirs: string[] = []
/** Set while tauri-driver is being stopped on purpose, so its exit is not
 *  reported as a crash. */
let stopping = false

// afterSession does not run when the session never started, so the worker
// also stops tauri-driver, kills the session's other processes and removes
// the userData directories when it exits.
process.once('exit', () => {
  for (const dir of retiredUserDataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (!session) return
  stopping = true
  session.driver.kill('SIGKILL')
  if (process.platform === 'linux') signalAll(sessionPids(session.userDataDir), 'SIGKILL')
  rmSync(session.userDataDir, { recursive: true, force: true })
})

/** `parts` joined under the userData directory of the running session. */
export function userDataPath(...parts: string[]): string {
  if (!session) throw new Error('no session is running')
  return join(session.userDataDir, ...parts)
}

/** The log of the app of the running session (pipette-logger writes
 *  `<userData>/logs/pipette-0.log`). */
export function appLogPath(): string {
  return userDataPath('logs', 'pipette-0.log')
}

/** The app's config of the running session (`<userData>/config.json`),
 *  parsed; empty before the app first writes it. */
export function readAppConfig(): Record<string, unknown> {
  const path = userDataPath('config.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
}

/** The sync units local/sync-pending.json lists of the running session;
 *  empty before the app first writes it. */
export function readPendingUnits(): string[] {
  const path = userDataPath('local', 'sync-pending.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { units: string[] }).units : []
}

const QUIT_POLL_MS = 100

/** The pids of the running processes that carry the session's userData
 *  directory in their environment: tauri-driver passes it on to
 *  WebKitWebDriver, which passes it on to the app it starts, and
 *  {@link launchAppAgain} launches with it. With `exe`, only the processes of
 *  that binary. Linux only: it reads /proc. */
function sessionPids(userDataDir: string, exe?: string): number[] {
  const marker = `PIPETTE_USER_DATA_DIR=${userDataDir}`
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      if (exe !== undefined && readlinkSync(`/proc/${entry}/exe`) !== exe) continue
      if (!readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(marker)) continue
    } catch {
      // Gone since the listing, or another user's process.
      continue
    }
    if (isRunning(pid)) pids.push(pid)
  }
  return pids
}

/** The pids of the processes of the app binary that run with the session's
 *  userData directory: the app WebKitWebDriver started, and a launch of
 *  {@link launchAppAgain} while it runs. Linux only. */
function sessionAppPids(userDataDir: string): number[] {
  return sessionPids(userDataDir, realpathSync(APP_BINARY))
}

/** Whether `pid` is a process that has not exited: an exited child stays a
 *  zombie until WebKitWebDriver reaps it. */
function isRunning(pid: number): boolean {
  try {
    // The state follows the command name, which is in parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return false
  }
}

/** Quits the app of the running session the way a quit from the desktop
 *  does: SIGTERM, which runs the app's quit sequence, and resolves once the
 *  app has exited. Ending the WebDriver session instead kills the app
 *  without it, so nothing the app saves on quit (the window's bounds) would
 *  be saved. Linux only. */
export async function quitApp(timeoutMs: number): Promise<void> {
  if (!session) throw new Error('no session is running')
  if (process.platform !== 'linux') throw new Error('quitApp finds the app through /proc, which is Linux only')
  const pids = sessionAppPids(session.userDataDir)
  if (pids.length !== 1) throw new Error(`expected one app process of the session, found ${pids.length}`)
  const [pid] = pids
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (isRunning(pid)) {
    if (Date.now() > deadline) throw new Error(`the app (pid ${pid}) did not exit within ${timeoutMs} ms of SIGTERM`)
    await new Promise((r) => setTimeout(r, QUIT_POLL_MS))
  }
}

/** A Hub address nothing listens on: the Hub requests a test records no
 *  response for (`dev_http_respond`) fail at once instead of reaching the
 *  real Hub. The development tools' build reads PIPETTE_HUB_URL. */
export const E2E_HUB_URL = 'http://127.0.0.1:9'

/** Whether `url` is an http(s) URL on 127.0.0.1 or [::1], written as an IP
 *  address (the loopback interface, which the app's loopback-only clients
 *  allow). */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
  } catch {
    return false
  }
}

/** A startup-notice address nothing listens on: a session without a fake
 *  notice server gets no notices instead of reaching the real endpoint. The
 *  development tools' build reads PIPETTE_NOTIFICATION_URL. */
export const E2E_NOTIFICATION_URL = 'http://127.0.0.1:9'

/** Whether `url` is an http URL on 127.0.0.1 itself (not localhost, not
 *  [::1]), where the fake servers listen. */
export function isLocalHttpUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/** The variable that replaces the autostart directory
 *  ($HOME/.config/autostart) in a development tools' build. */
export const AUTOSTART_DIR_VARIABLE = 'PIPETTE_DEV_AUTOSTART_DIR'

/** `path` with every symbolic link resolved, the part that does not exist
 *  yet appended as it is (the app creates the directory). Throws when an
 *  existing part cannot be resolved, a dangling link among them. */
function resolveExisting(path: string): string {
  const missing: string[] = []
  let existing = path
  for (;;) {
    try {
      lstatSync(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) throw new Error(`no part of ${path} exists`)
      missing.unshift(basename(existing))
      existing = parent
    }
  }
  return join(realpathSync(existing), ...missing)
}

/** Whether `path` is `dir` or inside it; both already resolved. */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The autostart directories a session must never point at: the one
 *  Electron writes ($HOME/.config/autostart) and the XDG one, for the home
 *  and config directories of this process and of the app's environment
 *  `env`. */
export function realAutostartDirs(env: NodeJS.ProcessEnv): string[] {
  const homes = [homedir(), env.HOME]
  const configs = [process.env.XDG_CONFIG_HOME, env.XDG_CONFIG_HOME]
  const dirs = [
    ...homes.filter((home): home is string => !!home && isAbsolute(home)).map((home) => join(home, '.config', 'autostart')),
    ...configs.filter((config): config is string => !!config && isAbsolute(config)).map((config) => join(config, 'autostart')),
  ]
  return [...new Set(dirs)]
}

/** The normalized `dir` when it may be the session's autostart directory,
 *  else throws: an absolute path without `.` or `..` components (the app
 *  resolves `..` after following a link, so `<link>/..` could leave the
 *  session), strictly inside `sessionDir`, which after resolving its
 *  symbolic links is still inside it and is none of `realDirs` nor inside
 *  one of them. The app gets the returned path, the one checked. */
export function assertAutostartDir(dir: string, sessionDir: string, realDirs: string[]): string {
  if (!isAbsolute(dir)) throw new Error(`${AUTOSTART_DIR_VARIABLE} must be an absolute path, not ${dir}`)
  if (dir.split(/[\\/]/).some((part) => part === '.' || part === '..')) {
    throw new Error(`${AUTOSTART_DIR_VARIABLE} must not contain . or .. components, not ${dir}`)
  }
  let session: string
  try {
    session = realpathSync(sessionDir)
  } catch (err) {
    throw new Error(`the session's directory ${sessionDir} for ${AUTOSTART_DIR_VARIABLE} cannot be resolved: ${String(err)}`)
  }
  const normalized = resolve(dir)
  let resolved: string
  try {
    resolved = resolveExisting(normalized)
  } catch (err) {
    // A dangling link, a loop or a part it may not read: nothing to check.
    throw new Error(`${AUTOSTART_DIR_VARIABLE} cannot be resolved, not ${dir}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
  }
  if (resolved === session || !isWithin(resolved, session)) {
    throw new Error(`${AUTOSTART_DIR_VARIABLE} must be inside the session's directory ${session}, not ${dir} (${resolved})`)
  }
  for (const real of realDirs) {
    let target = resolve(real)
    try {
      target = resolveExisting(target)
    } catch {
      // A part of it cannot be resolved (a dangling link): compared as written.
    }
    if (isWithin(resolved, target)) throw new Error(`${AUTOSTART_DIR_VARIABLE} resolves to the real autostart directory ${target}`)
  }
  return normalized
}

/** The environment the app of a session runs with: the virtual keyboard
 *  only, the session's userData directory, a Hub and a startup-notice
 *  server on the loopback interface (E2E_HUB_URL and E2E_NOTIFICATION_URL
 *  unless the session names others, fake servers), the e2e mark, and the
 *  sync's master key in a file of that directory
 *  (`PIPETTE_DEV_KEYSTORE=file`, read by the development tools' build), so
 *  a session never reaches the OS key store of the developer's desktop.
 *
 *  PIPETTE_E2E=1 makes the app refuse every Hub request, the real Google
 *  and the real notice endpoint when their destinations are not on the
 *  loopback interface, PIPETTE_HUB_TEST=1 makes even a build without the
 *  development tools take the Hub address, and
 *  PIPETTE_DEV_SUPPRESS_BROWSER=1 keeps the sign-in from opening the system
 *  browser. The extra variables cannot replace these. A Hub address off
 *  the loopback interface, a notice address that is not http on 127.0.0.1,
 *  or an autostart directory {@link assertAutostartDir} refuses stops the
 *  launch. The autostart directory comes from the session's variables
 *  only, never from the shell's. */
export function appEnv(userDataDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIPETTE_HUB_URL: E2E_HUB_URL,
    PIPETTE_NOTIFICATION_URL: E2E_NOTIFICATION_URL,
    [AUTOSTART_DIR_VARIABLE]: undefined,
    ...extra,
    PIPETTE_VIRTUAL_DEVICE: 'only',
    PIPETTE_USER_DATA_DIR: userDataDir,
    PIPETTE_DEV_KEYSTORE: 'file',
    PIPETTE_E2E: '1',
    PIPETTE_HUB_TEST: '1',
    PIPETTE_DEV_SUPPRESS_BROWSER: '1',
  }
  if (!isLoopbackUrl(env.PIPETTE_HUB_URL)) {
    throw new Error(`PIPETTE_HUB_URL must be on 127.0.0.1 or [::1] in an e2e session, not ${String(env.PIPETTE_HUB_URL)}`)
  }
  if (!isLocalHttpUrl(env.PIPETTE_NOTIFICATION_URL)) {
    throw new Error(`PIPETTE_NOTIFICATION_URL must be an http URL on 127.0.0.1 in an e2e session, not ${String(env.PIPETTE_NOTIFICATION_URL)}`)
  }
  const autostartDir = env[AUTOSTART_DIR_VARIABLE]
  if (autostartDir === undefined) delete env[AUTOSTART_DIR_VARIABLE]
  else env[AUTOSTART_DIR_VARIABLE] = assertAutostartDir(autostartDir, userDataDir, realAutostartDirs(env))
  return env
}

export interface LaunchResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** stdout and stderr, for the failure message. */
  output: string
}

/** Starts the app binary again, outside WebDriver, with the environment of
 *  the running session's app, and resolves when that process exits. A
 *  process still running after `timeoutMs` is killed. */
export function launchAppAgain(timeoutMs: number): Promise<LaunchResult> {
  if (!session) throw new Error('no session is running')
  const child = spawn(APP_BINARY, [], {
    env: appEnv(session.userDataDir, session.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  return new Promise((resolvePromise, reject) => {
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${APP_BINARY} could not be started: ${err.message}`))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, output })
    })
  })
}

/** The variables a session adds, or the function that makes them from the
 *  session's fresh userData directory (for a path inside it, such as the
 *  autostart directory). */
export type SessionEnv = Record<string, string> | ((userDataDir: string) => Record<string, string>)

/** Starts tauri-driver for one session with a fresh userData directory, and
 *  resolves once it accepts connections. The session's app gets `env` on
 *  top of the variables every session sets. */
export async function startDriver(sessionEnv: SessionEnv = {}): Promise<DriverSession> {
  if (session) throw new Error('tauri-driver is already running')
  // Only a build with the development tools reads PIPETTE_E2E and the
  // loopback overrides of appEnv; any other build would use the real Hub
  // and the real notice endpoint, so no session starts one.
  assertDevToolsBinary(APP_BINARY)
  const userDataDir = mkdtempSync(join(tmpdir(), 'pipette-e2e-tauri-'))
  let env: Record<string, string>
  let driverEnv: NodeJS.ProcessEnv
  try {
    env = typeof sessionEnv === 'function' ? sessionEnv(userDataDir) : sessionEnv
    driverEnv = appEnv(userDataDir, env)
  } catch (err) {
    rmSync(userDataDir, { recursive: true, force: true })
    throw err
  }
  stopping = false
  const driver = spawn(DRIVER_COMMAND, ['--port', String(DRIVER_PORT), '--native-port', String(NATIVE_DRIVER_PORT)], {
    env: driverEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  driver.on('exit', (code, signal) => {
    if (!stopping) console.error(`tauri-driver exited unexpectedly (code ${code}, signal ${signal})`)
  })
  session = { driver, userDataDir, env }
  // Settles only on failure: tauri-driver could not be started or exited.
  const failed = new Promise<never>((_, reject) => {
    driver.once('error', (err) => reject(new Error(`tauri-driver could not be started (${DRIVER_COMMAND}): ${err.message}`)))
    driver.once('exit', () => reject(new Error('tauri-driver exited before it accepted connections')))
  })
  failed.catch(() => { /* raced below; a failure after the start is reported by the exit listener */ })
  await Promise.race([waitForPort(), failed])
  return session
}

async function waitForPort(): Promise<void> {
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the port is open; the status itself is the
      // native driver's business.
      await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/status`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, DRIVER_READY_POLL_MS))
    }
  }
  throw new Error(`tauri-driver did not accept connections within ${DRIVER_READY_TIMEOUT_MS} ms`)
}

/** Stops tauri-driver and ends the session's processes that outlive it;
 *  the userData directory of the session, or null when none ran. */
async function endSession(): Promise<string | null> {
  const current = session
  if (!current) return null
  const { driver, userDataDir } = current
  stopping = true
  // The session stays tracked until its processes are gone, so the exit
  // handler still finds them if the worker exits meanwhile.
  try {
    await stopDriverProcess(driver)
  } finally {
    if (process.platform === 'linux') await killLeftoverProcesses(userDataDir)
    session = null
  }
  return userDataDir
}

const DRIVER_TERM_WAIT_MS = 5_000
const DRIVER_KILL_WAIT_MS = 5_000

/** Whether `child` has exited. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Resolves once `child` has exited, or after `timeoutMs`. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, timeoutMs)
    function done(): void {
      clearTimeout(timer)
      child.off('exit', done)
      resolvePromise()
    }
    child.once('exit', done)
  })
}

/** SIGTERM to tauri-driver, then SIGKILL when it has not exited within
 *  {@link DRIVER_TERM_WAIT_MS}. */
async function stopDriverProcess(driver: ChildProcess): Promise<void> {
  // No pid: the spawn failed, and there is no process to wait for.
  if (driver.pid === undefined || hasExited(driver)) return
  driver.kill('SIGTERM')
  await waitForExit(driver, DRIVER_TERM_WAIT_MS)
  if (hasExited(driver)) return
  console.error(`tauri-driver (pid ${driver.pid}) did not exit on SIGTERM; sending SIGKILL`)
  driver.kill('SIGKILL')
  await waitForExit(driver, DRIVER_KILL_WAIT_MS)
  if (!hasExited(driver)) console.error(`tauri-driver (pid ${driver.pid}) is still running after SIGKILL`)
}

/** Ends the running session as {@link stopDriver} does, and keeps its
 *  userData directory until {@link stopDriver} ends the last session of the
 *  worker, so a spec can go on with another tauri-driver and a fresh
 *  userData directory ({@link startDriver}). */
export async function retireDriver(): Promise<void> {
  const userDataDir = await endSession()
  if (userDataDir !== null) retiredUserDataDirs.push(userDataDir)
}

/** Stops tauri-driver, ends the session's processes that outlive it, and
 *  removes the userData directory, and those of the sessions
 *  {@link retireDriver} ended. With `keepUserData` the directories stay,
 *  and the app logs in them are printed for the failure report. */
export async function stopDriver(opts: { keepUserData: boolean }): Promise<void> {
  const current = await endSession()
  const dirs = [...retiredUserDataDirs.splice(0), ...(current === null ? [] : [current])]
  for (const userDataDir of dirs) {
    if (opts.keepUserData) {
      console.error(`userData of the failed session kept at ${userDataDir}`)
      printLogs(join(userDataDir, 'logs'))
    } else {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

const LEFTOVER_TERM_WAIT_MS = 5_000
const LEFTOVER_KILL_WAIT_MS = 5_000

/** `pid` and its command line, for the failure report. */
function describeProcess(pid: number): string {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    return `${pid} (${cmdline})`
  } catch {
    return String(pid)
  }
}

/** Waits until no process of the session is running, for at most
 *  `timeoutMs`, and returns the ones still running. Each check scans /proc
 *  again, so a pid that exited and was reused by another process is not
 *  reported. */
async function waitForSessionExit(userDataDir: string, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let running = sessionPids(userDataDir)
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, QUIT_POLL_MS))
    running = sessionPids(userDataDir)
  }
  return running
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Exited since it was found.
    }
  }
}

/** Ends the processes of the session that outlive tauri-driver. On SIGTERM
 *  tauri-driver SIGKILLs WebKitWebDriver and exits, so an app that has not
 *  exited by then stays running without a parent. A running app holds the
 *  single-instance name on the D-Bus session bus every session shares, and
 *  each later launch then hands over to it and exits, so no later session
 *  could start. SIGTERM first, which runs the app's quit sequence, then
 *  SIGKILL. Linux only: it reads /proc. */
async function killLeftoverProcesses(userDataDir: string): Promise<void> {
  const pids = sessionPids(userDataDir)
  if (pids.length === 0) return
  console.error(`processes of the session still running after tauri-driver exited: ${pids.map(describeProcess).join(', ')}`)
  signalAll(pids, 'SIGTERM')
  // The pids come from a fresh scan right before each signal, so a pid that
  // exited and was reused by another process during the wait is not signalled.
  const afterTerm = await waitForSessionExit(userDataDir, LEFTOVER_TERM_WAIT_MS)
  if (afterTerm.length === 0) return
  console.error(`sending SIGKILL to the processes that did not exit on SIGTERM: ${afterTerm.join(', ')}`)
  signalAll(afterTerm, 'SIGKILL')
  const afterKill = await waitForSessionExit(userDataDir, LEFTOVER_KILL_WAIT_MS)
  if (afterKill.length > 0) console.error(`processes of the session still running after SIGKILL: ${afterKill.join(', ')}`)
}

function printLogs(logDir: string): void {
  if (!existsSync(logDir)) return
  for (const name of readdirSync(logDir).sort()) {
    const lines = readFileSync(join(logDir, name), 'utf8').split('\n')
    console.error(`--- ${name} (last ${LOG_TAIL_LINES} lines) ---`)
    console.error(lines.slice(-LOG_TAIL_LINES).join('\n'))
  }
}
