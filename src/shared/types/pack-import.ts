// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared shapes for the multi-select import dialog used by Language
// Packs (I18N_PACK_IMPORT) and Theme Packs (THEME_PACK_IMPORT). Both
// handlers open the same kind of dialog and read+parse each selected
// file the same way — see `src/main/pack-import-dialog.ts`'s
// `readSelectedImportFiles`, which both call. Key Labels' import is
// deliberately NOT part of this — it saves each file in main and
// returns saved metas rather than raw parsed bodies (the renderer
// validates/persists i18n and theme packs itself).

/** One file selected via the dialog. Parsing happens per-file in main;
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
