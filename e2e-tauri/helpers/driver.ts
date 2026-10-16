// SPDX-License-Identifier: GPL-2.0-or-later
//
// The processes behind one WebDriver session of the Tauri build: tauri-driver,
// which starts the platform WebDriver (WebKitWebDriver on Linux), which starts
// the app. The app inherits the environment of tauri-driver, so the variables
// set here are how a session picks the virtual keyboard and its own userData
// directory.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
}

let session: DriverSession | null = null
/** Set while tauri-driver is being stopped on purpose, so its exit is not
 *  reported as a crash. */
let stopping = false

// afterSession does not run when the session never started, so the worker
// also stops tauri-driver, kills the session's other processes and removes
// the userData directory when it exits.
process.once('exit', () => {
  if (!session) return
  stopping = true
  session.driver.kill()
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

/** The environment the app of a session runs with: the virtual keyboard
 *  only, the session's userData directory, and a Hub that is not there. */
function appEnv(userDataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PIPETTE_VIRTUAL_DEVICE: 'only',
    PIPETTE_USER_DATA_DIR: userDataDir,
    PIPETTE_HUB_URL: E2E_HUB_URL,
  }
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
  const child = spawn(APP_BINARY, [], { env: appEnv(session.userDataDir), stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Starts tauri-driver for one session with a fresh userData directory, and
 *  resolves once it accepts connections. */
export async function startDriver(): Promise<DriverSession> {
  if (session) throw new Error('tauri-driver is already running')
  const userDataDir = mkdtempSync(join(tmpdir(), 'pipette-e2e-tauri-'))
  stopping = false
  const driver = spawn(DRIVER_COMMAND, ['--port', String(DRIVER_PORT), '--native-port', String(NATIVE_DRIVER_PORT)], {
    env: appEnv(userDataDir),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  driver.on('exit', (code, signal) => {
    if (!stopping) console.error(`tauri-driver exited unexpectedly (code ${code}, signal ${signal})`)
  })
  session = { driver, userDataDir }
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

/** Stops tauri-driver, ends the session's processes that outlive it, and
 *  removes the userData directory. With `keepUserData`
 *  the directory stays, and the app logs in it are printed for the failure
 *  report. */
export async function stopDriver(opts: { keepUserData: boolean }): Promise<void> {
  const current = session
  session = null
  if (!current) return
  const { driver, userDataDir } = current
  stopping = true
  // No pid: the spawn failed, and there is no process to wait for.
  if (driver.pid !== undefined && driver.exitCode === null && driver.signalCode === null) {
    const exited = new Promise((r) => driver.once('exit', r))
    driver.kill()
    await exited
  }
  if (process.platform === 'linux') await killLeftoverProcesses(userDataDir)
  if (opts.keepUserData) {
    console.error(`userData of the failed session kept at ${userDataDir}`)
    printLogs(join(userDataDir, 'logs'))
  } else {
    rmSync(userDataDir, { recursive: true, force: true })
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

/** Waits until none of `pids` is running, for at most `timeoutMs`, and
 *  returns the ones still running. */
async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let running = pids.filter(isRunning)
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, QUIT_POLL_MS))
    running = running.filter(isRunning)
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
  const afterTerm = await waitForExit(pids, LEFTOVER_TERM_WAIT_MS)
  if (afterTerm.length === 0) return
  console.error(`sending SIGKILL to the processes that did not exit on SIGTERM: ${afterTerm.join(', ')}`)
  signalAll(afterTerm, 'SIGKILL')
  const afterKill = await waitForExit(afterTerm, LEFTOVER_KILL_WAIT_MS)
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
