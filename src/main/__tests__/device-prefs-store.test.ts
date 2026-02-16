// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// --- Mock electron ---

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  ipcMain: {
    handle: vi.fn(),
  },
}))

const mockNotifyChange = vi.fn()
vi.mock('../sync/sync-service', () => ({
  notifyChange: (...args: unknown[]) => mockNotifyChange(...args),
}))

// --- Import after mocking ---

import { ipcMain } from 'electron'
import { setupPipetteSettingsStore } from '../pipette-settings-store'
import { IpcChannels } from '../../shared/ipc/channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent

describe('pipette-settings-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-settings-store-test-'))
    setupPipetteSettingsStore()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('get', () => {
    it('returns null when no prefs saved', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const result = await handler(fakeEvent, 'test-uid')
      expect(result).toBeNull()
    })
  })

  describe('set and get', () => {
    it('round-trips saved prefs', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: false,
        layerNames: ['Base', 'Fn'],
      }) as { success: boolean }
      expect(result.success).toBe(true)

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1')
      expect(prefs).toEqual({ _rev: 1, keyboardLayout: 'dvorak', autoAdvance: false, layerNames: ['Base', 'Fn'] })
    })

    it('round-trips layerNames field', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: ['Default', 'Lower', 'Raise', 'Adjust'],
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { layerNames: string[] }
      expect(prefs.layerNames).toEqual(['Default', 'Lower', 'Raise', 'Adjust'])
    })

    it('defaults layerNames to [] when not present', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      await setter(fakeEvent, 'uid-1', {
        keyboardLayout: 'qwerty',
        autoAdvance: true,
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { _rev: number; layerNames: string[] }
      expect(prefs._rev).toBe(1)
      expect(prefs.layerNames).toEqual([])
    })

    it('always writes _rev: 1', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { _rev: number }
      expect(prefs._rev).toBe(1)
    })

    it('overwrites existing prefs', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: false,
        layerNames: [],
      })
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'colemak',
        autoAdvance: true,
        layerNames: ['A'],
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1')
      expect(prefs).toEqual({ _rev: 1, keyboardLayout: 'colemak', autoAdvance: true, layerNames: ['A'] })
    })

    it('stores prefs per uid independently', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: false,
        layerNames: [],
      })
      await setter(fakeEvent, 'uid-2', {
        _rev: 1,
        keyboardLayout: 'german',
        autoAdvance: true,
        layerNames: ['L0'],
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      expect(await getter(fakeEvent, 'uid-1')).toEqual({
        _rev: 1,
        keyboardLayout: 'dvorak',
        autoAdvance: false,
        layerNames: [],
      })
      expect(await getter(fakeEvent, 'uid-2')).toEqual({
        _rev: 1,
        keyboardLayout: 'german',
        autoAdvance: true,
        layerNames: ['L0'],
      })
    })
  })

  describe('uid validation', () => {
    it('rejects uid with path traversal', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, '../..', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })

    it('rejects empty uid', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, '', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })

    it('rejects uid with slashes', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'foo/bar', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })

    it('returns null for invalid uid on get', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const result = await handler(fakeEvent, '../..')
      expect(result).toBeNull()
    })
  })

  describe('prefs validation', () => {
    it('rejects non-object prefs', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'uid-1', 'not-an-object') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with non-string keyboardLayout', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 123,
        autoAdvance: true,
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with non-boolean autoAdvance', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: 'yes',
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with unsupported _rev', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 99,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with non-array layerNames', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: 'not-array',
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with non-string layerNames entries', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [123, 456],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })
  })

  describe('sync notification', () => {
    it('calls notifyChange on set', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_SET)
      await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      })

      expect(mockNotifyChange).toHaveBeenCalledWith('keyboards/uid-1/settings')
    })
  })
})
