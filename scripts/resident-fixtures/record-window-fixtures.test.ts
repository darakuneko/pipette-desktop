// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the window operations of the Tauri app
// (src-tauri/tests): boots Electron's src/main/index.ts on the harness and
// records, through the window IPC handlers of `setupWindowIpc` and the
// window / screen events, every call made on the BrowserWindow with the fake
// clock's time — compact mode entered, entered twice, left, left while
// entering, entered while leaving, the window destroyed mid-animation (the
// `setBounds` steps of `animateBounds`, the first one without waiting for a
// timer, then every 16 ms), the minimum sizes, the aspect-ratio arguments,
// always-on-top and its support check, the opacity clamp, the work-area
// changes (`display-metrics-changed`, `moved`) and the bounds saved on close.
//
// The window's frame (outer minus content size) is the harness's `frame`;
// `setBounds` applies exactly what it is given.
//
// Run: pnpm run generate:resident-fixtures

import { describe, it, vi } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { writeJsonFixture } from '../fixture-files'
import { boot, withPlatformAndEnv, type BootOptions } from './boot'
import { changeDisplays } from './electron-mock'
import { DEFAULT_DISPLAY, harnessState, invoke, type Display, type Rect } from './harness'
import { residentFixturePath, step, takeRecorded, type Scenario, type Step } from './steps'

const OUT = residentFixturePath('window_ops.json')

/** Long enough for any animation of `animateBounds` to finish. */
const SETTLE_MS = 1_000

const WINDOW: Rect = { x: 100, y: 0, width: 1400, height: 1040 }

function window0(): ReturnType<typeof harnessState>['windows'][number] {
  return harnessState().windows[0]
}

/** Starts `run`, lets `advanceMs` of the fake clock pass and returns its
 *  value, or `{ pending: true }` when it has not settled by then (a later
 *  `settle` step returns it). */
const pending = new Map<string, Promise<unknown>>()

function timed(action: Record<string, unknown>, run: () => unknown, advanceMs: number, key?: string): Promise<Step> {
  return step({ ...action, advanceMs }, async () => {
    let settled = false
    let value: unknown
    const promise = Promise.resolve(run()).then((v) => {
      settled = true
      value = v
      return v
    })
    await vi.advanceTimersByTimeAsync(advanceMs)
    if (settled) return value === undefined ? { value: 'undefined' } : { value }
    if (key !== undefined) pending.set(key, promise)
    return { pending: true }
  })
}

/** Waits for a call `timed` left pending, letting `advanceMs` pass. */
function settle(key: string, advanceMs: number): Promise<Step> {
  return step({ settle: key, advanceMs }, async () => {
    const promise = pending.get(key)
    if (promise === undefined) throw new Error(`nothing pending as ${key}`)
    pending.delete(key)
    await vi.advanceTimersByTimeAsync(advanceMs)
    const value = await promise
    return value === undefined ? { value: 'undefined' } : { value }
  })
}

const compact = (enabled: boolean, size?: unknown, advanceMs = SETTLE_MS, key?: string): Promise<Step> =>
  timed(
    { ipc: 'WINDOW_SET_COMPACT_MODE', args: size === undefined ? [enabled] : [enabled, size] },
    () => (size === undefined ? invoke(IpcChannels.WINDOW_SET_COMPACT_MODE, enabled) : invoke(IpcChannels.WINDOW_SET_COMPACT_MODE, enabled, size)),
    advanceMs,
    key,
  )

const ipc = (name: keyof typeof IpcChannels, ...args: unknown[]): Promise<Step> =>
  step({ ipc: name, args }, async () => {
    const value = await invoke(IpcChannels[name], ...args)
    return value === undefined ? { value: 'undefined' } : { value }
  })

const windowEvent = (event: string): Promise<Step> =>
  step({ windowEvent: event }, () => {
    window0().emit(event, { preventDefault: () => undefined })
  })

const setWindowState = (change: Partial<{ maximized: boolean; fullScreen: boolean; bounds: Rect }>): Promise<Step> =>
  step({ windowState: change }, () => {
    const w = window0() as unknown as { maximized: boolean; fullScreen: boolean; bounds: Rect }
    if (change.maximized !== undefined) w.maximized = change.maximized
    if (change.fullScreen !== undefined) w.fullScreen = change.fullScreen
    if (change.bounds !== undefined) w.bounds = { ...change.bounds }
  })

const displays = (list: Display[]): Promise<Step> => step({ displayMetricsChanged: list }, () => changeDisplays(list))

const destroy = (): Promise<Step> => step({ destroyWindow: true }, () => window0().destroy())

