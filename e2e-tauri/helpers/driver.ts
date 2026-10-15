// SPDX-License-Identifier: GPL-2.0-or-later
//
// The processes behind one WebDriver session of the Tauri build: tauri-driver,
// which starts the platform WebDriver (WebKitWebDriver on Linux), which starts
// the app. The app inherits the environment of tauri-driver, so the variables
// set here are how a session picks the virtual keyboard and its own userData
// directory.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
// also stops tauri-driver and removes the userData directory when it exits.
process.once('exit', () => {
  if (!session) return
  stopping = true
  session.driver.kill()
  rmSync(session.userDataDir, { recursive: true, force: true })
})

/** Starts tauri-driver for one session with a fresh userData directory, and
 *  resolves once it accepts connections. */
export async function startDriver(): Promise<DriverSession> {
  if (session) throw new Error('tauri-driver is already running')
  const userDataDir = mkdtempSync(join(tmpdir(), 'pipette-e2e-tauri-'))
  stopping = false
  const driver = spawn(DRIVER_COMMAND, ['--port', String(DRIVER_PORT), '--native-port', String(NATIVE_DRIVER_PORT)], {
    env: {
      ...process.env,
      PIPETTE_VIRTUAL_DEVICE: 'only',
      PIPETTE_USER_DATA_DIR: userDataDir,
    },
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

/** Stops tauri-driver and removes the userData directory. With `keepUserData`
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
  if (opts.keepUserData) {
    console.error(`userData of the failed session kept at ${userDataDir}`)
    printLogs(join(userDataDir, 'logs'))
  } else {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function printLogs(logDir: string): void {
  if (!existsSync(logDir)) return
  for (const name of readdirSync(logDir).sort()) {
    const lines = readFileSync(join(logDir, name), 'utf8').split('\n')
    console.error(`--- ${name} (last ${LOG_TAIL_LINES} lines) ---`)
    console.error(lines.slice(-LOG_TAIL_LINES).join('\n'))
  }
}
