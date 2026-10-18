// SPDX-License-Identifier: GPL-2.0-or-later
//
// The state of a rehearsal's home directory: every directory and file with
// the file's size and SHA-256, compared before and after a launch. A copy
// holding a symbolic link or a file with another hard link is refused: a
// link could lead the app out of the copy, into the user's real data.

import { createHash } from 'node:crypto'
import { lstatSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface FileEntry {
  kind: 'file'
  size: number
  sha256: string
}

export interface DirEntry {
  kind: 'dir'
}

export type Entry = FileEntry | DirEntry

/** Path relative to the snapshot's root (with `/`) → entry. */
export type Snapshot = Map<string, Entry>

export class LinkError extends Error {}

const CHUNK = 1 << 20

/** The SHA-256 of the first `limit` bytes of `path` (all of it without a
 *  limit). */
export function sha256Of(path: string, limit = Number.POSITIVE_INFINITY): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(CHUNK)
    let left = limit
    while (left > 0) {
      const read = readSync(fd, buffer, 0, Math.min(CHUNK, left), null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      left -= read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Every directory and file under `root`. Throws {@link LinkError} at a
 *  symbolic link, a file with more than one hard link or anything that is
 *  neither a file nor a directory. */
export function snapshotTree(root: string): Snapshot {
  const out: Snapshot = new Map()
  const top = lstatSync(root)
  if (!top.isDirectory()) throw new LinkError(`${root} is not a directory`)
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new LinkError(`the copy holds a symbolic link: ${path}`)
      if (stat.isDirectory()) {
        out.set(rel, { kind: 'dir' })
        walk(path)
      } else if (stat.isFile()) {
        if (stat.nlink > 1) throw new LinkError(`the copy holds a file with ${stat.nlink} hard links: ${path}`)
        out.set(rel, { kind: 'file', size: stat.size, sha256: sha256Of(path) })
      } else {
        throw new LinkError(`the copy holds something that is not a file or a directory: ${path}`)
      }
    }
  }
  walk(root)
  return out
}

export interface TreeDiff {
  added: string[]
  changed: string[]
  removed: string[]
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === 'dir' || b.kind === 'dir') return a.kind === b.kind
  return a.size === b.size && a.sha256 === b.sha256
}

/** The paths added, changed (content or kind) and removed from `before`
 *  to `after`, each sorted. */
export function diffTrees(before: Snapshot, after: Snapshot): TreeDiff {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const [path, entry] of after) {
    const old = before.get(path)
    if (!old) added.push(path)
    else if (!sameEntry(old, entry)) changed.push(path)
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path)
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/** A snapshot as plain JSON, for the report. */
export function snapshotJson(snapshot: Snapshot): Record<string, Entry> {
  return Object.fromEntries(snapshot)
}
