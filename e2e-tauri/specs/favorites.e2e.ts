// SPDX-License-Identifier: GPL-2.0-or-later
//
// The favorite store of the Tauri build, driven through the page's vialAPI
// while the virtual keyboard is connected (so the renderer's keycode tables
// are the keyboard's): a favorite saved, exported to a file through the
// file dialog, deleted, imported back from the file, and imported into the
// editor. The export and the import convert keycodes in the shim's worker,
// so this also checks that the worker starts and answers in the WebView.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browser, expect } from '@wdio/globals'
import { connectVirtualKeyboard, invokeCommand } from '../helpers/app'

/** Calls the vialAPI member `member` of the page with `args`. The answer
 *  crosses as JSON text: WebDriver takes an answer with an `error` field
 *  for an error of its own. */
async function vialApi<T>(member: string, ...args: unknown[]): Promise<T> {
  const text = await browser.execute(
    async (name: string, memberArgs: unknown[]) => {
      const api = (window as unknown as { vialAPI: Record<string, (...a: unknown[]) => Promise<unknown>> }).vialAPI
      return JSON.stringify(await api[name](...memberArgs))
    },
    member,
    args,
  )
  return JSON.parse(text) as T
}

/** Calls `member` with `path` queued as the answer of its file dialog
 *  (`dev_dialog_respond`; null cancels it), and checks that the call took
 *  that answer, as `clickIntoFileDialog` does for a click. */
async function withFileDialog<T>(path: string | null, member: string, ...args: unknown[]): Promise<T> {
  const queued = (): Promise<number> => invokeCommand<number>('dev_dialog_queued')
  if ((await queued()) !== 0) throw new Error('a file dialog answer from an earlier step is still queued')
  await invokeCommand('dev_dialog_respond', { path })
  const answer = await vialApi<T>(member, ...args)
  if ((await queued()) !== 0) throw new Error(`${member} opened no file dialog`)
  return answer
}

interface Listed {
  success: boolean
  entries: { id: string; label: string; savedAt: string }[]
}

const TAP_DANCE = { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }

describe('Tauri build favorites', () => {
  let dir = ''

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipette-e2e-favorites-'))
    await connectVirtualKeyboard()
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exports a saved favorite, deletes it and imports it back from the file', async () => {
    const path = join(dir, 'favorites.json')
    const saved = await vialApi<{ success: boolean; entry: { id: string; savedAt: string } }>(
      'favoriteStoreSave',
      'tapDance',
      JSON.stringify({ type: 'tapDance', data: TAP_DANCE }),
      'E2E favorite',
    )
    expect(saved.success).toBe(true)

    expect(await withFileDialog(path, 'favoriteStoreExport', 'tapDance', 6)).toEqual({ success: true })
    const exported = JSON.parse(readFileSync(path, 'utf8')) as {
      vial_protocol: number
      categories: Record<string, { label: string; savedAt: string; data: Record<string, unknown> }[]>
    }
    expect(exported.vial_protocol).toBe(6)
    expect(exported.categories.td).toEqual([
      {
        label: 'E2E favorite',
        savedAt: saved.entry.savedAt,
        data: { onTap: 'KC_A', onHold: 'KC_NO', onDoubleTap: 'KC_NO', onTapHold: 'KC_NO', tappingTerm: 200 },
      },
    ])

    expect(await vialApi('favoriteStoreDelete', 'tapDance', saved.entry.id)).toEqual({ success: true })
    expect((await vialApi<Listed>('favoriteStoreList', 'tapDance')).entries).toEqual([])

    expect(await withFileDialog(path, 'favoriteStoreImport')).toEqual({ success: true, imported: 1, skipped: 0 })
    const listed = await vialApi<Listed>('favoriteStoreList', 'tapDance')
    expect(listed.entries.map(({ label, savedAt }) => ({ label, savedAt }))).toEqual([
      { label: 'E2E favorite', savedAt: saved.entry.savedAt },
    ])
    const loaded = await vialApi<{ success: boolean; data: string }>('favoriteStoreLoad', 'tapDance', listed.entries[0].id)
    expect(JSON.parse(loaded.data)).toEqual({ type: 'tapDance', data: TAP_DANCE })
  })

  it('exports the current value and imports it into the editor', async () => {
    const path = join(dir, 'current.json')
    const current = JSON.stringify({ type: 'tapDance', data: { ...TAP_DANCE, onTap: 5 } })
    expect(await withFileDialog(path, 'favoriteStoreExportCurrent', 'tapDance', 6, current)).toEqual({ success: true })

    expect(await withFileDialog(path, 'favoriteStoreImportToCurrent', 'tapDance')).toEqual({
      success: true,
      data: { ...TAP_DANCE, onTap: 5 },
    })

    expect(await withFileDialog(null, 'favoriteStoreImport')).toEqual({ success: false, imported: 0, skipped: 0, error: 'cancelled' })
  })
})
