// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local Data import body — plan / backup / write / rollback.
//
// Every touched sync unit (snapshots + settings keyed by uid, favorites
// keyed by type) is locked up front, in a fixed order, for the whole
// operation: a plan built from a stale index would otherwise clobber a
// concurrent save that landed between the read and the write. Inside the
// lock, nothing is written until every planned write is known — each
// planned write records whether it overwrites an existing file (with
// that file's original content, for rollback) or creates a new one. If
// any write in the plan fails partway through, everything already
// written is restored in reverse order: an overwrite gets its original
// content written back, a create gets unlinked. A restore failure is
// folded into the thrown error rather than swallowed, so a caller never
// mistakes a half-restored disk for a clean one.
//
// Merge rules are unchanged from the previous inline implementation:
// snapshots/favorites keep the local entry unless it's absent or
// tombstoned (in which case the imported entry replaces it); settings
// use last-write-wins on `_updatedAt`.

import { join, resolve } from 'node:path'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { writeFileAtomic } from '../utils/write-file-atomic'
import { withWriteLock } from '../per-uid-write-lock'
import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'

type EntryMeta = SavedFavoriteMeta | SnapshotMeta

interface ImportBundle<T extends EntryMeta> {
  index: { entries: T[] }
  files: Record<string, string>
}

interface PlannedWrite {
  path: string
  content: string
  kind: 'overwrite' | 'create'
  /** Original file content — only present (and only needed) for `kind: 'overwrite'`. */
  backup?: string
}

interface ImportPlan {
  writes: PlannedWrite[]
  dirs: Set<string>
  changedUnits: string[]
}

const SAFE_KEY_RE = /^[\w-]+$/
const SAFE_FILENAME_RE = /^[\w.()-]+$/

function isSafeKey(key: string): boolean {
  return SAFE_KEY_RE.test(key) && !key.includes('..')
}

function isSafePath(basePath: string, filename: string): boolean {
  if (!SAFE_FILENAME_RE.test(filename)) return false
  const resolved = resolve(basePath, filename)
  return resolved.startsWith(basePath + '/')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read `path` as a JSON-parsed index for the import plan. `null` means
 *  "nothing here yet" (safe to create fresh) — only a missing file
 *  (ENOENT) gets that treatment. Any other read failure or a parse
 *  failure throws, since both mean an existing index this import must
 *  not blindly treat as empty and overwrite. */
async function readIndexStrict(path: string): Promise<{ raw: string; parsed: Record<string, unknown> } | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw new Error(`Corrupted index: ${path}`)
  }
  try {
    return { raw, parsed: JSON.parse(raw) as Record<string, unknown> }
  } catch {
    throw new Error(`Corrupted index: ${path}`)
  }
}

/** Nests `withWriteLock` over every key, innermost task last, so all
 *  locks are held for the whole plan→write→rollback span. `keys` is
 *  expected to already be deduped and in a fixed order — callers sort
 *  so two concurrent imports (or an import racing a normal save) always
 *  acquire shared keys in the same order. */
function withWriteLocks<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  if (keys.length === 0) return task()
  const [key, ...rest] = keys
  return withWriteLock(key, () => withWriteLocks(rest, task))
}

function collectLockKeys(data: Record<string, unknown>): string[] {
  const keys = new Set<string>()
  if (isPlainObject(data.snapshots)) {
    for (const uid of Object.keys(data.snapshots)) if (isSafeKey(uid)) keys.add(uid)
  }
  if (isPlainObject(data.settings)) {
    for (const uid of Object.keys(data.settings)) if (isSafeKey(uid)) keys.add(uid)
  }
  if (isPlainObject(data.favorites)) {
    for (const type of Object.keys(data.favorites)) if (isSafeKey(type)) keys.add(`favorites/${type}`)
  }
  return Array.from(keys).sort()
}

/** Plans the writes for one index-based bundle (snapshots or favorites):
 *  local wins unless the entry is absent or tombstoned, in which case
 *  the imported entry (and its payload file, if the bundle carries one)
 *  replaces it. Returns whether anything changed; planned writes are
 *  appended to `writes` and the bundle's directory to `dirs` as a side
 *  effect so the caller doesn't have to thread three return values
 *  through every call site. */
async function planIndexBundle<T extends EntryMeta>(
  basePath: string,
  bundle: ImportBundle<T>,
  dirs: Set<string>,
  writes: PlannedWrite[],
  buildIndex: (local: Record<string, unknown> | null, entries: T[]) => Record<string, unknown>,
): Promise<boolean> {
  const indexPath = join(basePath, 'index.json')
  const localIndex = await readIndexStrict(indexPath)
  const rawEntries = localIndex?.parsed.entries
  const localEntries: T[] = Array.isArray(rawEntries) ? (rawEntries as T[]) : []
  const localMap = new Map(localEntries.map((e) => [e.id, e]))
  let changed = false

  for (const entry of bundle.index.entries) {
    if (!isSafePath(basePath, entry.filename)) continue

    const existing = localMap.get(entry.id)
    if (existing && !existing.deletedAt) continue

    if (existing) {
      const idx = localEntries.indexOf(existing)
      localEntries[idx] = entry
    } else {
      localEntries.push(entry)
    }

    if (entry.filename in bundle.files) {
      const filePath = join(basePath, entry.filename)
      let localFileContent: string | null = null
      try {
        localFileContent = await readFile(filePath, 'utf-8')
      } catch (err) {
        if (!isEnoent(err)) throw err
      }
      writes.push({
        path: filePath,
        content: bundle.files[entry.filename],
        kind: localFileContent !== null ? 'overwrite' : 'create',
        backup: localFileContent ?? undefined,
      })
    }
    changed = true
  }

  if (changed) {
    dirs.add(basePath)
    const mergedIndex = buildIndex(localIndex?.parsed ?? null, localEntries)
    writes.push({
      path: indexPath,
      content: JSON.stringify(mergedIndex, null, 2),
      kind: localIndex ? 'overwrite' : 'create',
      backup: localIndex?.raw,
    })
  }

  return changed
}

