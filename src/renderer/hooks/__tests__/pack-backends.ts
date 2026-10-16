// SPDX-License-Identifier: GPL-2.0-or-later
// What the backends of the language and theme pack hooks' tests share
// (i18n-pack-backends.ts, theme-pack-backends.ts): the import dialog's
// answer as the Tauri backend sends it, and the JSON text the shim sends a
// pack and its options as.
//
// A file the spy answers with `raw` crosses as the JSON of it, and one with
// a `parseError` as a file that could not be read, with that error.

import type { PackImportDialogResult } from '../../../shared/types/pack-import'
import type { PackImportRead } from '../../../tauri-shim/generated/PackImportRead'

/** The dialog's answer as the backend sends it. */
export function asRead(result: PackImportDialogResult): PackImportRead {
  return {
    canceled: result.canceled,
    files: result.files.map((file) =>
      file.raw === undefined
        ? { filePath: file.filePath, readError: file.parseError }
        : { filePath: file.filePath, text: JSON.stringify(file.raw), fileSizeBytes: file.fileSizeBytes },
    ),
  }
}

/** The value of JSON text the shim sent; undefined for none. */
export function parse(text: unknown): unknown {
  return typeof text === 'string' ? JSON.parse(text) : undefined
}
