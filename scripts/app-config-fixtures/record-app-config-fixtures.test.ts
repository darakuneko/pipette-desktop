// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-app-config:
// - data/defaults.json: DEFAULT_APP_CONFIG (in its key order),
//   SETTABLE_APP_CONFIG_KEYS and the zoom factor range, the crate's source
//   for them;
// - tests/fixtures/scenarios.json: steps run through the real
//   src/main/app-config.ts on the real electron-store and conf in a temp
//   directory, with the bytes of config.json after each step, what the
//   step returned and which change callbacks it fired;
// - tests/fixtures/coercions.json: clampZoomFactor and Boolean() of
//   assorted values.
//
// Run: pnpm run generate:app-config-fixtures

import { afterAll, describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({ dir: '', handlers: new Map<string, Handler>() }))

vi.mock('electron', () => {
  const app = { getPath: () => state.dir, getVersion: () => '0.0.0' }
  const ipcMain = { on: () => undefined, handle: () => undefined }
  const screen = { getAllDisplays: () => [] }
  return { default: { app, ipcMain, shell: {}, screen }, app, ipcMain, screen }
})
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
}))

import {
  DEFAULT_APP_CONFIG,
  SETTABLE_APP_CONFIG_KEYS,
  ZOOM_FACTOR_DEFAULT,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_MIN,
  clampZoomFactor,
} from '../../src/shared/types/app-config'
import { IpcChannels } from '../../src/shared/ipc/channels'

const CRATE = resolve(REPO_ROOT, 'src-tauri/crates/pipette-app-config')

/** A step; JSON values are given as JSON texts. */
type Step =
  | { op: 'write'; text: string }
  | { op: 'writeHex'; hex: string }
  | { op: 'delete' }
  | { op: 'start' }
  | { op: 'getAll' }
  | { op: 'ipcSet'; key: string; value: string }
  | { op: 'ipcSetUndefined'; key: string }
  | { op: 'set'; key: string; value: string }
  | { op: 'clear' }
  | { op: 'replace'; value: string }

interface Outcome {
  /** config.json after the step, or null when there is none. */
  file: string | null
  /** JSON.stringify of what the step returned, for start and getAll. */
  result?: string
  /** The error the step threw. */
  error?: { name: string; message: string }
  /** The change callbacks fired, with JSON.stringify of the value. */
  notified?: [string, string][]
}

type AppConfigModule = typeof import('../../src/main/app-config')

let module: AppConfigModule | null = null
let notified: [string, string][] = []

async function start(): Promise<unknown> {
  vi.resetModules()
  state.handlers.clear()
  module = null
  const loaded = await import('../../src/main/app-config')
  loaded.setupAppConfigIpc()
  loaded.onAppConfigChange((key, value) => notified.push([key, JSON.stringify(value)]))
  module = loaded
  return loaded.loadAppConfig()
}

function current(): AppConfigModule {
  if (!module) throw new Error('step before start')
  return module
}

function handler(channel: string): Handler {
  const found = state.handlers.get(channel)
  if (!found) throw new Error(`no handler for ${channel}`)
  return found
}

async function run(step: Step, path: string): Promise<Omit<Outcome, 'file'>> {
  switch (step.op) {
    case 'write': writeFileSync(path, step.text); return {}
    case 'writeHex': writeFileSync(path, Buffer.from(step.hex, 'hex')); return {}
    case 'delete': unlinkSync(path); return {}
    case 'start': return { result: JSON.stringify(await start()) }
    case 'getAll': return { result: JSON.stringify(handler(IpcChannels.APP_CONFIG_GET_ALL)({})) }
    case 'ipcSet': handler(IpcChannels.APP_CONFIG_SET)({}, step.key, JSON.parse(step.value)); return {}
    case 'ipcSetUndefined': handler(IpcChannels.APP_CONFIG_SET)({}, step.key, undefined); return {}
    case 'set': current().getAppConfigStore().set(step.key as 'theme', JSON.parse(step.value)); return {}
    case 'clear': current().getAppConfigStore().clear(); return {}
    case 'replace': current().saveAppConfig(JSON.parse(step.value)); return {}
  }
}

