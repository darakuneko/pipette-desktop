// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Per-entry metadata persisted in `userData/sync/key-labels/index.json`.
 * Mirrors the favorite-store pattern: entry-level LWW with soft tombstones.
 */
export interface KeyLabelMeta {
  /** Local UUID v4. Stable across renames; used as keyboardLayout selector value. */
  id: string
  /** Display name. Must be unique (case-insensitive) across active entries. */
  name: string
  /** Hub `uploader_name` cached locally for the Author column. Absent
   *  for entries that have never been associated with a Hub post. */
  uploaderName?: string
  /** Hub post id when synced publicly to Pipette Hub. */
  hubPostId?: string
  /** Hub-side `updated_at` cached locally so the Updated column shows
   *  the same value as the Hub website (= when the author last
   *  modified the post). Absent for never-uploaded local entries and
   *  legacy rows that predate this field. */
  hubUpdatedAt?: string
  /** Internal filename (`{id}_{timestamp}.json`). */
  filename: string
  /** First save time (ISO 8601). */
  savedAt: string
  /** Last update time (ISO 8601). */
  updatedAt: string
  /** Soft delete tombstone (ISO 8601). 30-day GC matches favorites. */
  deletedAt?: string
}

export interface KeyLabelIndex {
  entries: KeyLabelMeta[]
}

/**
 * On-disk content of `{filename}`. Mirrors the Pipette Hub
 * `GET /api/key-labels/:id/download` body, which is `{ name, map,
 * composite_labels }` (the `author` field has been retired upstream).
 */
export interface KeyLabelEntryFile {
  name: string
  map: Record<string, string>
  compositeLabels?: Record<string, string>
  /**
   * Opt-in marker set by the label author: this label set is a pure
   * QWERTY-keycode permutation (e.g. Colemak, Dvorak) and can be used
   * to bulk-rewrite the actual keymap, not just the display labels.
   * The flag alone is not sufficient proof — the rewrite-table builder
   * (`buildKeymapRewriteTable` in `src/shared/keymap/keymap-apply.ts`)
   * is the final authority and will refuse to apply a map that fails
   * its validation even when this flag is set.
   */
  keymapApplicable?: boolean
}

/** Combined meta + entry payload returned by `get`. */
export interface KeyLabelRecord {
  meta: KeyLabelMeta
  data: KeyLabelEntryFile
}

/** Specific error codes the renderer can branch on. */
export type KeyLabelStoreErrorCode =
  | 'INVALID_NAME'
  | 'DUPLICATE_NAME'
  | 'NOT_FOUND'
  | 'INVALID_FILE'
  | 'IO_ERROR'

export interface KeyLabelStoreResult<T> {
  success: boolean
  data?: T
  errorCode?: KeyLabelStoreErrorCode
  error?: string
}

/** One file's failure within a multi-file `importFromDialog` batch. */
export interface KeyLabelImportRejection {
  fileName: string
  errorCode: KeyLabelStoreErrorCode
  error: string
}

/** One file's success within a multi-file `importFromDialog` batch.
 *  Carries the originating filename alongside the saved meta so the
 *  renderer can report a failure (e.g. a Hub-sync failure after the
 *  save itself succeeded) against the file the user picked, not the
 *  label's internal display name — the main process is the only side
 *  that knows which `filePaths[i]` produced a given saved entry. */
export interface KeyLabelImportSuccess {
  fileName: string
  meta: KeyLabelMeta
}

/** Result of importing a batch of files selected via the multi-select
 *  file dialog. Every selected file is processed independently — a bad
 *  file is recorded in `rejections` rather than aborting the rest. */
export interface KeyLabelImportBatchResult {
  imported: KeyLabelImportSuccess[]
  rejections: KeyLabelImportRejection[]
}