async function planSettingsBundle(
  uid: string,
  bundle: { files: Record<string, string> },
  userData: string,
  dirs: Set<string>,
  writes: PlannedWrite[],
): Promise<boolean> {
  const remoteContent = bundle.files?.['pipette_settings.json']
  if (!remoteContent) return false

  const dir = join(userData, 'sync', 'keyboards', uid)
  const filePath = join(dir, 'pipette_settings.json')

  let localRaw: string | null = null
  let shouldWrite = true
  try {
    localRaw = await readFile(filePath, 'utf-8')
    const localSettings = JSON.parse(localRaw) as { _updatedAt?: string }
    const remoteSettings = JSON.parse(remoteContent) as { _updatedAt?: string }
    const localTime = localSettings._updatedAt ? new Date(localSettings._updatedAt).getTime() : 0
    const remoteTime = remoteSettings._updatedAt ? new Date(remoteSettings._updatedAt).getTime() : 0
    shouldWrite = remoteTime > localTime
  } catch {
    // No local file, or it/the remote payload failed to parse — write.
    shouldWrite = true
  }

  if (!shouldWrite) return false

  dirs.add(dir)
  writes.push({
    path: filePath,
    content: remoteContent,
    kind: localRaw !== null ? 'overwrite' : 'create',
    backup: localRaw ?? undefined,
  })
  return true
}

async function buildPlan(data: Record<string, unknown>, userData: string): Promise<ImportPlan> {
  const writes: PlannedWrite[] = []
  const dirs = new Set<string>()
  const changedUnits: string[] = []

  if (isPlainObject(data.snapshots)) {
    for (const [uid, bundle] of Object.entries(data.snapshots)) {
      if (!isSafeKey(uid)) continue
      const basePath = join(userData, 'sync', 'keyboards', uid, 'snapshots')
      const changed = await planIndexBundle(
        basePath,
        bundle as ImportBundle<SnapshotMeta>,
        dirs,
        writes,
        (local, entries) => (local ? { ...local, entries } : { uid, entries }),
      )
      if (changed) changedUnits.push(`keyboards/${uid}/snapshots`)
    }
  }

  if (isPlainObject(data.settings)) {
    for (const [uid, bundle] of Object.entries(data.settings)) {
      if (!isSafeKey(uid)) continue
      const changed = await planSettingsBundle(uid, bundle as { files: Record<string, string> }, userData, dirs, writes)
      if (changed) changedUnits.push(`keyboards/${uid}/settings`)
    }
  }

  if (isPlainObject(data.favorites)) {
    for (const [type, bundle] of Object.entries(data.favorites)) {
      if (!isSafeKey(type)) continue
      const basePath = join(userData, 'sync', 'favorites', type)
      const changed = await planIndexBundle(
        basePath,
        bundle as ImportBundle<SavedFavoriteMeta>,
        dirs,
        writes,
        (local, entries) => (local ? { ...local, entries } : { type, entries }),
      )
      if (changed) changedUnits.push(`favorites/${type}`)
    }
  }

  return { writes, dirs, changedUnits }
}

/** Writes every planned entry in order; on failure, restores everything
 *  already written (in reverse order) and rethrows. A restore failure is
 *  appended to the original error's message rather than thrown on its
 *  own, so the caller sees both what failed and whether the disk was
 *  left consistent. */
async function writePlan(plan: ImportPlan): Promise<void> {
  for (const dir of plan.dirs) {
    await mkdir(dir, { recursive: true })
  }

  const written: PlannedWrite[] = []
  try {
    for (const w of plan.writes) {
      await writeFileAtomic(w.path, w.content)
      written.push(w)
    }
  } catch (err) {
    const restoreErrors: unknown[] = []
    for (const w of written.slice().reverse()) {
      try {
        if (w.kind === 'overwrite') {
          await writeFileAtomic(w.path, w.backup ?? '')
        } else {
          await unlink(w.path)
        }
      } catch (restoreErr) {
        restoreErrors.push(restoreErr)
      }
    }
    if (restoreErrors.length > 0) {
      throw new Error(
        `Import failed: ${String(err)}; rollback also failed: ${restoreErrors.map(String).join('; ')}`,
      )
    }
    throw err
  }
}

export async function importLocalData(obj: unknown, userData: string): Promise<{ changedUnits: string[] }> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Invalid export file format')
  }
  const data = obj as Record<string, unknown>
  if (data.version !== 1) {
    throw new Error('Unsupported export version')
  }

  const lockKeys = collectLockKeys(data)
  return withWriteLocks(lockKeys, async () => {
    const plan = await buildPlan(data, userData)
    if (plan.writes.length === 0) return { changedUnits: [] }
    await writePlan(plan)
    return { changedUnits: plan.changedUnits }
  })
}
