// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock electron ---
vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock/userData',
  },
  screen: {
    getAllDisplays: () => [],
  },
  ipcMain: {
    handle: vi.fn(),
  },
}))

// Shared state between mock and tests — vi.hoisted ensures it's available before vi.mock
const mockStoreData = vi.hoisted(() => {
  const data: Record<string, unknown> = {}
  return data
})

vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      defaults: Record<string, unknown>
      constructor(opts: { defaults: Record<string, unknown> }) {
        this.defaults = opts.defaults
        Object.assign(mockStoreData, opts.defaults)
      }
      get store(): Record<string, unknown> {
        return { ...mockStoreData }
      }
      set store(val: Record<string, unknown>) {
        for (const key of Object.keys(mockStoreData)) {
          delete mockStoreData[key]
        }
        Object.assign(mockStoreData, val)
      }
      get(key: string): unknown {
        return mockStoreData[key]
      }
      set(key: string, value: unknown): void {
        mockStoreData[key] = value
      }
      clear(): void {
        for (const key of Object.keys(mockStoreData)) {
          delete mockStoreData[key]
        }
        Object.assign(mockStoreData, this.defaults)
      }
    },
  }
})

import { ipcMain } from 'electron'
import { loadAppConfig, saveAppConfig, setupAppConfigIpc, onAppConfigChange } from '../app-config'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types/app-config'

describe('app-config (electron-store)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key]
    }
    Object.assign(mockStoreData, DEFAULT_APP_CONFIG)
  })

  describe('loadAppConfig', () => {
    it('returns default config when store has defaults', () => {
      const config = loadAppConfig()
      expect(config).toEqual(DEFAULT_APP_CONFIG)
    })

    it('returns saved config after saveAppConfig', () => {
      const customConfig: AppConfig = { ...DEFAULT_APP_CONFIG, autoSync: true }
      saveAppConfig(customConfig)
      const loaded = loadAppConfig()
      expect(loaded).toEqual(customConfig)
    })
  })

  describe('saveAppConfig', () => {
    it('persists config to store', () => {
      const config: AppConfig = { ...DEFAULT_APP_CONFIG, autoSync: true }
      saveAppConfig(config)
      expect(mockStoreData.autoSync).toBe(true)
    })

    it('overwrites existing config', () => {
      saveAppConfig({ ...DEFAULT_APP_CONFIG, autoSync: false })
      saveAppConfig({ ...DEFAULT_APP_CONFIG, autoSync: true })
      const loaded = loadAppConfig()
      expect(loaded.autoSync).toBe(true)
    })
  })

  describe('setupAppConfigIpc', () => {
    let handlers: Map<string, (...args: unknown[]) => unknown>

    beforeEach(() => {
      handlers = new Map()
      vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
        return undefined as unknown as Electron.IpcMain
      })
      setupAppConfigIpc()
    })

    it('rejects invalid config keys', () => {
      const setHandler = handlers.get('app-config:set')!
      setHandler({}, 'windowState', { x: 0, y: 0, width: 100, height: 100 })
      expect(mockStoreData.windowState).toBeUndefined()
    })

    it('accepts valid config keys', () => {
      const setHandler = handlers.get('app-config:set')!
      setHandler({}, 'theme', 'dark')
      expect(mockStoreData.theme).toBe('dark')
    })

    it('notifies change callbacks on valid set', () => {
      const callback = vi.fn()
      onAppConfigChange(callback)
      const setHandler = handlers.get('app-config:set')!
      setHandler({}, 'autoSync', true)
      expect(callback).toHaveBeenCalledWith('autoSync', true)
    })

    it('does not notify change callbacks on invalid key', () => {
      const callback = vi.fn()
      onAppConfigChange(callback)
      const setHandler = handlers.get('app-config:set')!
      setHandler({}, 'windowState', { x: 0, y: 0, width: 100, height: 100 })
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('extended fields', () => {
    it('persists theme setting', () => {
      saveAppConfig({ ...DEFAULT_APP_CONFIG, theme: 'dark' })
      const loaded = loadAppConfig()
      expect(loaded.theme).toBe('dark')
    })

    it('persists keyboard layout settings', () => {
      saveAppConfig({
        ...DEFAULT_APP_CONFIG,
        currentKeyboardLayout: 'dvorak',
        defaultKeyboardLayout: 'colemak',
      })
      const loaded = loadAppConfig()
      expect(loaded.currentKeyboardLayout).toBe('dvorak')
      expect(loaded.defaultKeyboardLayout).toBe('colemak')
    })

    it('persists panelSide and autoLockTime', () => {
      saveAppConfig({
        ...DEFAULT_APP_CONFIG,
        panelSide: 'right',
        autoLockTime: 30,
      })
      const loaded = loadAppConfig()
      expect(loaded.panelSide).toBe('right')
      expect(loaded.autoLockTime).toBe(30)
    })
  })
})
