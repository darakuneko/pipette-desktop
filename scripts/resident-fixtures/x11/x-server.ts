// SPDX-License-Identifier: GPL-2.0-or-later
// A private X server for the X11 active-window fixture generator: Xvfb on a
// display number no other server holds, without TCP, and with a
// MIT-MAGIC-COOKIE-1 cookie in an authority file of its own. The generator
// never talks to the X server of the desktop it runs on.
//
// The display number is chosen here (90 and up, never the desktop's) and
// reserved through its lock file before the server starts, instead of being
// left to `-displayfd`: an X server that does not honour the lock files
// would otherwise take display 0 and unlink the desktop's socket file.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

export interface XServer {
  /** `:<n>` */
  display: string
  /** The authority file with the server's cookie (`XAUTHORITY`). */
  authFile: string
  cookie: Buffer
  /** A temporary directory removed by `close`. */
  dir: string
  close(): Promise<void>
}

const START_TIMEOUT_MS = 10_000

/** One Xauthority entry of family FamilyWild with no display number, which
 *  Xlib matches against any local display. */
function authorityEntry(cookie: Buffer): Buffer {
  const field = (data: Buffer): Buffer => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(data.length)
    return Buffer.concat([length, data])
  }
  const family = Buffer.from([0xff, 0xff])
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)])
}

function readDisplayNumber(stream: Readable, server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => {
      reject(new Error(`x server: no display number within ${START_TIMEOUT_MS} ms`))
    }, START_TIMEOUT_MS)
    const done = (err: Error | null, value?: string): void => {
      clearTimeout(timer)
      stream.removeAllListeners('data')
      server.removeAllListeners('exit')
      if (err) reject(err)
      else resolve(value as string)
    }
    stream.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.includes('\n')) done(null, text.trim())
    })
    server.once('exit', (code, signal) => {
      done(new Error(`x server exited before it was ready (code ${code}, signal ${signal})`))
    })
    server.once('error', (err) => {
      done(err)
    })
  })
}

const FIRST_DISPLAY = 90
const LAST_DISPLAY = 199

/** Whether something listens on the abstract socket of display `n`. */
function abstractSocketInUse(n: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(`\0/tmp/.X11-unix/X${n}`)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** Reserves the first display number in the private range that nothing
 *  holds, by creating its lock file `/tmp/.X<n>-lock` exclusively (with this
 *  process's pid, in the X server's format). The server is started with
 *  `-displayfd`, which makes it skip its own lock, so this file is what
 *  keeps two generators (and other X servers) off the same number. A lock
 *  file that already exists, stale or not, means the number is taken.
 *  Returns the number and its lock file, which only this generator removes. */
async function reserveDisplayNumber(): Promise<{ number: number; lockFile: string }> {
  const desktop = /^:(\d+)/.exec(process.env.DISPLAY ?? '')?.[1]
  for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
    if (String(n) === desktop) continue
    const lockFile = `/tmp/.X${n}-lock`
    let fd: number
    try {
      fd = openSync(lockFile, 'wx', 0o444)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    writeSync(fd, `${String(process.pid).padStart(10)}\n`)
    closeSync(fd)
    if (existsSync(`/tmp/.X11-unix/X${n}`) || (await abstractSocketInUse(n))) {
      // Held by a server that keeps no lock file: give the number back.
      unlinkSync(lockFile)
      continue
    }
    return { number: n, lockFile }
  }
  throw new Error(`x server: no free display between :${FIRST_DISPLAY} and :${LAST_DISPLAY}`)
}

/** Starts `Xvfb` (the binary named by `command`, found on PATH) on a
 *  reserved display. It runs under `setpriv --pdeathsig TERM`, so it stops
 *  with the process that started it even when that process is killed; on a
 *  normal exit or SIGINT / SIGTERM of this process it is stopped and the
 *  lock file removed. When this process is killed outright the lock file
 *  stays (with this pid) and later runs skip that number. */
export async function startXServer(command = 'Xvfb'): Promise<XServer> {
  const { number: chosen, lockFile } = await reserveDisplayNumber()
  const dir = mkdtempSync(join(tmpdir(), 'pipette-x11-fixture-'))
  const authFile = join(dir, 'Xauthority')
  const cookie = randomBytes(16)
  writeFileSync(authFile, authorityEntry(cookie), { mode: 0o600 })
  const server = spawn(
    'setpriv',
    ['--pdeathsig', 'TERM', '--', command, `:${chosen}`, '-displayfd', '3', '-nolisten', 'tcp', '-auth', authFile],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  )
  let cleaned = false
  const cleanUpNow = (): void => {
    if (cleaned) return
    cleaned = true
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
    rmSync(lockFile, { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanUpNow()
    process.kill(process.pid, signal)
  }
  const forget = (): void => {
    process.off('exit', cleanUpNow)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  process.on('exit', cleanUpNow)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let log = ''
  server.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8')
  })
  let number: string
  try {
    number = await readDisplayNumber(server.stdio[3] as Readable, server)
    if (number !== String(chosen)) throw new Error(`x server: started on :${number}, not on :${chosen}`)
  } catch (err) {
    cleanUpNow()
    forget()
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`${detail}\n${log}`)
  }
  return {
    display: `:${number}`,
    authFile,
    cookie,
    dir,
    close: async () => {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()))
        server.kill('SIGTERM')
        const timer = setTimeout(() => server.kill('SIGKILL'), 3_000)
        await exited
        clearTimeout(timer)
      }
      cleanUpNow()
      forget()
    },
  }
}
