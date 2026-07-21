// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared multi-select import dialog for Language Packs and Theme Packs:
// both used to define byte-identical "open dialog -> read -> JSON.parse
// each selected file" logic inline in their own *-ipc.ts. Key Labels'
// import is deliberately NOT folded in here — it saves each file in
// main and returns saved metas rather than raw parsed bodies (see
// `importFromDialog` in `key-label-store.ts`), so its shape and
// behaviour genuinely differ from this read-only dialog.

import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import type { PackImportFile } from '../shared/types/pack-import'

/** Read + parse a single file selected via the multi-select import
 *  dialog. Never throws — a read or parse failure is reported via
 *  `parseError` so one bad file in the batch does not abort the rest. */
async function readOneImportFile(filePath: string): Promise<PackImportFile> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    try {
      const parsed: unknown = JSON.parse(raw)
      return { filePath, raw: parsed, fileSizeBytes: Buffer.byteLength(raw, 'utf-8') }
    } catch (err) {
      return { filePath, fileSizeBytes: Buffer.byteLength(raw, 'utf-8'), parseError: String(err) }
    }
  } catch (err) {
    return { filePath, parseError: String(err) }
  }
}

export interface ReadSelectedImportFilesOptions {
  title: string
  filters: { name: string; extensions: string[] }[]
}

/**
 * Opens a multi-select "openFile" dialog anchored to `win` and reads +
 * parses every selected file independently. Returns `null` when there is
 * no window to anchor the dialog to, or the user cancels / selects
 * nothing — the caller maps that to its own `{ canceled: true, files: [] }`
 * response.
 */
export async function readSelectedImportFiles(
  win: BrowserWindow | null,
  opts: ReadSelectedImportFilesOptions,
): Promise<PackImportFile[] | null> {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: opts.filters,
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const files: PackImportFile[] = []
  for (const filePath of result.filePaths) {
    files.push(await readOneImportFile(filePath))
  }
  return files
}
