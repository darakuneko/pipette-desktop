// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The theme pack members over the mocked Tauri IPC: the writes reach the
// backend one at a time in the order the renderer made them, the list, the
// reads and the dialogs do not wait for them, a pack that fails
// validateThemePack never reaches the backend and answers INVALID_FILE with
// the check's errors, the pack and the options cross as JSON text, and
// theme-pack:changed reaches the callback until unsubscribed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { validateThemePack } from '../../shared/theme/validate'
import { THEME_COLOR_KEYS } from '../../shared/types/theme-store'
import { themePacksApi } from '../api/theme-packs'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Answers every command once released, logging its start. */
function heldBackend(): { log: string[]; payloads: Record<string, unknown>[]; releaseAll: () => void; release: () => void } {
  const log: string[] = []
  const payloads: Record<string, unknown>[] = []
  const releases: (() => void)[] = []
  mockIPC((cmd, payload) => {
    log.push(cmd)
    payloads.push(payload as Record<string, unknown>)
    return new Promise((resolve) => releases.push(() => resolve({ success: true })))
  })
  return {
    log,
    payloads,
    release: () => releases.shift()?.(),
    releaseAll: () => releases.splice(0).forEach((release) => release()),
  }
}

function theme(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, version: '1.0.0', colorScheme: 'dark', colors: Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, '#123456'])), ...extra }
}

describe('themePacksApi', () => {
  it('sends the writes one at a time, in call order', async () => {
    const { log, release } = heldBackend()
    const calls = [
      themePacksApi.themePackImportApply(theme('A'), {}),
      themePacksApi.themePackRename('id', 'New'),
      themePacksApi.themePackReorder(['id']),
      themePacksApi.themePackSetHubPostId('id', 'post', undefined, undefined),
      themePacksApi.themePackDelete('id'),
    ]
    for (let i = 1; i <= calls.length; i++) {
      await settle()
      expect(log).toHaveLength(i)
      release()
      await calls[i - 1]
    }
    expect(log).toEqual([
      'theme_pack_import_apply',
      'theme_pack_store_rename',
      'theme_pack_store_reorder',
      'theme_pack_store_set_hub_post_id',
      'theme_pack_store_delete',
    ])
  })

  it('does not hold up the list, the reads and the dialogs', async () => {
    const { log, releaseAll } = heldBackend()
    const calls = [
      themePacksApi.themePackDelete('id'),
      themePacksApi.themePackList(),
      themePacksApi.themePackGet('id'),
      themePacksApi.themePackHasName('Name', undefined),
      themePacksApi.themePackExport('id'),
      themePacksApi.themePackImport(),
    ]
    await settle()
    expect([...log].sort()).toEqual([
      'theme_pack_export',
      'theme_pack_import',
      'theme_pack_store_delete',
      'theme_pack_store_get',
      'theme_pack_store_has_name',
      'theme_pack_store_list',
    ])
    releaseAll()
    await Promise.allSettled(calls)
  })

  it('answers a pack that fails the check with INVALID_FILE, without the backend', async () => {
    const { log } = heldBackend()
    const packs: unknown[] = [undefined, 'text', [theme('Array')], theme('Bad', { version: '1', colorScheme: 'blue' })]
    for (const raw of packs) {
      const errors = validateThemePack(raw).errors
      expect(errors.length).toBeGreaterThan(0)
      await expect(themePacksApi.themePackImportApply(raw, {})).resolves.toEqual({
        success: false,
        errorCode: 'INVALID_FILE',
        error: errors.join('; '),
      })
    }
    await settle()
    expect(log).toEqual([])
  })

  it('sends the pack and the options as JSON text, the options as {} when not given', async () => {
    const { payloads, releaseAll } = heldBackend()
    const raw = { '2': 'index key', ...theme('A') }
    const options = { hubPostId: 'post', id: 'x' }
    const calls = [themePacksApi.themePackImportApply(raw, options), themePacksApi.themePackImportApply(theme('B'), undefined)]
    // A change after the call does not reach the backend.
    options.id = 'changed'
    await settle()
    releaseAll()
    await settle()
    releaseAll()
    await Promise.all(calls)
    expect(payloads).toEqual([
      { raw: JSON.stringify(raw), options: '{"hubPostId":"post","id":"x"}' },
      { raw: JSON.stringify(theme('B')), options: '{}' },
    ])
    expect((payloads[0].raw as string).startsWith('{"2":"index key","name":"A"')).toBe(true)
  })

  it('parses each imported file on its own', async () => {
    mockIPC(() => ({
      canceled: false,
      files: [
        { filePath: '/a.json', text: '{"name":"A"}', fileSizeBytes: 12 },
        { filePath: '/b.json', readError: 'Error: no such file' },
      ],
    }))
    await expect(themePacksApi.themePackImport()).resolves.toEqual({
      canceled: false,
      files: [
        { filePath: '/a.json', raw: { name: 'A' }, fileSizeBytes: 12 },
        { filePath: '/b.json', parseError: 'Error: no such file' },
      ],
    })
  })

  it('passes each theme-pack:changed event until unsubscribed', async () => {
    mockIPC(() => {}, { shouldMockEvents: true })
    const callback = vi.fn()
    const unsubscribe = themePacksApi.themePackOnChanged(callback)
    await settle()
    await emit('theme-pack:changed', null)
    unsubscribe()
    await emit('theme-pack:changed')
    expect(callback.mock.calls).toEqual([[]])
  })
})
