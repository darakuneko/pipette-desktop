// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The pipette settings members over the mocked Tauri IPC: a patch reads,
// merges and writes back naming the etag it read, starts over when the
// write answers `conflict`, and gives up after MAX_PATCH_ATTEMPTS; the
// patches of one keyboard run one at a time from read to write.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { DEFAULT_APP_CONFIG } from '../../shared/types/app-config'
import { MAX_PATCH_ATTEMPTS, settingsApi } from '../api/settings'

afterEach(() => {
  clearMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

type Args = Record<string, unknown>

/** A backend holding each uid's file text, whose writes compare etags as
 *  the Rust one does (the etag is the text itself here). `log` records
 *  each command with its uid. */
function storeBackend(files: Record<string, string> = {}, config = DEFAULT_APP_CONFIG) {
  const log: string[] = []
  const written: Record<string, string[]> = {}
  const etagOf = (uid: string): string => files[uid] ?? 'absent'
  mockIPC((cmd, payload) => {
    const a = (payload ?? {}) as Args
    log.push(`${cmd}${a.uid !== undefined ? ` ${String(a.uid)}` : ''}`)
    switch (cmd) {
      case 'app_config_get_all': return config
      case 'pipette_settings_read': {
        const uid = a.uid as string
        return { content: files[uid] ?? null, etag: etagOf(uid) }
      }
      case 'pipette_settings_write': {
        const uid = a.uid as string
        if (a.etag !== etagOf(uid)) return 'conflict'
        files[uid] = a.content as string
        ;(written[uid] ??= []).push(a.content as string)
        return 'written'
      }
      case 'pipette_settings_ensure_dir': return null
      default: throw new Error(`unexpected command ${cmd}`)
    }
  })
  return { files, log, written }
}

const T = '2026-10-16T12:00:00.000Z'

function atFixedTime(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T))
}

