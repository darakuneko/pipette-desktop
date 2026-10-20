// SPDX-License-Identifier: GPL-2.0-or-later
//
// The window's close button, pressed from outside the app, and whether the
// app has a window on screen, asked of the X server. WebDriver's
// Close Window destroys the webview instead of asking the window to close,
// so the app would never see the close request. Under X11 the close button
// of a window manager sends the window a WM_DELETE_WINDOW ClientMessage
// (ICCCM), which GTK turns into the window's close request; the tests' X
// server runs no window manager, so this sends that message itself, on the
// X server of DISPLAY with the cookie of XAUTHORITY (xvfb-run sets both).
// Only a display numbered from 90 up is used: the desktop's own X servers
// take the low numbers, and the tests' servers (xvfb-run's from 99, the
// private ones of the fixture generators from 90) do not.

import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { clientMessage, connectX, type XClient } from './x11/x-client'

const COOKIE_NAME = 'MIT-MAGIC-COOKIE-1'

/** The MIT-MAGIC-COOKIE-1 of display number `display` in the Xauthority
 *  file `data`: the first entry for that number, else the first for any
 *  number (an empty one); null when there is neither. */
export function xauthCookie(data: Buffer, display: string): Buffer | null {
  let offset = 0
  const field = (): Buffer => {
    const length = data.readUInt16BE(offset)
    const value = data.subarray(offset + 2, offset + 2 + length)
    if (value.length !== length) throw new Error('the Xauthority file ends inside an entry')
    offset += 2 + length
    return value
  }
  let anyNumber: Buffer | null = null
  while (offset < data.length) {
    offset += 2 // family
    field() // address
    const number = field().toString('latin1')
    const name = field().toString('latin1')
    const cookie = Buffer.from(field())
    if (name !== COOKIE_NAME) continue
    if (number === display) return cookie
    if (number === '' && anyNumber === null) anyNumber = cookie
  }
  return anyNumber
}

/** The lowest display number used: below it is the desktop's. */
const MIN_TEST_DISPLAY = 90
/** The deadline of the connection and of each request. */
const X_TIMEOUT_MS = 5_000

/** The X server of DISPLAY, which must be a local `:<n>` with n from
 *  {@link MIN_TEST_DISPLAY} up. */
async function connectDisplay(): Promise<XClient> {
  const display = process.env.DISPLAY
  const number = display === undefined ? undefined : /^:(\d+)(?:\.\d+)?$/.exec(display)?.[1]
  if (number === undefined) throw new Error(`the X11 helper needs a local X display, not DISPLAY=${String(display)}`)
  if (Number(number) < MIN_TEST_DISPLAY) {
    throw new Error(`DISPLAY=${display} may be the desktop's; the X11 helper only uses a test server's display (:${MIN_TEST_DISPLAY} and up)`)
  }
  const authority = process.env.XAUTHORITY ?? join(homedir(), '.Xauthority')
  let cookie: Buffer | null = null
  try {
    cookie = xauthCookie(readFileSync(authority), number)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return connectX(`:${number}`, cookie, { timeoutMs: X_TIMEOUT_MS })
}

/** The 32-bit values of a property of format 32. */
function words(value: Buffer): number[] {
  return Array.from({ length: value.length / 4 }, (_, i) => value.readUInt32LE(i * 4))
}

interface AppWindow {
  window: number
  viewable: boolean
  /** Whether it lists WM_DELETE_WINDOW in WM_PROTOCOLS. */
  takesDelete: boolean
}

interface Atoms {
  netWmPid: number
  clientMachine: number
  protocols: number
  deleteWindow: number
}

/** The top-level windows of process `pid` on this machine: _NET_WM_PID is
 *  `pid` and WM_CLIENT_MACHINE this host's name, which the client sets, and
 *  the X server's own record of the creating client's process (X-Resource)
 *  is `pid` too. */
async function appWindows(x: XClient, pid: number): Promise<{ atoms: Atoms; windows: AppWindow[] }> {
  const [netWmPid, clientMachine, protocols, deleteWindow] = await Promise.all(
    ['_NET_WM_PID', 'WM_CLIENT_MACHINE', 'WM_PROTOCOLS', 'WM_DELETE_WINDOW'].map((name) => x.internAtom(name, true)),
  )
  const atoms = { netWmPid, clientMachine, protocols, deleteWindow }
  if ([netWmPid, clientMachine, protocols, deleteWindow].includes(0)) return { atoms, windows: [] }
  const host = hostname()
  const windows: AppWindow[] = []
  for (const window of await x.queryTree(x.root)) {
    let found: AppWindow
    try {
      const owner = await x.getProperty(window, netWmPid)
      if (owner?.format !== 32 || words(owner.value)[0] !== pid) continue
      const machine = await x.getProperty(window, clientMachine)
      if (machine?.format !== 8 || machine.value.toString('latin1').replace(/\0+$/, '') !== host) continue
      const taken = await x.getProperty(window, protocols)
      found = {
        window,
        viewable: await x.isViewable(window),
        takesDelete: taken?.format === 32 && words(taken.value).includes(deleteWindow),
      }
    } catch (err) {
      // An X error (BadWindow: destroyed since the listing) only skips the
      // window; a closed or silent connection fails.
      if (!(err instanceof Error) || !err.message.startsWith('X error')) throw err
      continue
    }
    // Outside the try: a server without X-Resource fails the check.
    if (!(await x.clientPids(window)).includes(pid)) continue
    windows.push(found)
  }
  return { atoms, windows }
}

/** How many top-level windows process `pid` has on screen (viewable).
 *  Only reads from the X server. */
export async function viewableWindowCount(pid: number): Promise<number> {
  const x = await connectDisplay()
  try {
    return (await appWindows(x, pid)).windows.filter((w) => w.viewable).length
  } finally {
    x.close()
  }
}

/** Sends WM_DELETE_WINDOW to the viewable top-level window of process
 *  `pid` (see {@link appWindows}) that takes the message, as a window
 *  manager's close button does. Throws unless exactly one window
 *  qualifies. */
export async function requestWindowClose(pid: number): Promise<void> {
  const x = await connectDisplay()
  try {
    const { atoms, windows } = await appWindows(x, pid)
    const found = windows.filter((w) => w.viewable && w.takesDelete)
    if (found.length !== 1) {
      throw new Error(`expected one viewable window of process ${pid} that takes WM_DELETE_WINDOW, found ${found.length}`)
    }
    const { window } = found[0]
    // data: the protocol, then the time (CurrentTime).
    x.sendEvent(window, clientMessage(window, atoms.protocols, [atoms.deleteWindow, 0]))
    await x.sync()
  } finally {
    x.close()
  }
}
