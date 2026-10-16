// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-active-window: runs the real
// getCurrentAppName of src/main/typing-analytics/app-monitor.ts with a stub
// in place of the @paymoapp/active-window binding and of the gdbus process,
// and records what it returns for each combination of what the native lookup
// gives (a window, null, an exception, no binding), what gdbus prints (or
// that it fails), and the platform; with the number of gdbus runs and whether
// it warned. The name normalization and the gdbus output parsing are recorded
// through the same call. The Rust crate must give the same results.
//
// Run: pnpm run generate:active-window-fixtures

import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeJsonFixture } from '../fixture-files'
import { random32 } from '../fixture-random'
import { REPO_ROOT } from '../fixture-vitest-config'

const OUT = resolve(
  REPO_ROOT,
  'src-tauri/crates/pipette-active-window/tests/fixtures/app_monitor.json',
)

vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: () => ({ typingMonitorAppEnabled: true }),
}))

/** What the stubbed gdbus does: print `stdout` and exit 0, or fail. */
type Gdbus = { stdout: string } | { fails: true }

let gdbus: Gdbus = { fails: true }
const gdbusRuns: { command: string; options: unknown }[] = []

vi.mock('node:child_process', () => {
  function exec(
    command: string,
    options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ): void {
    gdbusRuns.push({ command, options })
    if ('stdout' in gdbus) callback(null, gdbus.stdout, '')
    else callback(new Error('Command failed'), '', 'Error: GDBus.Error')
  }
  // Like the real exec, the promisified form resolves to { stdout, stderr }.
  Object.defineProperty(exec, promisify.custom, {
    value: (command: string, options: unknown) =>
      new Promise((res, rej) => {
        exec(command, options, (err, stdout, stderr) =>
          err ? rej(err) : res({ stdout, stderr }),
        )
      }),
  })
  return { exec }
})

import {
  getCurrentAppName,
  __setAppMonitorLibForTests,
} from '../../src/main/typing-analytics/app-monitor'

type Native =
  | { kind: 'unavailable' }
  | { kind: 'throws' }
  | { kind: 'null' }
  | { kind: 'window'; application: string; title: string }

type Platform = 'linux' | 'darwin'

interface Case {
  platform: Platform
  native: Native
  gdbus: Gdbus
  result: string | null
  gdbusRuns: number
  warned: boolean
}

const realPlatform = process.platform

async function record(platform: Platform, native: Native, stub: Gdbus): Promise<Case> {
  Object.defineProperty(process, 'platform', { value: platform })
  gdbus = stub
  const runsBefore = gdbusRuns.length
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    __setAppMonitorLibForTests(
      native.kind === 'unavailable'
        ? null
        : {
            initialize: () => {},
            getActiveWindow: () => {
              if (native.kind === 'throws') throw new Error('Failed to get active window')
              if (native.kind === 'null') return null
              return { application: native.application, title: native.title }
            },
          },
    )
    const result = await getCurrentAppName()
    return {
      platform,
      native,
      gdbus: stub,
      result,
      gdbusRuns: gdbusRuns.length - runsBefore,
      warned: warn.mock.calls.length > 0,
    }
  } finally {
    warn.mockRestore()
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
}

/** Names the normalization must handle: control characters, the edges of
 *  JavaScript's trim (U+FEFF is trimmed, U+0085 and U+200B are not), the
 *  256-unit cut (which can split a surrogate pair) and lone surrogates. */
const NAMES = [
  'VSCode', '', ' ', '   ', '\t\n\v\f\r x \r\n', 'Bad\u0001Name', '\u0000\u001f\u007f',
  'a\u0080b\u009fc', '\u0085x\u0085', ' \u0085 ', '﻿x﻿', '　全角　', ' x ',
  '​x​', ' x᠎', ' x ', '  x  ', 'x\u0000 ',
  ' \u0000x', '日本語', 'Ä', '😀', 'A'.repeat(1000), 'A'.repeat(256), 'A'.repeat(257),
  'A'.repeat(255) + '😀', 'A'.repeat(254) + '😀', '\u0001'.repeat(10) + 'A'.repeat(300),
  ' '.repeat(10) + 'B'.repeat(300), 'x'.repeat(255) + ' y', '\ud800', 'a\udc00b', '\udc00\ud800',
  'main.ts — pipette-desktop — Visual Studio Code', 'org.gnome.Nautilus',
]

/** Code units the random names are drawn from. */
const ALPHABET = [
  0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1f, 0x20, 0x41, 0x2e, 0x7e, 0x7f, 0x85, 0xa0, 0x3042, 0x2028,
  0x200b, 0x3000, 0xfeff, 0xd83d, 0xde00, 0xd800, 0xdc00,
]

function randomNames(count: number): string[] {
  const next = random32(0xac71e)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const length = next() % 280
    const units: number[] = []
    for (let j = 0; j < length; j++) units.push(ALPHABET[next() % ALPHABET.length])
    names.push(String.fromCharCode(...units))
  }
  return names
}

