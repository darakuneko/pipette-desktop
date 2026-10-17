// SPDX-License-Identifier: GPL-2.0-or-later
// Boots src/main/index.ts on the harness (harness.ts, electron-mock.ts) the
// way Electron starts it: the module runs, then the `whenReady` callbacks.
// Every boot gets fresh module state (`vi.resetModules()`), a fake clock at
// FIXED_NOW and the platform and environment the scenario asks for.

import { vi } from 'vitest'
import { FIXED_NOW, harnessState, type Display, type Rect } from './harness'

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
  if (options.config !== undefined) state.config = options.config
  if (options.windowState !== undefined) state.windowState = options.windowState
  if (options.displays !== undefined) state.displays = options.displays
  if (options.isPackaged !== undefined) state.isPackaged = options.isPackaged
  if (options.frame !== undefined) state.frame = options.frame
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
