// SPDX-License-Identifier: GPL-2.0-or-later
// App configuration backed by electron-store

import { screen } from 'electron'
import Store from 'electron-store'
import { IpcChannels } from '../shared/ipc/channels'
import { DEFAULT_APP_CONFIG, SETTABLE_APP_CONFIG_KEYS, type AppConfig, type WindowState } from '../shared/types/app-config'
import { secureHandle } from './ipc-guard'

const MIN_WIDTH = 1280
const MIN_HEIGHT = 960

const DEFAULT_STATE: WindowState = {
  x: -1,
  y: -1,
  width: MIN_WIDTH,
  height: MIN_HEIGHT,
}

const store = new Store<AppConfig>({
  name: 'config',
  defaults: DEFAULT_APP_CONFIG,
})

export function getAppConfigStore(): Store<AppConfig> {
  return store
}

export function loadAppConfig(): AppConfig {
  return store.store
}

export function saveAppConfig(config: AppConfig): void {
  store.store = config
}

function isValidWindowState(state: unknown): state is WindowState {
  if (!state || typeof state !== 'object') return false
  const s = state as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((k) => typeof s[k] === 'number')
}

function isVisibleOnAnyDisplay(centerX: number, centerY: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.bounds
    return centerX >= x && centerX < x + width && centerY >= y && centerY < y + height
  })
}

/**
 * Load saved window bounds from disk.
 * Returns default bounds when no saved state exists or the saved position
 * falls outside all currently connected displays.
 */
export function loadWindowState(): WindowState {
  const state = store.get('windowState')
  if (!isValidWindowState(state)) {
    return { ...DEFAULT_STATE }
  }

  const clamped: WindowState = {
    x: state.x,
    y: state.y,
    width: Math.max(state.width, MIN_WIDTH),
    height: Math.max(state.height, MIN_HEIGHT),
  }

  if (!isVisibleOnAnyDisplay(clamped.x + clamped.width / 2, clamped.y + clamped.height / 2)) {
    return { ...DEFAULT_STATE }
  }

  return clamped
}

/**
 * Persist the current window bounds.
 * Called during window close — errors are silently ignored since window state is non-critical.
 */
export function saveWindowState(bounds: Electron.Rectangle): void {
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
  try {
    store.set('windowState', state)
  } catch {
    // Non-critical: silently ignore write failures
  }
}

type ConfigChangeCallback = (key: keyof AppConfig, value: unknown) => void
const changeCallbacks: ConfigChangeCallback[] = []

export function onAppConfigChange(cb: ConfigChangeCallback): void {
  changeCallbacks.push(cb)
}

export function setupAppConfigIpc(): void {
  secureHandle(IpcChannels.APP_CONFIG_GET_ALL, () => loadAppConfig())

  secureHandle(
    IpcChannels.APP_CONFIG_SET,
    (_event, key: string, value: unknown) => {
      if (!SETTABLE_APP_CONFIG_KEYS.has(key as keyof AppConfig)) return
      store.set(key as keyof AppConfig, value as AppConfig[keyof AppConfig])
      for (const cb of changeCallbacks) {
        cb(key as keyof AppConfig, value)
      }
    },
  )
}
