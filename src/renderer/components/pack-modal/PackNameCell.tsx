// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardEvent } from 'react'

export interface PackNameCellProps {
  name: string
  editing: boolean
  /** True when this row supports the click-to-rename interaction
   * (false for built-in / QWERTY / not-mine rows). */
  canRename: boolean
  /** True while a multi-file import batch is running. `canRename`
   *  already stops a NEW rename from starting during import (each call
   *  site ANDs its own condition with `!importing`), but an edit that
   *  was already open when the batch started stays mounted — this
   *  makes ITS input read-only for the duration, on top of the
   *  modal-level guards that stop its commit from reaching the store
   *  (see `handleRenameCommit`'s `importingRef` check and the
   *  cancel-on-import-start effect in each pack modal). */
  locked: boolean
  editLabel: string
  onEditLabelChange: (value: string) => void
  onBlur: () => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onStartRename: () => void
  maxLength: number
  inputTestid: string
  nameTestid: string
}

/**
 * Name cell shared by all three pack modals: a plain label, a
 * click-to-edit label (rename trigger), or the inline rename input —
 * mutually exclusive states driven by `useInlineRename`.
 */
export function PackNameCell({
  name,
  editing,
  canRename,
  locked,
  editLabel,
  onEditLabelChange,
  onBlur,
  onKeyDown,
  onStartRename,
  maxLength,
  inputTestid,
  nameTestid,
}: PackNameCellProps): JSX.Element {
  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={editLabel}
        onChange={(e) => onEditLabelChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        maxLength={maxLength}
        readOnly={locked}
        className="w-full border-b border-edge bg-transparent px-1 text-sm text-content focus:outline-none focus:border-accent"
        data-testid={inputTestid}
      />
    )
  }
  if (canRename) {
    return (
      <span
        className="block w-full truncate text-content cursor-pointer"
        onClick={onStartRename}
        data-testid={nameTestid}
      >
        {name}
      </span>
    )
  }
  return <span className="text-content">{name}</span>
}
