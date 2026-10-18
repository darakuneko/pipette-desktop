// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the X11 lookup of src-tauri/crates/pipette-active-window:
// runs the real @paymoapp/active-window binding (what Electron's
// app-monitor.ts loads) against a private Xvfb (x11/x-server.ts) on which
// this generator itself puts the properties a window manager would set —
// `_NET_ACTIVE_WINDOW` on the root window, `WM_CLASS`, `WM_NAME`,
// `_NET_WM_NAME` and `_NET_WM_PID` on the window — and records what the
// binding answers for each. A bare Xvfb has no window manager, so without
// these properties the binding finds no active window.
//
// The binding runs in a child Node process per case, with DISPLAY and
// XAUTHORITY of the private server and an empty HOME / XDG_DATA_DIRS (its icon
// lookup reads desktop entries from there; the icon is not recorded).
// No locale variable is passed, so the probe runs in the C locale. That does
// not change what is recorded: STRING titles are returned as raw bytes, and
// Xlib converts UTF8_STRING to UTF-8 whatever the locale. COMPOUND_TEXT,
// whose conversion does depend on the locale, is recorded only for an ASCII
// title, where every locale gives the same text.
//
// Needs `Xvfb` on PATH. Run: pnpm run generate:resident-fixtures

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { connectX, type XClient } from './x11/x-client'
import { startXServer, type XServer } from './x11/x-server'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-active-window/tests/fixtures/x11_active_window.json')

const execFileAsync = promisify(execFile)
const BINDING = createRequire(import.meta.url).resolve('@paymoapp/active-window')

/** What the binding gives: a window, or the exception `getActiveWindow`
 *  throws (`Error: Failed to get active window` when the native lookup finds
 *  no active window; app-monitor.ts then falls back to gdbus). */
type Answer = { kind: 'window'; application: string; title: string } | { kind: 'throws'; error: string }

const PROBE = `
const { ActiveWindow } = require(process.argv[1])
let out
try {
  ActiveWindow.initialize()
  const w = ActiveWindow.getActiveWindow()
  out = { kind: 'window', application: w.application, title: w.title }
} catch (err) {
  out = { kind: 'throws', error: String(err) }
}
process.stdout.write(JSON.stringify(out))
`

/** A property as the generator writes it: the type atom's name, the format
 *  and the bytes (hex). */
interface Prop {
  name: string
  type: string
  format: 8 | 32
  hex: string
}

/** Which window `_NET_ACTIVE_WINDOW` names. */
type Active =
  /** The atom `_NET_ACTIVE_WINDOW` does not exist on the server yet. */
  | 'no-atom'
  /** The atom exists, the root window has no such property. */
  | 'unset'
  /** The property holds 0 (None). */
  | 'none'
  /** A window that was destroyed before the lookup. */
  | 'destroyed'
  /** The case's window, with `props`. */
  | 'window'

interface Case {
  name: string
  active: Active
  props: Prop[]
  answer?: Answer
}

const text = (s: string, encoding: BufferEncoding = 'utf8'): string => Buffer.from(s, encoding).toString('hex')
const wmClass = (instance: string, cls: string): Prop => ({ name: 'WM_CLASS', type: 'STRING', format: 8, hex: text(`${instance}\0${cls}\0`) })
const wmName = (title: string, type = 'STRING', encoding: BufferEncoding = 'utf8'): Prop => ({ name: 'WM_NAME', type, format: 8, hex: text(title, encoding) })
const netWmName = (title: string): Prop => ({ name: '_NET_WM_NAME', type: 'UTF8_STRING', format: 8, hex: text(title) })
const pid = (value: number): Prop => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return { name: '_NET_WM_PID', type: 'CARDINAL', format: 32, hex: bytes.toString('hex') }
}
const raw = (name: string, type: string, hex: string): Prop => ({ name, type, format: 8, hex })

/** Every case a window manager's properties can put the binding in. The
 *  first two must stay first: they need atoms nobody has interned yet. */
