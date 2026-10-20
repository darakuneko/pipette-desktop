// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared shapes for the multi-select import dialog used by Language
// Packs (I18N_PACK_IMPORT) and Theme Packs (THEME_PACK_IMPORT). Both
// handlers open the same kind of dialog and read+parse each selected
// file the same way (src/tauri-shim/api/pack-import.ts). Key Labels'
// import is deliberately NOT part of this — it saves each file in the
// backend and returns saved metas rather than raw parsed bodies.

/** One file selected via the dialog, parsed per file;
 *  `parseError` is set instead of `raw` when the file could not be read
 *  or was not valid JSON. */
export interface PackImportFile {
  filePath: string
  raw?: unknown
  fileSizeBytes?: number
  parseError?: string
}

/** Shape returned by the import IPC handler. `files` is empty when
 *  `canceled` is true. */
export interface PackImportDialogResult {
  canceled: boolean
  files: PackImportFile[]
}
