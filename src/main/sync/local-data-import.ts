// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local Data import body — plan / backup / write / rollback.
//
// Every touched sync unit (snapshots + settings keyed by uid, favorites
// keyed by type) is locked up front, for the whole operation
// (`withWriteLocks`): a plan built from a stale index would otherwise
// clobber a concurrent save that landed between the read and the write.
// Inside the lock, nothing is written until every planned write is known
// — each planned write records whether it overwrites an existing file
// (with that file's original content, for rollback) or creates a new
// one. If any write in the plan fails partway through, everything
// already written is restored in reverse order: an overwrite gets its
// original content written back, a create gets unlinked. A restore
// failure is folded into the thrown error rather than swallowed, so a
// caller never mistakes a half-restored disk for a clean one.
//
// Merge rules: snapshots/favorites keep the local entry unless it's
// absent or tombstoned (in which case the imported entry replaces it);
// settings use last-write-wins on `_updatedAt`.

import { join, dirname } from 'node:path'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { writeFileAtomic } from '../utils/write-file-atomic'
import { withWriteLocks } from '../per-uid-write-lock'
import { isEnoent } from '../utils/is-enoent'
import { isRecord } from '../../shared/vil-file'
import { isSafeKey, isSafePath } from '../utils/safe-filename'
import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import type { EntryMeta } from './merge'

/** True when `value` has the `{ index: { entries: [...] }, files: {...} }`
 *  shape every index-based bundle (snapshots, favorites) needs before its
 *  entries can be walked. Entries themselves aren't validated here — each
 *  is checked individually in `planIndexBundle` so one malformed entry
 *  can be skipped without discarding the rest of a bundle that is
 *  otherwise well-formed. Guards against a crafted or truncated export
 *  file whose `entries`/`files` field is missing or the wrong JSON type,
 *  which would otherwise reach `for (const entry of bundle.index.entries)`
 *  or a `path.join` call and throw a raw, uninformative TypeError instead
 *  of the same `Invalid export file format` every other malformed-input
 *  case in this module reports. */
function isImportBundleShape(value: unknown): value is { index: { entries: Record<string, unknown>[] }; files: Record<string, unknown> } {
  if (!isRecord(value)) return false
  if (!isRecord(value.index) || !Array.isArray(value.index.entries)) return false
  return isRecord(value.files)
}

type PlannedWrite =
  | { path: string; content: string; kind: 'overwrite'; backup: string }
  | { path: string; content: string; kind: 'create' }

interface ImportPlan {
  writes: PlannedWrite[]
  changedUnits: string[]
}

/** Read `path` as a JSON-parsed index for the import plan. `null` means
 *  "nothing here yet" (safe to create fresh) — only a missing file
 *  (ENOENT) gets that treatment. Any other read failure or a parse
 *  failure throws, since both mean an existing index this import must
 *  not blindly treat as empty and overwrite — but with distinct messages,
 *  since a read failure (permissions, I/O error) says nothing about
 *  whether the file's content is actually corrupted. */