const CASES: Case[] = [
  { name: 'bare server: no _NET_ACTIVE_WINDOW atom', active: 'no-atom', props: [] },
  { name: 'atom exists, root has no _NET_ACTIVE_WINDOW', active: 'unset', props: [] },
  { name: '_NET_ACTIVE_WINDOW is None', active: 'none', props: [] },
  { name: '_NET_ACTIVE_WINDOW names a destroyed window', active: 'destroyed', props: [] },
  {
    name: 'every property a window manager sets',
    active: 'window',
    props: [wmClass('code', 'Code'), wmName('main.ts — Visual Studio Code'), netWmName('main.ts — Visual Studio Code'), pid(4242)],
  },
  { name: 'no properties on the window', active: 'window', props: [] },
  { name: 'WM_CLASS only', active: 'window', props: [wmClass('org.gnome.Nautilus', 'Org.gnome.Nautilus')] },
  { name: 'WM_NAME only (STRING)', active: 'window', props: [wmName('Terminal')] },
  { name: '_NET_WM_NAME only (WM_NAME is what is read)', active: 'window', props: [netWmName('タイトル')] },
  { name: 'WM_NAME as UTF8_STRING', active: 'window', props: [wmClass('a', 'App'), wmName('日本語のタイトル 😀', 'UTF8_STRING')] },
  { name: 'WM_NAME as STRING with Latin-1 bytes', active: 'window', props: [wmClass('a', 'App'), wmName('Café', 'STRING', 'latin1')] },
  { name: 'WM_NAME as STRING with UTF-8 bytes', active: 'window', props: [wmClass('a', 'App'), wmName('Café', 'STRING')] },
  { name: 'WM_NAME as STRING with an embedded NUL', active: 'window', props: [wmClass('a', 'App'), raw('WM_NAME', 'STRING', text('before\0after'))] },
  { name: 'WM_NAME as UTF8_STRING with an embedded NUL', active: 'window', props: [wmClass('a', 'App'), raw('WM_NAME', 'UTF8_STRING', text('before\0after'))] },
  { name: 'WM_NAME as UTF8_STRING with invalid UTF-8', active: 'window', props: [wmClass('a', 'App'), raw('WM_NAME', 'UTF8_STRING', '41ff42c3')] },
  { name: 'WM_NAME as COMPOUND_TEXT (ASCII)', active: 'window', props: [wmClass('a', 'App'), wmName('Compound', 'COMPOUND_TEXT')] },
  { name: 'WM_NAME of an unknown type', active: 'window', props: [wmClass('a', 'App'), wmName('Other', 'PIPETTE_UNKNOWN_TYPE')] },
  { name: 'WM_NAME empty', active: 'window', props: [wmClass('a', 'App'), wmName('')] },
  { name: 'WM_NAME with control characters', active: 'window', props: [wmClass('a', 'App'), wmName('tab\there\nline\u0001')] },
  { name: 'WM_CLASS with one string and its NUL', active: 'window', props: [raw('WM_CLASS', 'STRING', text('only\0')), wmName('t')] },
  { name: 'WM_CLASS with one string, no NUL', active: 'window', props: [raw('WM_CLASS', 'STRING', text('only')), wmName('t')] },
  { name: 'WM_CLASS second string without its NUL', active: 'window', props: [raw('WM_CLASS', 'STRING', text('inst\0Class')), wmName('t')] },
  { name: 'WM_CLASS with an empty instance', active: 'window', props: [raw('WM_CLASS', 'STRING', text('\0Class\0')), wmName('t')] },
  { name: 'WM_CLASS with three strings', active: 'window', props: [raw('WM_CLASS', 'STRING', text('a\0B\0c\0')), wmName('t')] },
  { name: 'WM_CLASS empty', active: 'window', props: [raw('WM_CLASS', 'STRING', ''), wmName('t')] },
  { name: 'WM_CLASS as UTF8_STRING', active: 'window', props: [raw('WM_CLASS', 'UTF8_STRING', text('inst\0Class\0')), wmName('t')] },
  { name: 'WM_CLASS with Latin-1 bytes', active: 'window', props: [raw('WM_CLASS', 'STRING', text('inst\0Café\0', 'latin1')), wmName('t')] },
  { name: 'WM_CLASS with UTF-8 bytes', active: 'window', props: [raw('WM_CLASS', 'STRING', text('inst\0日本\0')), wmName('t')] },
  { name: 'long WM_NAME and WM_CLASS', active: 'window', props: [wmClass('i', 'C'.repeat(300)), wmName('T'.repeat(5000))] },
]

let server: XServer
let x: XClient
let home: string

async function probe(): Promise<Answer> {
  const { stdout } = await execFileAsync(process.execPath, ['-e', PROBE, BINDING], {
    env: { DISPLAY: server.display, XAUTHORITY: server.authFile, HOME: home, XDG_DATA_DIRS: home, PATH: process.env.PATH ?? '' },
    timeout: 10_000,
  })
  return JSON.parse(stdout) as Answer
}

async function setUp(c: Case): Promise<void> {
  if (c.active === 'no-atom') {
    expect(await x.internAtom('_NET_ACTIVE_WINDOW', true)).toBe(0)
    return
  }
  const active = await x.internAtom('_NET_ACTIVE_WINDOW')
  const windowAtom = await x.internAtom('WINDOW')
  if (c.active === 'unset') {
    x.deleteProperty(x.root, active)
    await x.sync()
    return
  }
  let target = 0
  if (c.active === 'destroyed') {
    target = x.createWindow()
    x.destroyWindow(target)
  } else if (c.active === 'window') {
    target = x.createWindow()
    for (const prop of c.props) {
      x.changeProperty(target, await x.internAtom(prop.name), await x.internAtom(prop.type), prop.format, Buffer.from(prop.hex, 'hex'))
    }
  }
  const value = Buffer.alloc(4)
  value.writeUInt32LE(target)
  x.changeProperty(x.root, active, windowAtom, 32, value)
  await x.sync()
}

describe('X11 active window through @paymoapp/active-window', () => {
  beforeAll(async () => {
    server = await startXServer()
    home = join(server.dir, 'home')
    mkdirSync(home)
    x = await connectX(server.display, server.cookie)
  }, 20_000)

  afterAll(async () => {
    x?.close()
    await server?.close()
  })

  it('records the binding against the properties a window manager sets', async () => {
    const cases: Case[] = []
    for (const c of CASES) {
      await setUp(c)
      cases.push({ ...c, answer: await probe() })
    }
    // The case with every property must give a real window, or the method
    // of recording (setting the properties ourselves) does not work.
    expect(cases[4].answer).toEqual({ kind: 'window', application: 'Code', title: 'main.ts — Visual Studio Code' })
    writeJsonFixture(OUT, {
      source: '@paymoapp/active-window getActiveWindow() on Xvfb with the properties of each case set by the generator',
      cases,
    })
  }, 120_000)
})
