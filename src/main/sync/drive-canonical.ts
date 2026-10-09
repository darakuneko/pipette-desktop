// SPDX-License-Identifier: GPL-2.0-or-later
// Choosing one copy when Drive lists several files with the same name.
// Drive keys files by id and does not keep names unique, so two machines
// creating the same file at once leave two copies. Every lookup by name
// uses the same copy, so writes, merges and the recorded remote state all
// land on one file instead of alternating between them.

import type { DriveFile } from './google-drive'
import { parseTrashFile, type TrashInfo } from './drive-trash'

interface DriveIndex {
  /** The chosen copy per name, names in first-listed order. */
  canonical: Map<string, DriveFile>
  /** Every copy per name. */
  copies: Map<string, DriveFile[]>
}

/** One index per listing array, built on first use. A pass looks up many
 *  names in the same listing, so this keeps each lookup O(1). Listings are
 *  never modified after `listFiles` returns them, which keeps a cached
 *  index valid. */
const indexes = new WeakMap<readonly DriveFile[], DriveIndex>()

/** An unparseable `modifiedTime` sorts before every valid one, so the
 *  choice does not depend on listing order. */
function modifiedMs(file: DriveFile): number {
  const ms = Date.parse(file.modifiedTime)
  return Number.isNaN(ms) ? -Infinity : ms
}

/** The newest-wins rule every choice between copies follows: the larger
 *  time, ties broken by the smaller file id. */
export function isNewerCopy(aMs: number, aId: string, bMs: number, bId: string): boolean {
  if (aMs !== bMs) return aMs > bMs
  return aId < bId
}

/** Whether `a` is chosen over `b` (`isNewerCopy` on `modifiedTime`). */
function better(a: DriveFile, b: DriveFile): boolean {
  return isNewerCopy(modifiedMs(a), a.id, modifiedMs(b), b.id)
}

function driveIndex(files: readonly DriveFile[]): DriveIndex {
  const cached = indexes.get(files)
  if (cached) return cached
  const index: DriveIndex = { canonical: new Map(), copies: new Map() }
  for (const file of files) {
    const best = index.canonical.get(file.name)
    if (!best || better(file, best)) index.canonical.set(file.name, file)
    const copies = index.copies.get(file.name)
    if (copies) copies.push(file)
    else index.copies.set(file.name, [file])
  }
  indexes.set(files, index)
  return index
}

/** The copy of `name` every lookup uses (see `better`); undefined when
 *  `files` has none. */
export function pickCanonicalFile(files: readonly DriveFile[], name: string): DriveFile | undefined {
  return driveIndex(files).canonical.get(name)
}

/** One file per name — the copy `pickCanonicalFile` chooses — in
 *  first-listed order, for passes that walk a listing and handle each name
 *  once. */
export function canonicalFiles(files: readonly DriveFile[]): DriveFile[] {
  return [...driveIndex(files).canonical.values()]
}

/** Every copy of `name` in `files` (empty when there is none), for deletes
 *  that must not leave a duplicate behind. */
export function filesNamed(files: readonly DriveFile[], name: string): readonly DriveFile[] {
  return driveIndex(files).copies.get(name) ?? []
}

/** Names with two or more copies, in first-listed order. */
export function duplicatedNames(files: readonly DriveFile[]): string[] {
  return [...driveIndex(files).copies].filter(([, copies]) => copies.length > 1).map(([name]) => name)
}

export interface TrashCopy {
  file: DriveFile
  trash: TrashInfo
}

/** Original name → its trash files (drive-trash.ts), names in first-listed
 *  order. Built on first use per listing, like `indexes`, and kept apart
 *  from it so a plain lookup never parses trash names. */
const trashIndexes = new WeakMap<readonly DriveFile[], Map<string, TrashCopy[]>>()

function trashIndex(files: readonly DriveFile[]): Map<string, TrashCopy[]> {
  const cached = trashIndexes.get(files)
  if (cached) return cached
  const index = new Map<string, TrashCopy[]>()
  for (const file of files) {
    const trash = parseTrashFile(file)
    if (!trash) continue
    const copies = index.get(trash.originalName)
    if (copies) copies.push({ file, trash })
    else index.set(trash.originalName, [{ file, trash }])
  }
  trashIndexes.set(files, index)
  return index
}

/** The trash files of `name` in `files` (empty when there is none). */
export function trashCopiesOf(files: readonly DriveFile[], name: string): readonly TrashCopy[] {
  return trashIndex(files).get(name) ?? []
}

/** Names with at least one trash file, in first-listed order. */
export function namesWithTrash(files: readonly DriveFile[]): string[] {
  return [...trashIndex(files).keys()]
}

/** Every copy of `name` and every trash file of it, for deletes meant to
 *  remove the name for good. */
export function filesNamedWithTrash(files: readonly DriveFile[], name: string): DriveFile[] {
  return [...filesNamed(files, name), ...trashCopiesOf(files, name).map((copy) => copy.file)]
}