function gvariant(json: string): string {
  return `('${json}',)\n`
}

/** gdbus output: what the FocusedWindow extension prints and malformed or
 *  unexpected variants of it. */
const GDBUS_OUTPUTS = [
  gvariant('{"wm_class":"org.gnome.Nautilus","title":"Home"}'),
  gvariant(
    '{"title":"main.ts - pipette","wm_class":"Code","wm_class_instance":"code","pid":4242,"id":123456,' +
      '"width":1920,"height":1080,"x":0,"y":0,"focus":true,"in_current_workspace":true,"maximized":1,' +
      '"display":{},"frame_type":0,"window_type":0,"layer":2,"monitor":0,"role":"","area":{}}',
  ),
  gvariant('{"wm_class":"gnome-terminal-server"}'),
  gvariant('{"wm_class":"org.mozilla.firefox"}'),
  gvariant('{"wm_class":"日本語.アプリ"}'),
  gvariant('{"wm_class":"org. x "}'),
  gvariant('{"wm_class":"a.b."}'),
  gvariant('{"wm_class":"."}'),
  gvariant('{"wm_class":""}'),
  gvariant('{"wm_class":null}'),
  gvariant('{"title":"no class"}'),
  gvariant('{"wm_class":5}'),
  gvariant('{"wm_class":0}'),
  gvariant('{"wm_class":true}'),
  gvariant('{"wm_class":["a.b"]}'),
  gvariant('{"wm_class":{"x":1}}'),
  gvariant('{"wm_class":"X\\u0000Y"}'),
  gvariant('{"wm_class":"\\u0001"}'),
  gvariant('{"wm_class":"a.\\ud800"}'),
  gvariant('{"wm_class":"\\ud83d\\ude00.x"}'),
  gvariant(`{"wm_class":"${'L'.repeat(300)}"}`),
  gvariant('{"wm_class":"A","wm_class":"B"}'),
  gvariant('{ "wm_class" : "Spaced" }'),
  // A ' in the JSON makes gdbus quote with " and escape each " (not JSON).
  `("{\\"title\\":\\"it's\\",\\"wm_class\\":\\"Quoted\\"}",)\n`,
  // A \ in the JSON is doubled (still JSON, with the wm_class intact).
  gvariant('{"title":"C:\\\\\\\\dir","wm_class":"Slash"}'),
  gvariant('null'),
  gvariant('"org.x"'),
  gvariant('[]'),
  gvariant('1'),
  `('{"wm_class":"NoNewline"}',)`,
  `  ('{"wm_class":"Padded"}',)  \n\n`,
  `('{"wm_class":"Crlf"}',)\r\n`,
  `﻿('{"wm_class":"Bom"}',)﻿`,
  `('{"wm_class":"X"}' ,)\n`,
  `("{\\"wm_class\\":\\"X\\"}",)\n`,
  `('{"wm_class":"X"}',)\n('{"wm_class":"Y"}',)\n`,
  `(😀{"wm_class":"X"}',)`,
  `('{"wm_class":"X"}😀,)`,
  `('{"wm_class":"X"}x😀)`,
  'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable\n',
  '()',
  '(\'\',)',
  '',
  '\n',
  '1234',
  '12345',
]

const NATIVE_KINDS: Native[] = [
  { kind: 'unavailable' },
  { kind: 'throws' },
  { kind: 'null' },
  { kind: 'window', application: 'App', title: 'Title' },
  { kind: 'window', application: '', title: 'Title' },
  { kind: 'window', application: ' \u0001 ', title: ' Title ' },
  { kind: 'window', application: '', title: '' },
  { kind: 'window', application: ' \u0001 ', title: '\t\u007f' },
]

describe('active-window fixtures', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('records getCurrentAppName', async () => {
    const cases: Case[] = []
    const window = (application: string, title: string): Native => ({
      kind: 'window',
      application,
      title,
    })
    // Normalization of the application name, then of the title.
    for (const name of NAMES) {
      cases.push(await record('linux', window(name, ''), { fails: true }))
      cases.push(await record('linux', window('', name), { fails: true }))
    }
    for (const name of randomNames(60)) {
      cases.push(await record('linux', window(name, ''), { fails: true }))
    }
    // Parsing of the gdbus output.
    for (const stdout of GDBUS_OUTPUTS) {
      cases.push(await record('linux', { kind: 'null' }, { stdout }))
    }
    // The fallback order, with and without gdbus (Linux only).
    for (const platform of ['linux', 'darwin'] as const) {
      for (const native of NATIVE_KINDS) {
        for (const stub of [{ stdout: gvariant('{"wm_class":"org.gnome.Shell"}') }, { fails: true as const }]) {
          cases.push(await record(platform, native, stub))
        }
      }
    }

    const commands = new Set(gdbusRuns.map((run) => JSON.stringify(run)))
    expect(commands.size).toBe(1)
    const [{ command, options }] = gdbusRuns
    writeJsonFixture(OUT, { gdbusCommand: command, gdbusOptions: options, cases })
  })
})
