// SPDX-License-Identifier: GPL-2.0-or-later
//
// The window's close button, pressed from outside the app. WebDriver's
// Close Window destroys the webview instead of asking the window to close,
// so the app would never see the close request. Under X11 the close button
// of a window manager sends the window a WM_DELETE_WINDOW ClientMessage
// (ICCCM), which GTK turns into the window's close request; the tests' X
// server runs no window manager, so this sends that message itself, on the
// X server of DISPLAY with the cookie of XAUTHORITY (xvfb-run sets both).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { clientMessage, connectX, type XClient } from '../../scripts/resident-fixtures/x11/x-client'

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

/** The X server of DISPLAY, which must be a local `:<n>`. */
async function connectDisplay(): Promise<XClient> {
  const display = process.env.DISPLAY
  const number = display === undefined ? undefined : /^:(\d+)(?:\.\d+)?$/.exec(display)?.[1]
  if (number === undefined) throw new Error(`the close request needs a local X display, not DISPLAY=${String(display)}`)
  const authority = process.env.XAUTHORITY ?? join(homedir(), '.Xauthority')
  let cookie: Buffer | null = null
  try {
    cookie = xauthCookie(readFileSync(authority), number)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return connectX(`:${number}`, cookie)
}

/** The 32-bit values of a property of format 32. */
function words(value: Buffer): number[] {
  return Array.from({ length: value.length / 4 }, (_, i) => value.readUInt32LE(i * 4))
}

/** Sends WM_DELETE_WINDOW to the viewable top-level window of process
 *  `pid` (its _NET_WM_PID) that takes the message (lists it in
 *  WM_PROTOCOLS), as a window manager's close button does. Throws unless
 *  exactly one window qualifies. */
export async function requestWindowClose(pid: number): Promise<void> {
  const x = await connectDisplay()
  try {
    const [netWmPid, protocols, deleteWindow] = await Promise.all([
      x.internAtom('_NET_WM_PID', true),
      x.internAtom('WM_PROTOCOLS', true),
      x.internAtom('WM_DELETE_WINDOW', true),
    ])
    if (netWmPid === 0 || protocols === 0 || deleteWindow === 0) {
      throw new Error('no window on the X server has the properties of a GTK window')
    }
    const found: number[] = []
    for (const window of await x.queryTree(x.root)) {
      try {
        const owner = await x.getProperty(window, netWmPid)
        if (owner?.format !== 32 || words(owner.value)[0] !== pid) continue
        if (!(await x.isViewable(window))) continue
        const taken = await x.getProperty(window, protocols)
        if (taken?.format === 32 && words(taken.value).includes(deleteWindow)) found.push(window)
      } catch {
        // Destroyed since the listing (BadWindow): not the app's window.
      }
    }
    if (found.length !== 1) {
      throw new Error(`expected one viewable window of process ${pid} that takes WM_DELETE_WINDOW, found ${found.length}`)
    }
    // data: the protocol, then the time (CurrentTime).
    x.sendEvent(found[0], clientMessage(found[0], protocols, [deleteWindow, 0]))
    await x.sync()
  } finally {
    x.close()
  }
}