async function runScenario(steps: Step[]): Promise<(Step & Outcome)[]> {
  state.dir = mkdtempSync(join(tmpdir(), 'pipette-app-config-'))
  const path = join(state.dir, 'config.json')
  const recorded = []
  try {
    for (const step of steps) {
      notified = []
      let outcome: Omit<Outcome, 'file'>
      try {
        outcome = await run(step, path)
      } catch (err) {
        const { name, message } = err as Error
        outcome = { error: { name, message } }
      }
      if (step.op === 'ipcSet' || step.op === 'ipcSetUndefined') outcome.notified = notified
      recorded.push({ ...step, ...outcome, file: existsSync(path) ? readFileSync(path, 'utf8') : null })
    }
  } finally {
    rmSync(state.dir, { recursive: true, force: true })
  }
  return recorded
}

const set = (key: string, value: unknown): Step => ({ op: 'ipcSet', key, value: JSON.stringify(value) })
const write = (text: string): Step => ({ op: 'write', text })
const START: Step = { op: 'start' }
const GET_ALL: Step = { op: 'getAll' }

/** Every default key, in the reverse order, on one line. */
const REORDERED_DEFAULTS = JSON.stringify(Object.fromEntries(Object.entries(DEFAULT_APP_CONFIG).reverse()))

const LANGUAGES = ['ja', 'en', 'pack:foo', 'builtin:en', 'fr', '', 5, null, true]

const SCENARIOS: Record<string, Step[]> = {
  new: [START, GET_ALL, set('theme', 'dark'), GET_ALL],
  'set writes the same value again': [START, write('{"theme":"dark"}'), set('theme', 'dark')],
  'missing defaults and unknown keys': [write('{"theme":"dark","zzz":1,"10":"ten","autoSync":true,"2":[]}'), START, GET_ALL],
  'every default in another order is not rewritten': [write(REORDERED_DEFAULTS), START, GET_ALL],
  'duplicate keys': [write('{"theme":"dark","zzz":1,"theme":"light"}'), START],
  'numbers in the file': [write('{"maxKeymapHistory":100.0,"zoomFactor":1e2,"a":9007199254740993,"b":-0,"c":1E400,"d":0.1,"e":1e21,"f":1e-7}'), START],
  'invalid UTF-8 in a string': [{ op: 'writeHex', hex: Buffer.from('{"theme":"\xff"}', 'latin1').toString('hex') }, START],
  ...Object.fromEntries(LANGUAGES.map((language) => [
    `language ${JSON.stringify(language)}`,
    [write(JSON.stringify({ language, theme: 'light' })), START, GET_ALL, START],
  ])),
  'language missing': [write('{"theme":"light"}'), START],
  'language migration runs on start only': [START, set('language', 'ja'), GET_ALL],
  'ipc values': [
    START,
    set('lastDevice', null),
    set('lastDevice', { vendorId: 1, productId: 2, serialNumber: 'x', nested: { b: 1, 10: 2, 2: 3 } }),
    set('zoomFactor', 0.1),
    set('zoomFactor', 1e21),
    set('zoomFactor', -0),
    set('maxKeymapHistory', 9007199254740993),
    set('maxKeymapHistory', 1e-7),
    set('theme', '日本語😀 é'),
    set('theme', '\u0001\n\t"\\\u007f '),
    { op: 'ipcSet', key: 'theme', value: '"\\ud800x\\udc00"' },
    set('theme', ''),
    set('autoSync', [1, 'a', null, { z: 1 }]),
    set('trayResident', true),
    GET_ALL,
  ],
  'keys the IPC does not set': [
    START,
    set('windowState', { x: 0, y: 0, width: 1, height: 1 }),
    set('foo', 1),
    set('__internal__', 1),
    { op: 'ipcSetUndefined', key: 'theme' },
    { op: 'ipcSetUndefined', key: 'foo' },
  ],
  'direct set': [
    START,
    { op: 'set', key: 'windowState', value: '{"x":-1,"y":-1,"width":1440,"height":1024}' },
    { op: 'set', key: '10', value: '"ten"' },
    { op: 'set', key: '__internal__', value: '1' },
    { op: 'set', key: '__internal__.migrations', value: '1' },
  ],
  'clear and replace keep __internal__': [
    write('{"theme":"dark","__internal__":{"migrations":{"version":"1.0.0"}},"zzz":1}'),
    START,
    set('theme', 'light'),
    { op: 'clear' },
    { op: 'replace', value: '{"theme":"light","autoSync":true}' },
    { op: 'replace', value: '{"__internal__":{"other":1},"theme":"dark"}' },
    { op: 'clear' },
  ],
  'clear without __internal__': [write('{"theme":"dark","zzz":1}'), START, { op: 'clear' }],
  ...Object.fromEntries(['[1,2]', '"ab"', '"\\ud800x"', 'null', '5', 'true'].map((text) => [
    `top-level ${text}`,
    [write(text), START],
  ])),
  'file deleted after start': [START, { op: 'delete' }, GET_ALL, set('theme', 'dark'), GET_ALL],
  ...Object.fromEntries(['{"theme":', '', '﻿{}', '{"a":1}x', '{"a":"\\x"}'].map((text) => [
    `invalid JSON at start ${JSON.stringify(text)}`,
    [write(text), START],
  ])),
  'invalid JSON after start': [START, write('{"theme":'), GET_ALL, set('theme', 'dark')],
}