async function scenario(name: string, options: BootOptions, steps: () => Promise<Step[]>): Promise<Scenario> {
  const bootOptions: BootOptions = { windowState: WINDOW, ...options }
  await boot(bootOptions)
  const bootCalls = takeRecorded().calls
  const out = { name, boot: { ...bootOptions, frame: harnessState().frame }, bootCalls, steps: await steps() }
  if (pending.size > 0) throw new Error(`${name}: left pending ${[...pending.keys()].join(', ')}`)
  return out
}

const SMALL_DISPLAY: Display = {
  id: 2,
  bounds: { x: 0, y: 0, width: 1024, height: 768 },
  workArea: { x: 0, y: 0, width: 1024, height: 720 },
}

const SECOND_DISPLAY: Display = {
  id: 3,
  bounds: { x: 1920, y: 0, width: 1280, height: 800 },
  workArea: { x: 1920, y: 0, width: 1280, height: 760 },
}

async function compactScenarios(): Promise<Scenario[]> {
  const out: Scenario[] = []
  out.push(
    await scenario('compact: enter, then leave', {}, async () => [
      await compact(true, { width: 400, height: 120 }),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: the animation step by step', {}, async () => [
      await compact(true, { width: 400, height: 120 }, 0),
      await step({ advanceMs: 16 }, () => vi.advanceTimersByTimeAsync(16)),
      await step({ advanceMs: 15 }, () => vi.advanceTimersByTimeAsync(15)),
      await step({ advanceMs: 1 }, () => vi.advanceTimersByTimeAsync(1)),
      await step({ advanceMs: SETTLE_MS }, () => vi.advanceTimersByTimeAsync(SETTLE_MS)),
      await compact(false, undefined, 0, 'leave'),
      await settle('leave', SETTLE_MS),
    ]),
  )
  out.push(
    await scenario('compact: sizes rounded up to 300x100, none and invalid ones', { frame: { width: 10, height: 40 } }, async () => [
      await compact(true, { width: 50, height: 20 }),
      await compact(true, { width: 290, height: 60 }),
      await compact(true, { width: 291, height: 61 }),
      await compact(true, { width: 400.4, height: 120.6 }),
      await compact(true, { width: 0, height: 120 }),
      await compact(true, { width: 400, height: -1 }),
      await compact(true),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: entered twice keeps the first normal size', {}, async () => [
      await compact(true, { width: 400, height: 120 }),
      await setWindowState({ bounds: { x: 600, y: 400, width: 500, height: 300 } }),
      await compact(true, { width: 600, height: 200 }),
      await compact(false),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: left while entering', {}, async () => [
      await compact(true, { width: 400, height: 120 }, 50),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: entered while leaving', {}, async () => [
      await compact(true, { width: 400, height: 120 }),
      await compact(false, undefined, 100, 'leave'),
      await compact(true, { width: 500, height: 150 }, 0),
      await settle('leave', SETTLE_MS),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: window destroyed while leaving', {}, async () => [
      await compact(true, { width: 400, height: 120 }),
      await compact(false, undefined, 100, 'leave'),
      await destroy(),
      await settle('leave', SETTLE_MS),
    ]),
  )
  out.push(
    await scenario('compact: window destroyed while entering', {}, async () => [
      await compact(true, { width: 400, height: 120 }, 50),
      await destroy(),
      await step({ advanceMs: SETTLE_MS }, () => vi.advanceTimersByTimeAsync(SETTLE_MS)),
    ]),
  )
  out.push(
    await scenario('compact: left without entering, window smaller than the minimum', { windowState: { x: 50, y: 60, width: 1000, height: 700 } }, async () => [
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: left without entering, window in range', {}, async () => [await compact(false)]),
  )
  out.push(
    await scenario('compact: left near the work area edge', {}, async () => [
      await compact(true, { width: 400, height: 120 }),
      await setWindowState({ bounds: { x: 1700, y: 950, width: 400, height: 157 } }),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: left on a smaller display', { displays: [SMALL_DISPLAY], windowState: { x: 0, y: 0, width: 1024, height: 720 } }, async () => [
      await compact(true, { width: 400, height: 120 }),
      await compact(false),
    ]),
  )
  out.push(
    await scenario('compact: close saves the normal size', {}, async () => [
      await compact(true, { width: 400, height: 120 }),
      await windowEvent('close'),
      await compact(false),
      await windowEvent('close'),
    ]),
  )
  return out
}

async function displayScenarios(): Promise<Scenario[]> {
  const out: Scenario[] = []
  out.push(
    await scenario('work area changes', {}, async () => [
      await displays([DEFAULT_DISPLAY]),
      await displays([{ ...DEFAULT_DISPLAY, workArea: { x: 0, y: 40, width: 1920, height: 1000 } }]),
      await displays([SMALL_DISPLAY]),
      await displays([SMALL_DISPLAY]),
      await displays([DEFAULT_DISPLAY]),
      await setWindowState({ maximized: true }),
      await displays([SMALL_DISPLAY]),
      await setWindowState({ maximized: false, fullScreen: true }),
      await displays([SMALL_DISPLAY]),
      await setWindowState({ fullScreen: false }),
      await compact(true, { width: 400, height: 120 }),
      await displays([{ ...SMALL_DISPLAY, workArea: { x: 0, y: 0, width: 200, height: 80 } }]),
      await compact(false),
      await displays([SMALL_DISPLAY]),
    ]),
  )
  out.push(
    await scenario('moved between displays', { displays: [DEFAULT_DISPLAY, SECOND_DISPLAY] }, async () => [
      await windowEvent('moved'),
      await setWindowState({ bounds: { x: 1950, y: 10, width: 1200, height: 700 } }),
      await windowEvent('moved'),
      await windowEvent('moved'),
      await compact(true, { width: 400, height: 120 }),
      await setWindowState({ bounds: { x: 100, y: 10, width: 400, height: 157 } }),
      await windowEvent('moved'),
      await compact(false),
      await windowEvent('moved'),
    ]),
  )
  out.push(
    await scenario('closed window stops listening to the screen', {}, async () => [
      await windowEvent('closed'),
      await displays([SMALL_DISPLAY]),
    ]),
  )
  return out
}

async function simpleScenarios(): Promise<Scenario[]> {
  const out: Scenario[] = []
  out.push(
    await scenario('aspect ratio', {}, async () => [
      await ipc('WINDOW_SET_ASPECT_RATIO', 16 / 9),
      await ipc('WINDOW_SET_ASPECT_RATIO', 1),
      await ipc('WINDOW_SET_ASPECT_RATIO', 0.25),
      await ipc('WINDOW_SET_ASPECT_RATIO', 1e-9),
      await ipc('WINDOW_SET_ASPECT_RATIO', 0),
      await ipc('WINDOW_SET_ASPECT_RATIO', -1),
    ]),
  )
  out.push(
    await scenario('aspect ratio with a frame on both sides', { frame: { width: 10, height: 40 } }, async () => [
      await ipc('WINDOW_SET_ASPECT_RATIO', 2.5),
      await compact(true, { width: 400, height: 120 }),
      await ipc('WINDOW_SET_ASPECT_RATIO', 400 / 120),
      await ipc('WINDOW_SET_ASPECT_RATIO', 0),
    ]),
  )
  out.push(
    await scenario('always on top', {}, async () => [
      await ipc('WINDOW_SET_ALWAYS_ON_TOP', true),
      await ipc('WINDOW_SET_ALWAYS_ON_TOP', false),
    ]),
  )
  out.push(
    await scenario('opacity', {}, async () => {
      const steps: Step[] = []
      for (const value of [0.75, 0.5, 1, 0.49, 0, -1, 1.01, 2, 0.123456, '0.8', null, true, [0.7], {}]) {
        steps.push(await ipc('WINDOW_SET_OPACITY', value))
      }
      return steps
    }),
  )
  out.push(
    await scenario('minimum size', {}, async () => {
      const steps: Step[] = []
      for (const [w, h] of [[800, 600], [800, 600], [0, 0], [0, 0], [-5, 2.5], [1.5, 0.25], [1280, 1024], [1e6, 1e6]]) {
        steps.push(await ipc('WINDOW_SET_MIN_SIZE', w, h))
      }
      return steps
    }),
  )
  return out
}

interface SupportedCase {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  supported: unknown
}

async function alwaysOnTopSupported(): Promise<SupportedCase[]> {
  await boot({ windowState: WINDOW })
  const out: SupportedCase[] = []
  const values = [undefined, '', 'wayland-0', 'x11', 'wayland', 'Wayland', 'xwayland', 'tty']
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    for (const waylandDisplay of values) {
      for (const sessionType of values) {
        if (platform !== 'linux' && (waylandDisplay !== undefined || sessionType !== undefined)) continue
        const env = { WAYLAND_DISPLAY: waylandDisplay, XDG_SESSION_TYPE: sessionType }
        const supported = await withPlatformAndEnv(platform, env, () => invoke(IpcChannels.WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED))
        out.push({ platform, env, supported })
      }
    }
  }
  return out
}

describe('window operations', () => {
  it('records the window IPC and events of index.ts', async () => {
    const scenarios = [...(await compactScenarios()), ...(await displayScenarios()), ...(await simpleScenarios())]
    const isAlwaysOnTopSupported = await alwaysOnTopSupported()
    writeJsonFixture(OUT, {
      source: 'setupWindowIpc, animateBounds and the window / screen listeners of src/main/index.ts booted on scripts/resident-fixtures',
      compactMinSize: { width: 300, height: 100 },
      scenarios,
      isAlwaysOnTopSupported,
    })
  })
})
