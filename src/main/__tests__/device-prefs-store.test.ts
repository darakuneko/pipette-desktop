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

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

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

  describe('patch (field-level merge)', () => {
    it('merges only the given fields and preserves the rest', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await patch(fakeEvent, 'uid-p', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestResults: [{ date: '2026-06-26T00:00:00.000Z', runId: 'run-1', wpm: 50, accuracy: 99, wordCount: 10, correctChars: 50, incorrectChars: 1, durationSeconds: 30 }],
      })

      const res = await patch(fakeEvent, 'uid-p', { analyze: { filters: { deviceScopes: ['all'] } } }) as { success: boolean }
      expect(res.success).toBe(true)

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-p') as { typingTestResults?: unknown[]; analyze?: { filters?: { deviceScopes?: string[] } } }
      // analyze written, AND typingTestResults from the earlier full write
      // survives (the bug this fixes: one writer clobbering another's field).
      expect(prefs.analyze?.filters?.deviceScopes).toEqual(['all'])
      expect(prefs.typingTestResults).toHaveLength(1)
    })

    it('ignores undefined values so they do not erase existing fields', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await patch(fakeEvent, 'uid-u', {
        _rev: 1, keyboardLayout: 'dvorak', autoAdvance: false, layerNames: ['A'],
      })
      await patch(fakeEvent, 'uid-u', { keyboardLayout: undefined, autoAdvance: true })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-u') as { keyboardLayout: string; autoAdvance: boolean }
      expect(prefs.keyboardLayout).toBe('dvorak') // not erased by undefined
      expect(prefs.autoAdvance).toBe(true) // updated
    })

    it('clears a top-level field when patched with null', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const memory = {
        textId: 't1', currentWordIndex: 2, currentInput: 'ab',
        wordResults: [], correctChars: 3, incorrectChars: 0,
        elapsedMs: 1200, wpmHistory: [40], savedAt: '2026-06-26T00:00:00.000Z',
      }
      await patch(fakeEvent, 'uid-n', {
        _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames: [], typingTestMemory: memory,
      })
      // the full-prefs writer sends `null` to clear the paused run on finish
      await patch(fakeEvent, 'uid-n', { typingTestMemory: null })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-n') as { typingTestMemory?: unknown; keyboardLayout: string }
      expect(prefs.typingTestMemory).toBeUndefined() // cleared
      expect(prefs.keyboardLayout).toBe('qwerty') // sibling untouched
    })

    it('uses a valid default base when no prior settings exist', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const res = await patch(fakeEvent, 'uid-new', { analyze: { filters: { deviceScopes: ['own'] } } }) as { success: boolean }
      expect(res.success).toBe(true)

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-new') as { keyboardLayout: string; analyze?: { filters?: { deviceScopes?: string[] } } }
      expect(prefs.keyboardLayout).toBe('qwerty') // from DEFAULT base
      expect(prefs.analyze?.filters?.deviceScopes).toEqual(['own'])
    })

    it('serializes concurrent patches so neither is lost', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await Promise.all([
        patch(fakeEvent, 'uid-c', { keyboardLayout: 'dvorak' }),
        patch(fakeEvent, 'uid-c', { autoAdvance: false }),
      ])
      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-c') as { keyboardLayout: string; autoAdvance: boolean }
      expect(prefs.keyboardLayout).toBe('dvorak')
      expect(prefs.autoAdvance).toBe(false)
    })

    it('deep-merges analyze sub-fields so writers do not clobber each other', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      // three independent analyze writers, each owning a disjoint sub-field
      await patch(fakeEvent, 'uid-a', { analyze: { filters: { deviceScopes: ['all'] } } })
      await patch(fakeEvent, 'uid-a', { analyze: { compareFilters: { deviceScopes: ['own'] } } })
      await patch(fakeEvent, 'uid-a', { analyze: { goalDays: 5, goalKeystrokes: 200 } })
      await patch(fakeEvent, 'uid-a', { analyze: { fingerAssignments: { '0,0': 'left-index' } } })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-a') as {
        analyze?: {
          filters?: { deviceScopes?: string[] }
          compareFilters?: { deviceScopes?: string[] }
          goalDays?: number
          goalKeystrokes?: number
          fingerAssignments?: Record<string, string>
        }
      }
      // every sub-field survives the others' writes
      expect(prefs.analyze?.filters?.deviceScopes).toEqual(['all'])
      expect(prefs.analyze?.compareFilters?.deviceScopes).toEqual(['own'])
      expect(prefs.analyze?.goalDays).toBe(5)
      expect(prefs.analyze?.goalKeystrokes).toBe(200)
      expect(prefs.analyze?.fingerAssignments).toEqual({ '0,0': 'left-index' })
    })

    it('clears fingerAssignments with an empty map without touching siblings', async () => {
      const patch = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await patch(fakeEvent, 'uid-clr', { analyze: { fingerAssignments: { '0,0': 'left-index' }, goalDays: 3 } })
      // AnalyzePane sends an empty map to clear all overrides
      await patch(fakeEvent, 'uid-clr', { analyze: { fingerAssignments: {} } })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-clr') as {
        analyze?: { fingerAssignments?: Record<string, string>; goalDays?: number }
      }
      expect(prefs.analyze?.fingerAssignments).toEqual({})
      expect(prefs.analyze?.goalDays).toBe(3) // sibling untouched
    })
  })

  describe('set and get', () => {
    it('round-trips saved prefs', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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

    it('round-trips layerPanelOpen field', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerPanelOpen: false,
        layerNames: [],
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { layerPanelOpen: boolean }
      expect(prefs.layerPanelOpen).toBe(false)
    })

    it('round-trips typingTestHideKeymap / typingTestHideStatsRow / typingTestHideControls fields', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestHideKeymap: true,
        typingTestHideStatsRow: true,
        typingTestHideControls: true,
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { typingTestHideKeymap: boolean; typingTestHideStatsRow: boolean; typingTestHideControls: boolean }
      // readData() must echo all back, else a later partial PATCH drops them.
      expect(prefs.typingTestHideKeymap).toBe(true)
      expect(prefs.typingTestHideStatsRow).toBe(true)
      expect(prefs.typingTestHideControls).toBe(true)
    })

    it('round-trips typingTestSettingsPanelOpen field', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestSettingsPanelOpen: false,
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { typingTestSettingsPanelOpen: boolean }
      expect(prefs.typingTestSettingsPanelOpen).toBe(false)
    })

    it('round-trips typingTestComparisonBaselines map', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const baselines = {
        'words|30|english|false|true': { kind: 'best' },
        'fileImport|t2': { kind: 'pinned', pinnedDate: '2026-06-20T00:00:00.000Z' },
      }
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestComparisonBaselines: baselines,
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { typingTestComparisonBaselines: typeof baselines }
      expect(prefs.typingTestComparisonBaselines).toEqual(baselines)
    })

    it('rejects a typingTestComparisonBaselines map with an invalid kind', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestComparisonBaselines: { 'words|30': { kind: 'bogus' } },
      }) as { success: boolean }
      expect(result.success).toBe(false)
    })

    it('round-trips typingTestMonkeytypeConfig field', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const monkeytypeConfig = { mode: 'words', wordCount: 60, punctuation: true, numbers: false }
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingTestMonkeytypeConfig: monkeytypeConfig,
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { typingTestMonkeytypeConfig: typeof monkeytypeConfig }
      expect(prefs.typingTestMonkeytypeConfig).toEqual(monkeytypeConfig)
    })

    it('round-trips keymapWritten field (Plan-qwerty-select-no-rewrite Phase K)', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'eucalyn-id',
        autoAdvance: true,
        layerNames: [],
        keymapWritten: true,
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { keyboardLayout: string; keymapWritten?: boolean }
      expect(prefs.keyboardLayout).toBe('eucalyn-id')
      expect(prefs.keymapWritten).toBe(true)
    })

    it('omits keymapWritten when not present (absent = false, per the field\'s own doc)', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
      })

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { keymapWritten?: boolean }
      expect(prefs.keymapWritten).toBeUndefined()
    })

    it('defaults layerNames to [] when not present', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
    it('rejects non-object patch', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', 'not-an-object') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid patch')
    })

    it('rejects prefs with non-string keyboardLayout', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: 'yes',
        layerNames: [],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with non-boolean keymapWritten', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        keymapWritten: 'yes',
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('accepts a valid viewMatrix map', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMatrix: { '0,0': { row: 0, col: 5 }, '2,3': { row: 1, col: 0 } },
      }) as { success: boolean }
      expect(result.success).toBe(true)
    })

    it.each([
      ['malformed key', { 'a,b': { row: 0, col: 0 } }],
      ['string row value', { '0,0': { row: '1', col: 0 } }],
      ['negative col value', { '0,0': { row: 0, col: -1 } }],
      ['non-integer row value', { '0,0': { row: 1.5, col: 0 } }],
      ['non-object cell', { '0,0': 7 }],
      ['array map', [{ row: 0, col: 0 }]],
    ])('rejects prefs with a viewMatrix having a %s', async (_label, viewMatrix) => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        viewMatrix,
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('rejects prefs with unsupported _rev', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [123, 456],
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('accepts typingRecordEnabled boolean and round-trips it', async () => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingRecordEnabled: true,
      }) as { success: boolean }
      expect(result.success).toBe(true)

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { typingRecordEnabled: boolean }
      expect(prefs.typingRecordEnabled).toBe(true)
    })

    it('rejects prefs with non-boolean typingRecordEnabled', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingRecordEnabled: 'yes',
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it.each([1, 7, 30, 90])('accepts typingSyncSpanDays=%i', async (span) => {
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingSyncSpanDays: span,
      }) as { success: boolean }
      expect(result.success).toBe(true)

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { typingSyncSpanDays: number }
      expect(prefs.typingSyncSpanDays).toBe(span)
    })

    it.each([0, 2, 14, 365, -1, 7.5])('rejects disallowed typingSyncSpanDays=%s', async (span) => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await handler(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        typingSyncSpanDays: span,
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prefs')
    })

    it('drops a stale on-disk appliedKeymapLayout on the next PATCH write (field removed, Plan-qwerty-select-no-rewrite v5)', async () => {
      // Simulates a settings file written by an older build that still had
      // the field — the store no longer validates or projects it, so it
      // silently drops out of the object returned to the renderer, and out
      // of what gets written back on the next full-prefs PATCH.
      const setter = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
      const result = await setter(fakeEvent, 'uid-1', {
        _rev: 1,
        keyboardLayout: 'qwerty',
        autoAdvance: true,
        layerNames: [],
        appliedKeymapLayout: 'colemak-id',
      }) as { success: boolean }
      expect(result.success).toBe(true)

      const getter = getHandler(IpcChannels.PIPETTE_SETTINGS_GET)
      const prefs = await getter(fakeEvent, 'uid-1') as { appliedKeymapLayout?: string }
      expect(prefs.appliedKeymapLayout).toBeUndefined()
    })
  })

  describe('sync notification', () => {
    it('calls notifyChange on set', async () => {
      const handler = getHandler(IpcChannels.PIPETTE_SETTINGS_PATCH)
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
