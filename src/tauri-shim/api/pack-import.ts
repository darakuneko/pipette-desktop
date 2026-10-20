// SPDX-License-Identifier: GPL-2.0-or-later
// What the language and theme pack members share (api/i18n-packs.ts,
// api/theme-packs.ts): the import dialog answers the text of each chosen
// file (src-tauri/src/store_commands/pack_import.rs), parsed here with
// JSON.parse into `{ filePath, raw, fileSizeBytes }` or
// `{ …, parseError }`; a pack and its options cross to the
// backend as the text of JSON.stringify, so the backend keeps their key
// order.

import type { PackImportDialogResult, PackImportFile } from '../../shared/types/pack-import'
import type { PackImportRead } from '../generated/PackImportRead'

/** The import dialog's answer as the renderer gets it, each file parsed on
 *  its own. */
export function parseImportFiles(read: PackImportRead): PackImportDialogResult {
  const files = read.files.map((file): PackImportFile => {
    const { filePath, text, fileSizeBytes } = file
    if (text === undefined) return { filePath, parseError: file.readError }
    try {
      const raw: unknown = JSON.parse(text)
      return { filePath, raw, fileSizeBytes }
    } catch (err) {
      return { filePath, fileSizeBytes, parseError: String(err) }
    }
  })
  return { canceled: read.canceled, files }
}

/** `value` as JSON text, or undefined when it has none (`undefined`). */
export function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value) as string | undefined
}