describe('pipetteSettingsPatch', () => {
  it('starts a new file from the app-wide defaults', async () => {
    atFixedTime()
    const { files, log } = storeBackend({}, { ...DEFAULT_APP_CONFIG, defaultKeyboardLayout: 'dvorak', defaultAutoAdvance: false })
    await expect(settingsApi.pipetteSettingsPatch('0xA', { _rev: 1, layerNames: ['Base'] })).resolves.toEqual({ success: true })
    expect(files['0xA']).toBe(`{"_rev":1,"keyboardLayout":"dvorak","autoAdvance":false,"layerNames":["Base"],"_updatedAt":"${T}"}`)
    expect(log).toEqual(['pipette_settings_read 0xA', 'app_config_get_all', 'pipette_settings_write 0xA'])
  })

  it('merges into the stored settings without asking for the app config', async () => {
    atFixedTime()
    const { files, log } = storeBackend({ '0xA': '{"_rev":1,"keyboardLayout":"german","autoAdvance":true,"layerNames":[],"extra":1}' })
    await settingsApi.pipetteSettingsPatch('0xA', { autoAdvance: false, keymapScale: 1.5 })
    expect(files['0xA']).toBe(`{"_rev":1,"keyboardLayout":"german","autoAdvance":false,"keymapScale":1.5,"layerNames":[],"_updatedAt":"${T}"}`)
    expect(log).toEqual(['pipette_settings_read 0xA', 'pipette_settings_write 0xA'])
  })

  it('starts over from a new read when the file changed since the read', async () => {
    const backend = storeBackend({ '0xA': '{"_rev":1,"keyboardLayout":"qwerty","autoAdvance":true}' })
    let changed = false
    mockIPC((cmd, payload) => {
      const a = payload as Args
      if (cmd === 'pipette_settings_read' && !changed) {
        changed = true
        const read = { content: backend.files['0xA'], etag: backend.files['0xA'] }
        // A sync merge lands between the read and the write.
        backend.files['0xA'] = '{"_rev":1,"keyboardLayout":"colemak","autoAdvance":true}'
        return read
      }
      if (cmd === 'pipette_settings_read') return { content: backend.files['0xA'], etag: backend.files['0xA'] }
      if (cmd === 'pipette_settings_write') {
        backend.log.push(`write ${String(a.etag === backend.files['0xA'])}`)
        if (a.etag !== backend.files['0xA']) return 'conflict'
        backend.files['0xA'] = a.content as string
        return 'written'
      }
      throw new Error(`unexpected command ${cmd}`)
    })
    await expect(settingsApi.pipetteSettingsPatch('0xA', { autoAdvance: false })).resolves.toEqual({ success: true })
    expect(backend.log).toEqual(['write false', 'write true'])
    expect(JSON.parse(backend.files['0xA'])).toMatchObject({ keyboardLayout: 'colemak', autoAdvance: false })
  })

  it('gives up after MAX_PATCH_ATTEMPTS conflicts', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log: string[] = []
    mockIPC((cmd) => {
      log.push(cmd)
      if (cmd === 'pipette_settings_read') return { content: '{"keyboardLayout":"qwerty","autoAdvance":true}', etag: 'e' }
      if (cmd === 'pipette_settings_write') return 'conflict'
      throw new Error(`unexpected command ${cmd}`)
    })
    await expect(settingsApi.pipetteSettingsPatch('0xA', { quickSelect: true })).resolves.toEqual({
      success: false,
      error: 'Error: Settings changed while being written',
    })
    expect(log.filter((cmd) => cmd === 'pipette_settings_write')).toHaveLength(MAX_PATCH_ATTEMPTS)
    expect(log.filter((cmd) => cmd === 'pipette_settings_read')).toHaveLength(MAX_PATCH_ATTEMPTS)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('refuses settings the patch makes invalid without writing', async () => {
    const { log } = storeBackend({ '0xA': '{"_rev":1,"keyboardLayout":"qwerty","autoAdvance":true}' })
    await expect(settingsApi.pipetteSettingsPatch('0xA', { keyboardLayout: 5 as unknown as string })).resolves.toEqual({
      success: false,
      error: 'Error: Invalid prefs',
    })
    expect(log).toEqual(['pipette_settings_read 0xA'])
  })

  it('refuses an unsafe uid before a patch that is not an object, without a command', async () => {
    const { log } = storeBackend()
    await expect(settingsApi.pipetteSettingsPatch('..', null as never)).resolves.toEqual({ success: false, error: 'Error: Invalid uid' })
    await expect(settingsApi.pipetteSettingsPatch('0xA', [] as never)).resolves.toEqual({ success: false, error: 'Error: Invalid patch' })
    expect(log).toEqual([])
  })

  it('answers a failed write as the handler answers a thrown error', async () => {
    mockIPC((cmd) => {
      if (cmd === 'pipette_settings_read') return { content: '{"keyboardLayout":"qwerty","autoAdvance":true}', etag: 'e' }
      throw 'disk full'
    })
    await expect(settingsApi.pipetteSettingsPatch('0xA', { quickSelect: true })).resolves.toEqual({
      success: false,
      error: 'Error: disk full',
    })
  })

  it('runs the patches of one keyboard from read to write one at a time, in call order', async () => {
    const releases: (() => void)[] = []
    const files: Record<string, string> = {}
    const log: string[] = []
    mockIPC((cmd, payload) => {
      const a = payload as Args
      const uid = a.uid as string
      log.push(`start ${cmd} ${uid}`)
      return new Promise((resolve) => {
        releases.push(() => {
          log.push(`end ${cmd} ${uid}`)
          if (cmd === 'pipette_settings_read') resolve({ content: files[uid] ?? '{"keyboardLayout":"q","autoAdvance":true}', etag: 'e' })
          else {
            files[uid] = a.content as string
            resolve('written')
          }
        })
      })
    })
    const first = settingsApi.pipetteSettingsPatch('0xA', { layerNames: ['one'] })
    const second = settingsApi.pipetteSettingsPatch('0xA', { quickSelect: true })
    const other = settingsApi.pipetteSettingsPatch('0xB', { quickSelect: false })
    await settle()
    expect(log).toEqual(['start pipette_settings_read 0xA', 'start pipette_settings_read 0xB'])
    while (releases.length > 0) {
      releases.shift()?.()
      await settle()
    }
    await Promise.all([first, second, other])
    const forA = log.filter((line) => line.endsWith('0xA'))
    expect(forA).toEqual([
      'start pipette_settings_read 0xA', 'end pipette_settings_read 0xA',
      'start pipette_settings_write 0xA', 'end pipette_settings_write 0xA',
      'start pipette_settings_read 0xA', 'end pipette_settings_read 0xA',
      'start pipette_settings_write 0xA', 'end pipette_settings_write 0xA',
    ])
    expect(JSON.parse(files['0xA'])).toMatchObject({ layerNames: ['one'], quickSelect: true })
  })

  it('applies the patch as it was when the member was called', async () => {
    const { files } = storeBackend({ '0xA': '{"keyboardLayout":"qwerty","autoAdvance":true}' })
    const patch = { layerNames: ['before'] }
    const done = settingsApi.pipetteSettingsPatch('0xA', patch)
    patch.layerNames.push('after')
    await done
    expect(JSON.parse(files['0xA']).layerNames).toEqual(['before'])
  })
})

describe('pipetteSettingsGet', () => {
  it('reads the settings through the content rules', async () => {
    storeBackend({ '0xA': '{"keyboardLayout":"german","autoAdvance":false,"unknown":1}', '0xB': '{"keyboardLayout":5}', '0xC': 'not json' })
    await expect(settingsApi.pipetteSettingsGet('0xA')).resolves.toMatchObject({ _rev: 1, keyboardLayout: 'german', autoAdvance: false, layerNames: [] })
    expect(await settingsApi.pipetteSettingsGet('0xA')).not.toHaveProperty('unknown')
    await expect(settingsApi.pipetteSettingsGet('0xB')).resolves.toBeNull()
    await expect(settingsApi.pipetteSettingsGet('0xC')).resolves.toBeNull()
    await expect(settingsApi.pipetteSettingsGet('0xD')).resolves.toBeNull()
  })

  it('answers null for an unsafe uid without a command, and for a failed read', async () => {
    const { log } = storeBackend()
    await expect(settingsApi.pipetteSettingsGet('a/b')).resolves.toBeNull()
    expect(log).toEqual([])
    mockIPC(() => { throw 'boom' })
    await expect(settingsApi.pipetteSettingsGet('0xA')).resolves.toBeNull()
  })
})

describe('pipetteSettingsEnsureDir', () => {
  it('answers success, or the failure as the handler answers it', async () => {
    storeBackend()
    await expect(settingsApi.pipetteSettingsEnsureDir('0xA')).resolves.toEqual({ success: true })
    mockIPC(() => { throw 'Invalid uid' })
    await expect(settingsApi.pipetteSettingsEnsureDir('..')).resolves.toEqual({ success: false, error: 'Error: Invalid uid' })
  })
})

describe('pipetteSettingsListAllTypingResults', () => {
  it('pools the typing test results of every valid file with its keyboard name', async () => {
    const result = (wpm: number) => ({ date: '2026-01-01T00:00:00.000Z', wpm, accuracy: 90, wordCount: 10, correctChars: 50, incorrectChars: 1, durationSeconds: 15 })
    mockIPC((cmd) => {
      if (cmd !== 'pipette_settings_read_all') throw new Error(cmd)
      return [
        { uid: 'a', name: 'Board A', content: JSON.stringify({ keyboardLayout: 'q', autoAdvance: true, typingTestResults: [result(1), result(2)] }) },
        { uid: 'b', name: 'b', content: JSON.stringify({ keyboardLayout: 'q', autoAdvance: true }) },
        { uid: 'c', name: 'Board C', content: JSON.stringify({ keyboardLayout: 5, typingTestResults: [result(3)] }) },
        { uid: 'd', name: 'Board D', content: JSON.stringify({ keyboardLayout: 'q', autoAdvance: true, typingTestResults: [result(4)] }) },
      ]
    })
    const pooled = await settingsApi.pipetteSettingsListAllTypingResults()
    expect(pooled.map((r) => [r.wpm, r.keyboardName])).toEqual([[1, 'Board A'], [2, 'Board A'], [4, 'Board D']])
  })
})