const COERCION_INPUTS = [
  'undefined', 'null', 'true', 'false', '0', '-0', '1', '49.4', '49.5', '50.5', '99.5', '100.5', '-0.5',
  '0.49999999999999994', '150.49999999999997', '199.5', '200.5', '250', '1e400', '-1e400', '"100"',
  '"false"', '""', '[]', '{}', '[0]',
]

describe('app config fixtures', () => {
  afterAll(() => vi.resetModules())

  it('records the defaults, the settable keys and the zoom range', () => {
    writeJsonFixture(resolve(CRATE, 'data/defaults.json'), {
      defaults: DEFAULT_APP_CONFIG,
      settableKeys: [...SETTABLE_APP_CONFIG_KEYS],
      zoomFactor: { min: ZOOM_FACTOR_MIN, max: ZOOM_FACTOR_MAX, default: ZOOM_FACTOR_DEFAULT },
    })
  })

  it('records clampZoomFactor and Boolean of each value', () => {
    const cases = COERCION_INPUTS.map((input) => {
      const value: unknown = input === 'undefined' ? undefined : JSON.parse(input)
      return { input, zoomFactor: clampZoomFactor(value), boolean: Boolean(value) }
    })
    writeJsonFixture(resolve(CRATE, 'tests/fixtures/coercions.json'), cases)
  })

  it('records each scenario on the real electron-store', async () => {
    const scenarios = []
    for (const [name, steps] of Object.entries(SCENARIOS)) {
      scenarios.push({ name, steps: await runScenario(steps) })
    }
    writeJsonFixture(resolve(CRATE, 'tests/fixtures/scenarios.json'), scenarios)

    const all = scenarios.flatMap((s) => s.steps)
    expect(all.some((s) => s.op === 'start' && s.error?.name === 'SyntaxError')).toBe(true)
    expect(all.some((s) => s.op === 'ipcSetUndefined' && s.error?.name === 'TypeError')).toBe(true)
    expect(all.some((s) => (s.notified?.length ?? 0) > 0)).toBe(true)
  })
})
