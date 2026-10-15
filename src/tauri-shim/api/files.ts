// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI file members for the Tauri build
// (src-tauri/src/file_commands.rs). The backend shows each member's native
// dialog with the titles, default file names and filters of the Electron
// main process (src/main/file-io.ts) and reads or writes the file the user
// chose, so the page never names a path. The results and their error
// strings are file-io.ts's; a closed dialog answers `error: 'cancelled'`.
//
// Text crosses as well-formed Unicode: a lone surrogate, which the IPC
// cannot carry, becomes U+FFFD, the character Electron writes for it as
// UTF-8. sideloadJson gets the file's text and parses it here.

import type { VialAPI } from '../../shared/types/vial-api'
import type { CsvBundleResult } from '../generated/CsvBundleResult'
import type { FileOpenResult } from '../generated/FileOpenResult'
import type { FileSaveResult } from '../generated/FileSaveResult'
import { call } from '../ipc'

/** `value` with each lone surrogate replaced by U+FFFD, if it is a string. */
function wellFormed<T>(value: T): T {
  return (typeof value === 'string' ? value.toWellFormed() : value) as T
}

/** The bundle's entries with well-formed text. The backend checks their
 *  shape, so anything else passes through as it is. */
function wellFormedEntries(files: unknown): unknown {
  if (!Array.isArray(files)) return files
  return files.map((file: unknown) => {
    if (typeof file !== 'object' || file === null) return file
    const { name, content } = file as { name?: unknown; content?: unknown }
    return { ...file, name: wellFormed(name), content: wellFormed(content) }
  })
}

/** sideloadJson's result; the Electron handler also answers the path. */
type SideloadResult = Awaited<ReturnType<VialAPI['sideloadJson']>> & { filePath?: string }

export const filesApi = {
  saveLayout: (json, deviceName) =>
    call<FileSaveResult>('file_save_layout', { json: wellFormed(json), deviceName: wellFormed(deviceName) }),
  loadLayout: (title, extensions) =>
    call<FileOpenResult>('file_load_layout', { title: wellFormed(title), extensions }),
  exportKeymapC: (content, deviceName) =>
    call<FileSaveResult>('file_export_keymap_c', {
      content: wellFormed(content),
      deviceName: wellFormed(deviceName),
    }),
  exportPdf: (base64Data, deviceName) =>
    call<FileSaveResult>('file_export_pdf', {
      base64Data: wellFormed(base64Data),
      deviceName: wellFormed(deviceName),
    }),
  exportCsv: (content, defaultName) =>
    call<FileSaveResult>('file_export_csv', { content: wellFormed(content), defaultName: wellFormed(defaultName) }),
  exportCsvBundle: (files) => call<CsvBundleResult>('file_export_csv_bundle', { files: wellFormedEntries(files) }),
  exportJson: (content, defaultName) =>
    call<FileSaveResult>('file_export_json', { content: wellFormed(content), defaultName: wellFormed(defaultName) }),
  sideloadJson: async (title?: string): Promise<SideloadResult> => {
    const result = await call<FileOpenResult>('file_sideload_json', { title: wellFormed(title) })
    if (!result.success) return result
    try {
      return { success: true, data: JSON.parse(result.data ?? '') as unknown, filePath: result.filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
} satisfies Partial<VialAPI>
