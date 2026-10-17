// SPDX-License-Identifier: GPL-2.0-or-later
// Boots src/main/index.ts on the harness (harness.ts, electron-mock.ts) the
// way Electron starts it: the module runs, then the `whenReady` callbacks.
// Every boot gets fresh module state (`vi.resetModules()`), a fake clock at
// FIXED_NOW and the platform and environment the scenario asks for.

import { vi } from 'vitest'
import { DEFAULT_DISPLAY, FIXED_NOW, harnessState, type Display, type Rect } from './harness'

/** What a boot starts from unless the options say otherwise: the
 *  DEFAULT_APP_CONFIG, no saved window position, one 1920x1080 display with
 *  a 40 px panel, an unpackaged build and a 37 px title bar. */
export interface BootOptions {
  /** AppConfig values over DEFAULT_APP_CONFIG. */
  config?: Record<string, unknown>
  windowState?: Rect
  displays?: Display[]
  isPackaged?: boolean
  frame?: { width: number; height: number }
}

/** Starts the app; the clock stays fake until the test ends. */
export async function boot(options: BootOptions = {}): Promise<void> {
  const state = harnessState()
  state.config = options.config ?? {}
  state.windowState = options.windowState ?? { x: -1, y: -1, width: 1320, height: 1080 }
  state.displays = options.displays ?? [DEFAULT_DISPLAY]
  state.isPackaged = options.isPackaged ?? false
  state.frame = options.frame ?? { width: 0, height: 37 }
  // What a previous boot in the same test registered or built.
  state.calls = []
  state.logs = []
  state.handlers = new Map()
  state.configListeners = []
  state.readyCallbacks = []
  state.windows = []
  state.trays = []
  state.appListeners = new Map()
  state.screenListeners = new Map()
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.resetModules()
  await import('../../src/main/index')
  const callbacks = state.readyCallbacks.splice(0)
  for (const callback of callbacks) callback()
  // The startup's promises (setupTypingAnalytics) settle without timers.
  await vi.advanceTimersByTimeAsync(0)
}

/** Clears what was recorded so far (the boot's own calls). */
export function clearRecorded(): void {
  const state = harnessState()
  state.calls = []
  state.logs = []
}

/** Runs `body` with `process.platform` and the given environment variables
 *  (undefined removes one), putting both back afterwards. */
export async function withPlatformAndEnv<T>(
  platform: NodeJS.Platform | undefined,
  env: Record<string, string | undefined>,
  body: () => T | Promise<T>,
): Promise<T> {
  const realPlatform = process.platform
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]))
  if (platform !== undefined) Object.defineProperty(process, 'platform', { value: platform })
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await body()
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
