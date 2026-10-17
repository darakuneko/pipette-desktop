// SPDX-License-Identifier: GPL-2.0-or-later
// A private X server for the X11 active-window fixture generator: Xvfb on a
// display number no other server holds, without TCP, and with a
// MIT-MAGIC-COOKIE-1 cookie in an authority file of its own. The generator
// never talks to the X server of the desktop it runs on.
//
// The display number is chosen here and checked free (no lock file, no
// socket file, nothing listening on the abstract socket) instead of being
// left to `-displayfd`: an X server that does not honour the lock files
// would otherwise take display 0 and unlink the desktop's socket file.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** The first display number in the private range that nothing holds. */
async function freeDisplayNumber(): Promise<number> {
  const desktop = /^:(\d+)/.exec(process.env.DISPLAY ?? '')?.[1]
  for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
    if (String(n) === desktop) continue
    if (existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`)) continue
    if (await abstractSocketInUse(n)) continue
    return n
  }
  throw new Error(`x server: no free display between :${FIRST_DISPLAY} and :${LAST_DISPLAY}`)
}

/** Starts `Xvfb` (the binary named by `command`, found on PATH). */
export async function startXServer(command = 'Xvfb'): Promise<XServer> {
  const chosen = await freeDisplayNumber()
  const dir = mkdtempSync(join(tmpdir(), 'pipette-x11-fixture-'))
  const authFile = join(dir, 'Xauthority')
  const cookie = randomBytes(16)
  writeFileSync(authFile, authorityEntry(cookie), { mode: 0o600 })
  const server = spawn(command, [`:${chosen}`, '-displayfd', '3', '-nolisten', 'tcp', '-auth', authFile], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  })
  let log = ''
  server.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8')
  })
  let number: string
  try {
    number = await readDisplayNumber(server.stdio[3] as Readable, server)
    if (number !== String(chosen)) throw new Error(`x server: started on :${number}, not on :${chosen}`)
  } catch (err) {
    server.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
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
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
