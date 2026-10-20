// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The file members parse sideloadJson's text,
// pass the other results through, and send text without lone surrogates.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { filesApi } from '../api/files'

afterEach(() => {
  clearMocks()
})

/** Answers `command` with `response` and records the arguments of each call. */
function backend(command: string, response: unknown): unknown[] {
  const calls: unknown[] = []
  mockIPC((cmd, payload) => {
    if (cmd !== command) throw new Error(`unexpected command ${cmd}`)
    calls.push(payload)
    return response
  })
  return calls
}

describe('filesApi.sideloadJson', () => {
  it('parses the text of the chosen file', async () => {
    backend('file_sideload_json', { success: true, data: '{"name":"Board","matrix":{"rows":1}}', filePath: '/a.json' })
    await expect(filesApi.sideloadJson('Load')).resolves.toEqual({
      success: true,
      data: { name: 'Board', matrix: { rows: 1 } },
      filePath: '/a.json',
    })
  })

  it('answers the parse error as a failure', async () => {
    backend('file_sideload_json', { success: true, data: '{not json', filePath: '/a.json' })
    const result = await filesApi.sideloadJson()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^SyntaxError: /)
    expect(result.data).toBeUndefined()
  })

  it('passes a cancel or a read error through', async () => {
    backend('file_sideload_json', { success: false, error: 'cancelled' })
    await expect(filesApi.sideloadJson()).resolves.toEqual({ success: false, error: 'cancelled' })
  })
})

describe('filesApi text', () => {
  it('replaces lone surrogates with U+FFFD and keeps pairs', async () => {
    const calls = backend('file_save_layout', { success: false, error: 'cancelled' })
    await filesApi.saveLayout('a\uD800b\uDC00c😀', 'n\uDFFF')
    expect(calls).toEqual([{ json: 'a�b�c😀', deviceName: 'n�' }])
  })

  it('leaves a CSV bundle the backend will refuse as it is', async () => {
    const calls = backend('file_export_csv_bundle', { success: false, error: 'invalid file entry' })
    const files = [{ name: 'a\uD800', content: 'x' }, 'not an entry', { name: 1 }]
    await expect(
      filesApi.exportCsvBundle(files as unknown as { name: string; content: string }[]),
    ).resolves.toEqual({ success: false, error: 'invalid file entry' })
    expect(calls).toEqual([{ files: [{ name: 'a�', content: 'x' }, 'not an entry', { name: 1 }] }])
  })
})