async function readIndexStrict(path: string): Promise<{ raw: string; parsed: Record<string, unknown> } | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw new Error(`Cannot read index: ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return { raw, parsed: JSON.parse(raw) as Record<string, unknown> }
  } catch {
    throw new Error(`Corrupted index: ${path}`)
  }
}

function collectLockKeys(data: Record<string, unknown>): string[] {
  const keys: string[] = []
  if (isRecord(data.snapshots)) {
    for (const uid of Object.keys(data.snapshots)) if (isSafeKey(uid)) keys.push(uid)
  }
  if (isRecord(data.settings)) {
    for (const uid of Object.keys(data.settings)) if (isSafeKey(uid)) keys.push(uid)
  }
  if (isRecord(data.favorites)) {
    for (const type of Object.keys(data.favorites)) if (isSafeKey(type)) keys.push(`favorites/${type}`)
  }
  return keys
}

/** Plans the writes for one index-based bundle (snapshots or favorites):
 *  local wins unless the entry is absent or tombstoned, in which case
 *  the imported entry (and its payload file, if the bundle carries one)
 *  replaces it. `seed` supplies the non-`entries` fields a brand-new
 *  index needs (`{ uid }` for snapshots, `{ type }` for favorites) —
 *  irrelevant when a local index already exists, since its own fields
 *  are kept as-is. `rawBundle` is untrusted (JSON-parsed import file
 *  content), validated against `isImportBundleShape` before any of its
 *  entries are read. Returns the planned writes for this bundle (empty
 *  when nothing changed). */
async function planIndexBundle<T extends EntryMeta>(
  basePath: string,
  rawBundle: unknown,
  seed: Record<string, unknown>,
): Promise<PlannedWrite[]> {
  if (!isImportBundleShape(rawBundle)) {
    throw new Error('Invalid export file format')
  }
  const bundle = rawBundle

  const indexPath = join(basePath, 'index.json')
  const localIndex = await readIndexStrict(indexPath)
  const rawEntries = localIndex?.parsed.entries
  const localEntries: T[] = Array.isArray(rawEntries) ? (rawEntries as T[]) : []
  const localMap = new Map(localEntries.map((e) => [e.id, e]))
  const writes: PlannedWrite[] = []
  let changed = false

  for (const rawEntry of bundle.index.entries) {
    // A malformed single entry (missing/non-string id or filename) is
    // skipped rather than aborting the whole bundle — unlike the
    // structural checks above, one bad entry in an otherwise valid
    // export shouldn't block every other entry from importing.
    if (typeof rawEntry.id !== 'string' || !isSafePath(rawEntry.filename)) continue
    const entry = rawEntry as unknown as T

    const existing = localMap.get(entry.id)
    if (existing && !existing.deletedAt) continue

    if (existing) {
      const idx = localEntries.indexOf(existing)
      localEntries[idx] = entry
    } else {
      localEntries.push(entry)
    }

    if (entry.filename in bundle.files) {
      const payload = bundle.files[entry.filename]
      if (typeof payload !== 'string') {
        throw new Error('Invalid export file format')
      }
      const filePath = join(basePath, entry.filename)
      let localFileContent: string | null = null
      try {
        localFileContent = await readFile(filePath, 'utf-8')
      } catch (err) {
        if (!isEnoent(err)) throw err
      }
      writes.push(
        localFileContent !== null
          ? { path: filePath, content: payload, kind: 'overwrite', backup: localFileContent }
          : { path: filePath, content: payload, kind: 'create' },
      )
    }
    changed = true
  }

  if (changed) {
    const mergedIndex = localIndex ? { ...localIndex.parsed, entries: localEntries } : { ...seed, entries: localEntries }
    writes.push(
      localIndex
        ? { path: indexPath, content: JSON.stringify(mergedIndex, null, 2), kind: 'overwrite', backup: localIndex.raw }
        : { path: indexPath, content: JSON.stringify(mergedIndex, null, 2), kind: 'create' },
    )
  }

  return writes
}

/** Plans the write for one keyboard's settings bundle: last-write-wins on
 *  `_updatedAt`. Returns `null` when the remote payload is missing or not
 *  newer than the local one (nothing to write).
 *
 *  Each failure mode is handled separately. Treating every local read
 *  failure as "no local file" would plan a `create` for a settings file
 *  that exists but couldn't be read (permissions, I/O error), and a later
 *  rollback would then unlink it:
 *   - local file missing (ENOENT): absent, plan a `create`
 *   - local file exists but some other read error: abort the whole
 *     import (throw) rather than risk destroying it
 *   - local file exists but fails to *parse*: plan an `overwrite` with
 *     its raw (unparsed) content as the rollback backup, so a corrupted
 *     local file still gets replaced
 *   - remote payload isn't valid JSON: abort (throw) before writing
 *     anything, so a healthy local settings file is never overwritten
 *     with unparseable content */
async function planSettingsBundle(
  uid: string,
  bundle: unknown,
  userData: string,
): Promise<PlannedWrite | null> {
  if (!isRecord(bundle) || (bundle.files !== undefined && !isRecord(bundle.files))) {
    throw new Error('Invalid export file format')
  }
  const remoteContent = isRecord(bundle.files) ? bundle.files['pipette_settings.json'] : undefined
  if (remoteContent === undefined || remoteContent === null) return null
  if (typeof remoteContent !== 'string') {
    throw new Error('Invalid export file format')
  }

  let remoteSettings: { _updatedAt?: string }
  try {
    remoteSettings = JSON.parse(remoteContent) as { _updatedAt?: string }
  } catch {
    throw new Error('Invalid export file format')
  }

  const filePath = join(userData, 'sync', 'keyboards', uid, 'pipette_settings.json')

  let localRaw: string | null = null
  try {
    localRaw = await readFile(filePath, 'utf-8')
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  let shouldWrite = true
  if (localRaw !== null) {
    try {
      const localSettings = JSON.parse(localRaw) as { _updatedAt?: string }
      const localTime = localSettings._updatedAt ? new Date(localSettings._updatedAt).getTime() : 0
      const remoteTime = remoteSettings._updatedAt ? new Date(remoteSettings._updatedAt).getTime() : 0
      shouldWrite = remoteTime > localTime
    } catch {
      // Local file exists but fails to parse — keep current behaviour and overwrite it.
    }
  }

  if (!shouldWrite) return null

  return localRaw !== null
    ? { path: filePath, content: remoteContent, kind: 'overwrite', backup: localRaw }
    : { path: filePath, content: remoteContent, kind: 'create' }
}

async function buildPlan(data: Record<string, unknown>, userData: string): Promise<ImportPlan> {
  const writes: PlannedWrite[] = []
  const changedUnits: string[] = []

  if (isRecord(data.snapshots)) {
    for (const [uid, bundle] of Object.entries(data.snapshots)) {
      if (!isSafeKey(uid)) continue
      const basePath = join(userData, 'sync', 'keyboards', uid, 'snapshots')
      const bundleWrites = await planIndexBundle<SnapshotMeta>(basePath, bundle, { uid })
      if (bundleWrites.length > 0) {
        writes.push(...bundleWrites)
        changedUnits.push(`keyboards/${uid}/snapshots`)
      }
    }
  }

  if (isRecord(data.settings)) {
    for (const [uid, bundle] of Object.entries(data.settings)) {
      if (!isSafeKey(uid)) continue
      const write = await planSettingsBundle(uid, bundle, userData)
      if (write) {
        writes.push(write)
        changedUnits.push(`keyboards/${uid}/settings`)
      }
    }
  }

  if (isRecord(data.favorites)) {
    for (const [type, bundle] of Object.entries(data.favorites)) {
      if (!isSafeKey(type)) continue
      const basePath = join(userData, 'sync', 'favorites', type)
      const bundleWrites = await planIndexBundle<SavedFavoriteMeta>(basePath, bundle, { type })
      if (bundleWrites.length > 0) {
        writes.push(...bundleWrites)
        changedUnits.push(`favorites/${type}`)
      }
    }
  }

  return { writes, changedUnits }
}

/** Writes every planned entry in order; on failure, restores everything
 *  already written (in reverse order) and rethrows. A restore failure is
 *  appended to the original error's message rather than thrown on its
 *  own, so the caller sees both what failed and whether the disk was
 *  left consistent. */
async function writePlan(plan: ImportPlan): Promise<void> {
  const dirs = new Set(plan.writes.map((w) => dirname(w.path)))
  for (const dir of dirs) {
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
          await writeFileAtomic(w.path, w.backup)
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
  if (!isRecord(obj)) {
    throw new Error('Invalid export file format')
  }
  if (obj.version !== 1) {
    throw new Error('Unsupported export version')
  }

  const lockKeys = collectLockKeys(obj)
  return withWriteLocks(lockKeys, async () => {
    const plan = await buildPlan(obj, userData)
    if (plan.writes.length === 0) return { changedUnits: [] }
    await writePlan(plan)
    return { changedUnits: plan.changedUnits }
  })
}
