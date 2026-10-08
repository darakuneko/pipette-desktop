// SPDX-License-Identifier: GPL-2.0-or-later
// Choosing one copy when Drive lists several files with the same name.
// Drive keys files by id and does not keep names unique, so two machines
// creating the same file at once leave two copies. Every lookup by name
// uses the same copy, so writes, merges and the recorded remote state all
// land on one file instead of alternating between them.

import type { DriveFile } from './google-drive'

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

/** Whether `a` is chosen over `b`: the newer `modifiedTime`, ties broken by
 *  the smaller file id. */
function better(a: DriveFile, b: DriveFile): boolean {
  const am = modifiedMs(a)
  const bm = modifiedMs(b)
  if (am !== bm) return am > bm
  return a.id < b.id
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
