// SPDX-License-Identifier: GPL-2.0-or-later
// Result shape for importing one Aozora Bunko catalog work into the local
// Typing Test text store. Kept as a standalone shared type (rather than
// living next to the main-process importer) so preload/renderer can
// reference it without importing a main-process module.

import type { TypingTestTextMeta, TypingTestTextStoreErrorCode } from './typing-test-text-store'

/** Failure modes specific to the download/unzip/decode/clean pipeline,
 *  layered on top of the text store's own save-time error codes (e.g.
 *  `DUPLICATE_NAME`, `EMPTY_TEXT` — the store's `EMPTY_TEXT` fires if the
 *  normalized text is empty; the importer's own `EMPTY_TEXT` fires earlier,
 *  right after cleaning, before a save is even attempted). */
export type AozoraImportErrorCode =
  | 'NOT_IN_CATALOG'
  | 'DOWNLOAD_FAILED'
  | 'SIZE_MISMATCH'
  | 'NO_TEXT_ENTRY'
  | 'DECODE_FAILED'
  | 'EMPTY_TEXT'
  | TypingTestTextStoreErrorCode

export type AozoraImportResult =
  | { success: true; meta: TypingTestTextMeta }
  | { success: false; errorCode: AozoraImportErrorCode; error: string }
