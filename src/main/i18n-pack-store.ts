// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local store for user-imported i18n language packs.
//
// Layout (under userData):
//   sync/i18n/index.json                    — I18nPackIndex (LWW + tombstone, drag order)
//   sync/i18n/packs/{packId}.json           — I18nPackEntryFile.raw (pack JSON verbatim)
//
// Unlike `key-labels` (one sync unit covering both index + files), i18n
// uses two sync unit families: `i18n/index` for the index and
// `i18n/packs/{packId}` for each pack body. notifyChange is split
// accordingly so a single pack edit does not bump every other pack's
// remote LWW timestamp.

import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { access, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import { gcTombstones, mergeEntries, MalformedSyncBundleError } from './sync/merge'
import { log } from './logger'
import { safeFilename, isSafePackId } from './utils/safe-filename'
import {
  BUILTIN_ENGLISH_PACK_ID,
  I18N_INDEX_SYNC_UNIT,
  I18N_PACK_TOMBSTONE_TTL_MS,
  type I18nPackIndex,
  type I18nPackMeta,
  type I18nPackRecord,
  type I18nPackStoreErrorCode as SharedErrorCode,
  type I18nPackStoreResult as SharedResult,
} from '../shared/types/i18n-store'

export type { I18nPackRecord }

const STORE_DIRNAME = 'i18n'
const PACKS_DIRNAME = 'packs'
const INDEX_FILENAME = 'index.json'

// --- Path helpers ------------------------------------------------------------

function getStoreDir(): string {
  return join(app.getPath('userData'), 'sync', STORE_DIRNAME)
}

function getPacksDir(): string {
  return join(getStoreDir(), PACKS_DIRNAME)
}

function getIndexPath(): string {
  return join(getStoreDir(), INDEX_FILENAME)
}

/** True when `m` is at least shaped enough to read `.id` off of safely —
 *  a non-null object with a string `id` field. Guards `mergeSyncedIndex`'s
 *  per-entry filter against a remote `metas` array containing `null` or
 *  other non-object garbage (attacker-reachable data). */
function isPackMetaCandidate(m: unknown): m is I18nPackMeta {
  return typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
}

function getPackPath(packId: string): string {
  if (!isSafePackId(packId)) throw new Error(`Invalid packId: ${packId}`)
  return join(getPacksDir(), `${packId}.json`)
}

function packSyncUnit(packId: string): `i18n/packs/${string}` {
  return `i18n/packs/${packId}`
}

/**
 * Dirty-marks a single pack body's sync unit — except for the built-in
 * English entry, whose body is a placeholder deliberately excluded from
 * sync entirely (see `ensureBuiltinEnglishEntry`'s doc). Every write
 * path that touches a pack body (`savePack`/`renamePack`/`deletePack`)
 * routes through this instead of calling `notifyChange(packSyncUnit(id))`
 * directly, so the exclusion can't be missed at a new call site.
 */
function notifyPackChange(id: string): void {
  if (id === BUILTIN_ENGLISH_PACK_ID) return
  notifyChange(packSyncUnit(id))
}

function nowIso(): string {
  return new Date().toISOString()
}

// --- Write serialization ------------------------------------------------------
//
// Every whole-index read-modify-write path (ensure/save/rename/
// setEnabled/delete/setHubPostId/reorder/purge) shares one promise
// chain so a concurrent pair can't each read a stale snapshot and
// clobber the other's write — mirrors `sync/keyboard-meta.ts`'s
// `withMetaWriteLock` precedent. Scoped to this store only; Key Labels
// has the same pre-existing gap (see the module report, not fixed
// here). Theme Packs used to share this gap too but now has its own
// equivalent lock across all mutation methods (`theme-pack-store.ts`'s
// `withIndexWriteLock`) — that store gained a real second writer
// (remote sync) once its index-merge landed, so its own lock could no
// longer stay scoped to only the two sync entry points.
let indexWriteChain: Promise<unknown> = Promise.resolve()

async function withIndexWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexWriteChain.then(() => fn(), () => fn())
  indexWriteChain = next.catch(() => undefined)
  return next
}

/** Write `content` to `path` via a temp-file-then-rename so a reader can
 *  never observe a torn (partially-written) file — a plain `writeFile`
 *  racing a concurrent read is how `readIndex`'s parse-failure fallback
 *  (`{ metas: [] }`) could otherwise get persisted right over a real
 *  roster by a subsequent read-modify-write. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, path)
}

// --- Sync entry points (pack-bundle-merge.ts) --------------------------------
//
// mergePackIndexBundle/mergePackBodyBundle own the LWW comparison
// (Drive modifiedTime vs local mtime for the body; nothing to own for
// the index anymore — see mergeSyncedIndex below) — these entry points
// only know how to apply an already-decided winning write. Routing the
// write through here (instead of pack-bundle-merge.ts joining
// userData/sync/i18n/... and calling writeFile itself, as it used to)
// gets two things pack-bundle-merge.ts cannot provide on its own:
// `isSafePackId` validation of a packId sourced from a remote Drive
// filename (least-trusted input), and `withIndexWriteLock` so a merge
// write can't land in the middle of this store's own read-modify-write
// cycle (save/rename/delete/reorder/purge) — which, combined with the
// old non-atomic write, is how a torn read could get persisted as an
// empty index over a real roster.

/** Entry-level LWW merge + persist for a synced remote index. Replaces
 *  the old whole-file "remote newer wholesale-replaces local" strategy,
 *  which silently destroyed the other side's roster whenever two
 *  machines each installed a different pack while offline — see
 *  pack-bundle-merge.ts's `mergePackIndexBundle` doc for the full
 *  writeup. Reuses the exact same `mergeEntries`/`gcTombstones`
 *  machinery every other entry-based sync unit (favorites, key-labels,
 *  etc.) already relies on — `I18nPackMeta` carries the same
 *  id/filename/savedAt/updatedAt/deletedAt? shape `EntryMeta` requires.
 *  `preserveLocalOrder` is set because index order is user-meaningful
 *  (drag order), same as key-labels.
 *
 *  Reads, merges, and writes under the write lock as a single atomic
 *  step — not a separate outside-lock read followed by a decided
 *  "apply" call, which is what the old `applySyncedIndex(rawJson)`
 *  shape did. That gap let a concurrent local mutation
 *  (save/rename/delete/reorder) land between the caller's read and its
 *  write (TOCTOU); folding read→merge→write into one lock-held function
 *  closes it.
 *
 *  A remote meta whose `id` doesn't pass `isSafePackId` is dropped
 *  before merging (never persisted, never counted toward
 *  `remoteNeedsUpdate`) — a hostile id here would otherwise later flow
 *  through `collectAllSyncUnits` into a sync-unit string with more than
 *  the expected 3 `/`-separated segments, which `bundleSyncUnit`'s i18n
 *  pack branch would fail to match, falling through to the generic
 *  index-based tail and joining an attacker-chosen path into a
 *  filesystem read that gets bundled for upload. Kept metas also get
 *  their `filename` recomputed from the (now-validated) `id` rather than
 *  trusting whatever string the remote sent — `filename` is never
 *  actually used to build a filesystem path in this store (every path
 *  is derived from `id` via `getPackPath`), but there's no reason to
 *  persist an attacker-controlled string when the correct value is a
 *  one-line derivation.
 *
 *  The built-in English meta rides along in this same merge like any
 *  other entry: every machine creates it locally with its own
 *  first-seen timestamp (`ensureBuiltinEnglishEntry`), so two machines'
 *  copies differ only in `savedAt`/`updatedAt` — whichever side's
 *  per-id LWW wins is harmless, since the content (`name`/`version`/
 *  `enabled`) every machine generates is identical.
 *
 *  `remoteMetas` is typed `unknown[]` rather than `I18nPackMeta[]`
 *  because it is attacker-reachable data (a remote Drive file) whose
 *  shape is never actually guaranteed — a bare `metas: [null]` used to
 *  crash this function reading `m.id` off `null` before `isSafePackId`
 *  ever ran. `isPackMetaCandidate` treats any non-object entry the same
 *  way as a rejected id: dropped via the same unit-name-only warn path
 *  below, never thrown. The `metas` field not being an array at all is
 *  a stronger malformation than a bad element and is rejected one layer
 *  up, by `mergePackIndexBundle` (pack-bundle-merge.ts), which throws
 *  `MalformedSyncBundleError` before this function is even called — see
 *  its own doc for why that one is poll-skip-permanent rather than
 *  silently-filtered.
 *
 *  Returns `applied: false` (never throws) only on an I/O failure
 *  writing the merged index — never for a rejected meta, since those
 *  are silently filtered rather than failing the whole unit. */
export async function mergeSyncedIndex(
  remoteMetas: readonly unknown[],
): Promise<{ applied: boolean; remoteNeedsUpdate: boolean }> {
  return withIndexWriteLock(async () => {
    try {
      const localIndex = await readIndex()
      const rejectedCount = remoteMetas.filter((m) => !isPackMetaCandidate(m) || !isSafePackId(m.id)).length
      if (rejectedCount > 0) {
        log('warn', `sync: dropped ${rejectedCount} unsafe remote meta id(s) for ${I18N_INDEX_SYNC_UNIT}`)
      }
      const safeRemoteMetas = remoteMetas
        .filter((m): m is I18nPackMeta => isPackMetaCandidate(m) && isSafePackId(m.id))
        .map((m) => ({ ...m, filename: `${PACKS_DIRNAME}/${m.id}.json` }))
      const localMetas = gcTombstones(localIndex.metas)
      const remoteMetasGced = gcTombstones(safeRemoteMetas)
      const result = mergeEntries(localMetas, remoteMetasGced, { preserveLocalOrder: true })
      await mkdir(getStoreDir(), { recursive: true })
      await writeFileAtomic(getIndexPath(), JSON.stringify({ metas: result.entries }, null, 2))
      return { applied: true, remoteNeedsUpdate: result.remoteNeedsUpdate }
    } catch {
      return { applied: false, remoteNeedsUpdate: false }
    }
  })
}

/** Local mtime (ms) of a pack body file, or `null` when `packId` is
 *  unsafe or the file doesn't exist yet — either way there is no local
 *  clock to compare against, so the remote side trivially wins the LWW
 *  comparison. */
export async function statLocalPackMtime(packId: string): Promise<number | null> {
  if (!isSafePackId(packId)) return null
  try {
    const stats = await stat(getPackPath(packId))
    return stats.mtime.getTime()
  } catch {
    return null
  }
}

/** Outcome of `applySyncedPackBody`: `'applied'` (write landed),
 *  `'local-wins'` (the in-lock CAS re-check below found local is
 *  already newer-or-tied, so nothing was written), or `'io-error'` (a
 *  genuine, presumably-transient failure). Callers treat `'io-error'`
 *  as an ordinary retried sync failure and `'local-wins'` as "mark for
 *  re-upload, don't fail the unit" — see `mergePackBodyBundle`. */
export type ApplyPackBodyOutcome = 'applied' | 'local-wins' | 'io-error'

/** Apply an already-LWW-won remote pack body. Rejects an unsafe `packId`
 *  by THROWING `MalformedSyncBundleError` (defense in depth — the merge
 *  layer's own filename parsing should never produce one, but this is
 *  the boundary where a remote Drive filename, the least-trusted input
 *  in the sync pipeline, actually gets joined into a filesystem path).
 *  Throwing here (rather than returning `false`, as this used to) lets
 *  the sync poll's `instanceof MalformedSyncBundleError` check recognize
 *  this as a permanently-rejected revision and stop retrying it every 3
 *  minutes — a bare `Error` previously looked identical to a transient
 *  I/O failure, which the poll deliberately DOES keep retrying.
 *
 *  Re-checks the local pack file's mtime against `remoteModifiedTime`
 *  again HERE, under the lock, immediately before writing (a
 *  compare-and-swap): the caller's own LWW decision
 *  (`mergePackBodyBundle` in pack-bundle-merge.ts) reads local mtime
 *  OUTSIDE this lock, so a local save (`savePack`/`renamePack` — both
 *  lock-serialized) can land in the window between that read and this
 *  write acquiring the lock. If local is now `>=` the remote revision
 *  this call was about to apply, refuse the write and report
 *  `'local-wins'` instead of clobbering the fresher local save — the
 *  caller then marks the unit for re-upload rather than treating it as
 *  a failure.
 *
 *  On success, pins the written file's mtime to the remote's own
 *  `modifiedTime` rather than leaving it at "now" — without that, the
 *  very next LWW comparison would see the freshly written local copy as
 *  newer than the remote it was just copied from, re-upload it, and
 *  round-trip forever between any two devices that both hold this
 *  pack. The mtime pin is a SEPARATE try/catch from the body write
 *  above: the write already landed by the time we attempt this, so a
 *  utimes failure (e.g. a filesystem without utimes support) must not
 *  report `'io-error'` — that would fail the whole unit and re-enter
 *  this same clock-skew race on the very next poll, unbounded. Instead
 *  it's logged as a unit-name-only warn and treated as `'applied'`: the
 *  worst case is one redundant future re-upload of unchanged content,
 *  which is strictly better than an unbounded retry loop. Returns
 *  `'io-error'` (never throws for this case) on any OTHER I/O failure
 *  (i.e. the write itself) so the caller can surface it as an ordinary,
 *  retried, per-unit sync failure. */
export async function applySyncedPackBody(
  packId: string,
  rawJson: string,
  remoteModifiedTime: string,
): Promise<ApplyPackBodyOutcome> {
  if (!isSafePackId(packId)) {
    throw new MalformedSyncBundleError(packSyncUnit(packId))
  }
  return withIndexWriteLock(async () => {
    try {
      const path = getPackPath(packId)
      const modMs = new Date(remoteModifiedTime).getTime()
      if (!Number.isNaN(modMs)) {
        try {
          const currentStat = await stat(path)
          if (currentStat.mtime.getTime() >= modMs) return 'local-wins'
        } catch {
          // no local file yet — nothing to race against, proceed
        }
      }
      await mkdir(getPacksDir(), { recursive: true })
      await writeFileAtomic(path, rawJson)
      if (!Number.isNaN(modMs)) {
        try {
          const pinned = new Date(modMs)
          await utimes(path, pinned, pinned)
        } catch {
          log('warn', `sync: failed to pin mtime for ${packSyncUnit(packId)} after apply`)
        }
      }
      return 'applied'
    } catch {
      return 'io-error'
    }
  })
}

/** Pin a pack body file's mtime to the Drive `modifiedTime` a
 *  just-completed local-wins UPLOAD was assigned, closing a
 *  clock-skew gap: without this, the local file keeps its own
 *  wall-clock write time, which (if the local clock runs even slightly
 *  ahead of Drive's own clock) permanently looks "newer than the
 *  remote copy" — every subsequent sync pass would then re-upload this
 *  unchanged body, and every peer would re-download it, forever.
 *  Lock-scoped so it can't race a concurrent local save's own write of
 *  this same file.
 *
 *  `expectedLocalMtimeMs` is a compare-and-swap guard: the caller
 *  (`uploadSyncUnit`, sync-service.ts) snapshots the local file's mtime
 *  BEFORE bundling the content for upload — outside this store's write
 *  lock, since bundling/encrypting/uploading to Drive all happen
 *  without holding it. A user save (`savePack`/`renamePack`, both
 *  lock-serialized) can land in the window between that snapshot and
 *  this function actually acquiring the lock. Blindly pinning in that
 *  case would stamp the NEW content with the OLD upload's Drive time —
 *  the next LWW comparison then sees local and remote as tied, and the
 *  new edit never gets uploaded. So this re-checks the file's current
 *  mtime against the snapshot, under the lock, immediately before
 *  writing: only pin if nothing changed; otherwise skip (the newer
 *  edit's own upload will supersede this pin attempt). `null` means the
 *  caller had no local snapshot to compare (the pack body did not exist
 *  yet at snapshot time) — since there's nothing to safely CAS against,
 *  skip rather than guess.
 *
 *  Best-effort beyond the CAS check: swallows any I/O error (stat or
 *  utimes) with a unit-name-only warn, since a missed pin only costs a
 *  redundant re-upload on the next pass, not data loss. */
export async function pinPackBodyMtime(
  packId: string,
  modifiedTime: string,
  expectedLocalMtimeMs: number | null,
): Promise<void> {
  if (!isSafePackId(packId)) return
  await withIndexWriteLock(async () => {
    const modMs = new Date(modifiedTime).getTime()
    if (Number.isNaN(modMs)) return
    if (expectedLocalMtimeMs === null) {
      log('debug', `sync: skipped mtime pin for ${packSyncUnit(packId)} — no local snapshot to compare`)
      return
    }
    try {
      const path = getPackPath(packId)
      const currentStat = await stat(path)
      if (currentStat.mtime.getTime() !== expectedLocalMtimeMs) {
        log('debug', `sync: skipped mtime pin for ${packSyncUnit(packId)} — local file changed since upload snapshot`)
        return
      }
      const pinned = new Date(modMs)
      await utimes(path, pinned, pinned)
    } catch {
      log('warn', `sync: failed to pin mtime for ${packSyncUnit(packId)} after upload`)
    }
  })
}

// --- Result type -------------------------------------------------------------

export type I18nPackStoreErrorCode = SharedErrorCode
export type I18nPackStoreResult<T> = SharedResult<T>

function ok<T>(data?: T): I18nPackStoreResult<T> {
  return { success: true, data }
}

function fail<T>(errorCode: I18nPackStoreErrorCode, error: string): I18nPackStoreResult<T> {
  return { success: false, errorCode, error }
}

// --- Index I/O ---------------------------------------------------------------

// Exported (in addition to internal use throughout this module) so
// `mergePackIndexBundle` (pack-bundle-merge.ts) can read the current
// local index for its LWW comparison without pack-bundle-merge.ts
// knowing this store's on-disk path — same parse-failure-tolerant
// fallback (`{ metas: [] }`) callers relied on before.
export async function readIndex(): Promise<I18nPackIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as I18nPackIndex
    if (Array.isArray(parsed?.metas)) return parsed
  } catch {
    // missing / corrupt — return empty
  }
  return { metas: [] }
}

async function writeIndex(index: I18nPackIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function findActiveByName(metas: I18nPackMeta[], name: string, excludeId?: string): I18nPackMeta | undefined {
  const target = name.trim().toLowerCase()
  return metas.find((m) => !m.deletedAt && m.id !== excludeId && m.name.trim().toLowerCase() === target)
}

/** Three-state precedence used by `savePack` for every optional meta field
 *  the caller can either set, clear, or inherit:
 *    - `null`        → explicit clear (drop the existing value)
 *    - other value   → adopt the new value
 *    - `undefined`   → inherit `existing` (no change)
 *  Pulling this out keeps the savePack body declarative and prevents the
 *  three-branch pattern from being re-derived per field. */
function resolveOptionalField<T>(input: T | null | undefined, existing: T | undefined): T | undefined {
  if (input === null) return undefined
  if (input !== undefined) return input
  return existing
}

// --- GC: purge tombstones older than the TTL --------------------------------

async function purgeExpiredTombstonesInPlace(index: I18nPackIndex): Promise<{ removed: number; touched: boolean }> {
  const cutoff = Date.now() - I18N_PACK_TOMBSTONE_TTL_MS
  const kept: I18nPackMeta[] = []
  let removed = 0
  for (const meta of index.metas) {
    if (meta.deletedAt && new Date(meta.deletedAt).getTime() < cutoff) {
      removed += 1
      // Best-effort delete the pack body — the meta itself is dropped.
      try { await unlink(getPackPath(meta.id)) } catch { /* swallow */ }
      continue
    }
    kept.push(meta)
  }
  if (removed === 0) return { removed: 0, touched: false }
  index.metas = kept
  return { removed, touched: true }
}

export async function purgeExpiredTombstones(): Promise<number> {
  return withIndexWriteLock(async () => {
    const index = await readIndex()
    const result = await purgeExpiredTombstonesInPlace(index)
    if (result.touched) {
      await writeIndex(index)
      notifyChange(I18N_INDEX_SYNC_UNIT)
    }
    return result.removed
  })
}

/**
 * Make sure the index has a built-in English entry. Mirrors
 * `key-label-store.ts`'s `ensureQwertyEntry`: promoting English from a
 * renderer-synthesized row to a real store entry lets it participate in
 * drag reorder and Name sort like any imported pack, while its position
 * and rename history survive sync via the stable `BUILTIN_ENGLISH_PACK_ID`.
 *
 * The pack body is a trivial placeholder (`{ name, version }`, no
 * translation keys) — unlike QWERTY's empty `map` (which the renderer
 * falls back to reading), English is never actually rendered from this
 * entry's body; the renderer always uses the bundled
 * `src/renderer/i18n/locales/english.json` directly. The placeholder
 * only needs to satisfy `extractHeader`'s name/version requirement so
 * `getPack` stays uniform across every id (no special-casing needed
 * there, or in `export`/`rename`, which are intentionally left
 * store-level-unguarded — same as QWERTY. Only delete is guarded, below).
 *
 * The body is also deliberately excluded from `collectAllSyncUnits`
 * (`sync-bundle.ts`) and from `notifyPackChange` — every machine
 * ensures the same trivial content locally, so syncing it would just
 * be wasted bandwidth for a file that is never read.
 */
async function ensureBuiltinEnglishEntry(): Promise<void> {
  return withIndexWriteLock(async () => {
    const index = await readIndex()
    const existing = index.metas.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)
    if (existing) {
      // Self-heal: a synced remote index can deliver this meta before
      // this machine has ever created the local body file (the body
      // is excluded from sync — see above — so only the meta arrives
      // remotely). Recreate the placeholder so `getPack` doesn't
      // IO_ERROR; no index change, so no notifyChange here.
      await writeBuiltinEnglishBodyIfMissing()
      return
    }

    const now = nowIso()
    const meta: I18nPackMeta = {
      id: BUILTIN_ENGLISH_PACK_ID,
      filename: `${PACKS_DIRNAME}/${BUILTIN_ENGLISH_PACK_ID}.json`,
      name: 'English',
      version: '0.0.0',
      enabled: true,
      uploaderName: 'pipette',
      savedAt: now,
      updatedAt: now,
    }
    await writeBuiltinEnglishBodyIfMissing()

    // Pin English to the head on first creation (migration for existing
    // installs) so the visual position matches the pre-migration
    // synthesized-always-first row — the user can drag it elsewhere
    // afterwards, same as QWERTY.
    index.metas.unshift(meta)
    await writeIndex(index)
    // Index only — never notifyChange the per-pack sync unit for this id
    // (see the module doc above: its body is placeholder and excluded
    // from sync entirely).
    notifyChange(I18N_INDEX_SYNC_UNIT)
  })
}

async function writeBuiltinEnglishBodyIfMissing(): Promise<void> {
  try {
    await access(getPackPath(BUILTIN_ENGLISH_PACK_ID))
    return
  } catch {
    // missing — fall through and (re)create it
  }
  await mkdir(getPacksDir(), { recursive: true })
  await writeFile(getPackPath(BUILTIN_ENGLISH_PACK_ID), JSON.stringify({ name: 'English', version: '0.0.0' }, null, 2), 'utf-8')
}

// --- Public API --------------------------------------------------------------

export async function listMetas(): Promise<I18nPackMeta[]> {
  await ensureBuiltinEnglishEntry()
  const index = await readIndex()
  return index.metas.filter((m) => !m.deletedAt)
}

export async function listAllMetas(): Promise<I18nPackMeta[]> {
  await ensureBuiltinEnglishEntry()
  const index = await readIndex()
  return index.metas
}

export async function getPack(id: string): Promise<I18nPackStoreResult<I18nPackRecord>> {
  if (!isSafePackId(id)) return fail('NOT_FOUND', 'Invalid pack id')
  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id)
    if (!meta || meta.deletedAt) return fail('NOT_FOUND', 'Language pack not found')
    const raw = await readFile(getPackPath(id), 'utf-8')
    const pack: unknown = JSON.parse(raw)
    return ok({ meta, pack })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export interface SavePackInput {
  /** Use when overwriting an existing pack — preserves enabled / hubPostId. */
  id?: string
  /** Pack JSON body (with name, version + translations at top level). */
  pack: unknown
  /** Defaults to true on first import. */
  enabled?: boolean
  hubPostId?: string | null
  /** Hub-side `updated_at` for the just-downloaded pack. Pass on
   *  hub-download / hub-sync paths so the startup auto-update can
   *  compare against `POST /api/i18n-packs/timestamps` later. `null`
   *  explicitly clears any inherited value (e.g. detach from Hub). */
  hubUpdatedAt?: string | null
  /** Hub-side `uploader_name`. Same three-state (`null` clears,
   *  `undefined` inherits, string adopts) as `hubUpdatedAt`. */
  uploaderName?: string | null
  appVersionAtImport?: string
  /** English baseline version this pack covered at save time, or null
   * when coverage was partial. Persisted on the meta and surfaced in
   * the language pack list. */
  matchedBaseVersion?: string | null
  /** Coverage snapshot for the row's status line. */
  coverage?: { totalKeys: number; coveredKeys: number } | null
  dangerousKeyCount?: number | null
}

interface PackHeader {
  name: string
  version: string
}

function extractHeader(pack: unknown): PackHeader | null {
  if (!pack || typeof pack !== 'object') return null
  const obj = pack as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name.trim()) return null
  if (typeof obj.version !== 'string' || !obj.version.trim()) return null
  return { name: obj.name.trim(), version: obj.version.trim() }
}

export async function savePack(input: SavePackInput): Promise<I18nPackStoreResult<I18nPackMeta>> {
  const header = extractHeader(input.pack)
  if (!header) return fail('INVALID_FILE', 'Pack JSON missing required name/version fields')
  // Never let an import target the built-in English id directly —
  // overwriting its placeholder body would corrupt the row the
  // renderer specially renders (see `ensureBuiltinEnglishEntry`'s
  // doc). No legitimate caller passes this explicitly; defense in
  // depth alongside the name-based exclusion below.
  if (input.id === BUILTIN_ENGLISH_PACK_ID) {
    // Wording constraint: electron-vite's CJS-shim injector regex-scans
    // the bundled chunk for static imports, and a string ending in the
    // token `import` right before a quote (`...import'`) false-matches
    // as a side-effect import — the shims then get spliced into the
    // middle of the chunk and the main build fails with "Unterminated
    // string literal". Keep the word "import" away from the end of
    // this (and any main-process) string literal.
    return fail('INVALID_NAME', 'The built-in English pack cannot be overwritten')
  }

  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      // Auto-overwrite path: if the caller did not specify an id but
      // an active entry already shares this name (case-insensitive),
      // adopt that entry's id so the import replaces the existing pack
      // instead of failing with DUPLICATE_NAME. Mirrors KeyLabels —
      // except the built-in English entry is never adopted this way:
      // its name is unconditionally "taken", so a same-named import
      // without an explicit id falls through to the DUPLICATE_NAME
      // check below instead of silently overwriting the built-in row.
      let resolvedId = input.id
      if (!resolvedId) {
        const existingByName = findActiveByName(index.metas, header.name)
        if (existingByName && existingByName.id !== BUILTIN_ENGLISH_PACK_ID) {
          resolvedId = existingByName.id
        }
      }
      if (findActiveByName(index.metas, header.name, resolvedId)) {
        return fail('DUPLICATE_NAME', 'A language pack with the same name already exists')
      }

      const id = resolvedId ?? randomUUID()
      if (!isSafePackId(id)) return fail('INVALID_FILE', 'Generated pack id is unsafe')

      await mkdir(getPacksDir(), { recursive: true })
      await writeFile(getPackPath(id), JSON.stringify(input.pack, null, 2), 'utf-8')

      const now = nowIso()
      const existing = index.metas.find((m) => m.id === id)
      // hubUpdatedAt: empty/whitespace string is treated the same as null
      // (explicit clear) so a stray '' from a Hub response never persists.
      const hubUpdatedAtInput = typeof input.hubUpdatedAt === 'string'
        ? (input.hubUpdatedAt.trim() || null)
        : input.hubUpdatedAt
      // uploaderName follows the same empty-string-as-clear rule as hubUpdatedAt.
      const uploaderNameInput = typeof input.uploaderName === 'string'
        ? (input.uploaderName.trim() || null)
        : input.uploaderName
      const nextHubPostId = resolveOptionalField(input.hubPostId, existing?.hubPostId)
      const nextHubUpdatedAt = resolveOptionalField(hubUpdatedAtInput, existing?.hubUpdatedAt)
      const nextUploaderName = resolveOptionalField(uploaderNameInput, existing?.uploaderName)
      const nextMatchedBaseVersion = resolveOptionalField(input.matchedBaseVersion, existing?.matchedBaseVersion)
      const nextCoverage = resolveOptionalField(input.coverage, existing?.coverage)
      const nextDangerousKeyCount = resolveOptionalField(input.dangerousKeyCount, existing?.dangerousKeyCount)
      const meta: I18nPackMeta = {
        id,
        filename: `${PACKS_DIRNAME}/${id}.json`,
        name: header.name,
        version: header.version,
        enabled: input.enabled ?? existing?.enabled ?? true,
        hubPostId: nextHubPostId,
        ...(nextHubUpdatedAt ? { hubUpdatedAt: nextHubUpdatedAt } : {}),
        ...(nextUploaderName ? { uploaderName: nextUploaderName } : {}),
        savedAt: existing?.savedAt ?? now,
        updatedAt: now,
        ...(input.appVersionAtImport ? { appVersionAtImport: input.appVersionAtImport } : {}),
        ...(nextMatchedBaseVersion ? { matchedBaseVersion: nextMatchedBaseVersion } : {}),
        ...(nextCoverage ? { coverage: nextCoverage } : {}),
        ...(typeof nextDangerousKeyCount === 'number' ? { dangerousKeyCount: nextDangerousKeyCount } : {}),
      }

      const existingIndex = index.metas.findIndex((m) => m.id === id)
      if (existingIndex >= 0) {
        index.metas[existingIndex] = meta
      } else {
        index.metas.push(meta)
      }
      await writeIndex(index)

      notifyPackChange(id)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function renamePack(id: string, newName: string): Promise<I18nPackStoreResult<I18nPackMeta>> {
  const trimmed = typeof newName === 'string' ? newName.trim() : ''
  if (!trimmed) return fail('INVALID_NAME', 'Name must not be empty')
  if (trimmed.length > 64) return fail('INVALID_NAME', 'Name must be at most 64 characters')

  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id && !m.deletedAt)
      if (!meta) return fail('NOT_FOUND', 'Language pack not found')
      if (findActiveByName(index.metas, trimmed, id)) {
        return fail('DUPLICATE_NAME', 'A language pack with the same name already exists')
      }

      // Rewrite the pack body so the on-disk JSON's `name` mirrors meta.
      const path = getPackPath(id)
      const raw = await readFile(path, 'utf-8')
      const pack = JSON.parse(raw) as Record<string, unknown>
      pack.name = trimmed
      await writeFile(path, JSON.stringify(pack, null, 2), 'utf-8')

      meta.name = trimmed
      meta.updatedAt = nowIso()
      await writeIndex(index)

      notifyPackChange(id)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function setEnabled(id: string, enabled: boolean): Promise<I18nPackStoreResult<I18nPackMeta>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id && !m.deletedAt)
      if (!meta) return fail('NOT_FOUND', 'Language pack not found')
      if (meta.enabled === enabled) return ok(meta)
      meta.enabled = enabled
      meta.updatedAt = nowIso()
      await writeIndex(index)

      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function deletePack(id: string): Promise<I18nPackStoreResult<void>> {
  if (id === BUILTIN_ENGLISH_PACK_ID) {
    return fail('INVALID_NAME', 'English cannot be deleted')
  }
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id)
      if (!meta) return fail('NOT_FOUND', 'Language pack not found')

      const now = nowIso()
      meta.deletedAt = now
      meta.updatedAt = now
      meta.enabled = false
      await writeIndex(index)

      notifyPackChange(id)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok()
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

/**
 * `uploaderName` / `hubUpdatedAt` mirror `key-label-store.ts`'s
 * `setHubPostId`: `undefined` leaves the cached value alone (Update
 * intentionally passes `undefined` for uploaderName — the owner is
 * assumed unchanged), a string adopts the new value, and an
 * empty/whitespace string clears it. Detaching (`hubPostId: null`)
 * always drops `hubUpdatedAt` (meaningless once unlinked) but keeps
 * `uploaderName` unless the caller explicitly clears it too.
 */
export async function setHubPostId(
  id: string,
  hubPostId: string | null,
  uploaderName?: string | null,
  hubUpdatedAt?: string | null,
): Promise<I18nPackStoreResult<I18nPackMeta>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id)
      if (!meta) return fail('NOT_FOUND', 'Language pack not found')
      const normalized = hubPostId?.trim() || null
      if (normalized === null) {
        delete meta.hubPostId
        // hubUpdatedAt is meaningless once detached from Hub; drop it so a
        // future re-link gets a fresh round-trip rather than comparing
        // against a stale cached timestamp.
        delete meta.hubUpdatedAt
      } else {
        meta.hubPostId = normalized
      }
      if (uploaderName !== undefined) {
        const trimmed = uploaderName?.trim() ?? ''
        if (trimmed) {
          meta.uploaderName = trimmed
        } else {
          delete meta.uploaderName
        }
      }
      if (hubUpdatedAt !== undefined) {
        const trimmed = hubUpdatedAt?.trim() ?? ''
        if (trimmed) {
          meta.hubUpdatedAt = trimmed
        } else {
          delete meta.hubUpdatedAt
        }
      }
      meta.updatedAt = nowIso()
      await writeIndex(index)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function hasActiveName(name: string, excludeId?: string): Promise<boolean> {
  const index = await readIndex()
  return Boolean(findActiveByName(index.metas, name, excludeId))
}

/**
 * Apply a manual order to the active metas. Mirrors
 * `key-label-store.ts`'s `reorderActive`: tombstones and any ids not
 * listed in `orderedIds` keep their relative position behind the
 * sorted prefix, so a stale renderer view never silently drops an
 * entry. Only the index changes — pack bodies are untouched — so only
 * `I18N_INDEX_SYNC_UNIT` is bumped, matching `setEnabled`/`setHubPostId`.
 *
 * Like `key-labels`, `i18n/index` now has entry-level LWW merge wired
 * into `sync-service.ts` (`mergeSyncedIndex`, with `preserveLocalOrder`
 * so drag/Name-sort order survives the merge) — a remote index
 * downloaded during sync merges against this reordered one instead of
 * one side replacing the other wholesale.
 */
export async function reorderActive(orderedIds: string[]): Promise<I18nPackStoreResult<void>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const byId = new Map<string, I18nPackMeta>()
      for (const meta of index.metas) byId.set(meta.id, meta)

      const seen = new Set<string>()
      const reordered: I18nPackMeta[] = []
      const now = nowIso()
      for (const id of orderedIds) {
        const meta = byId.get(id)
        if (!meta || meta.deletedAt || seen.has(id)) continue
        meta.updatedAt = now
        reordered.push(meta)
        seen.add(id)
      }

      for (const meta of index.metas) {
        if (seen.has(meta.id)) continue
        reordered.push(meta)
      }

      await writeIndex({ metas: reordered })
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok()
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

/** Save a single pack body to a user-chosen file. The exported JSON
 * matches the on-disk pack format so a round-trip (export → import)
 * is symmetric. Caller supplies the BrowserWindow to anchor the
 * native save dialog. */
export async function exportPackToDialog(
  win: BrowserWindow,
  id: string,
): Promise<I18nPackStoreResult<{ filePath: string }>> {
  const record = await getPack(id)
  if (!record.success || !record.data) {
    return { success: false, errorCode: 'NOT_FOUND', error: record.error ?? 'Language pack not found' }
  }
  const safeName = safeFilename(record.data.meta.name, 'language-pack')
  try {
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Language Pack',
      defaultPath: `i18n-packs-${safeName}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) {
      return { success: false, errorCode: 'IO_ERROR', error: 'cancelled' }
    }
    await writeFile(result.filePath, JSON.stringify(record.data.pack, null, 2), 'utf-8')
    return { success: true, data: { filePath: result.filePath } }
  } catch (err) {
    return { success: false, errorCode: 'IO_ERROR', error: String(err) }
  }
}

/** Wipe all i18n pack data from disk. Called by the Local Reset flow. */
export async function resetAllI18nPacks(): Promise<void> {
  await rm(getStoreDir(), { recursive: true, force: true })
}

/** Best-effort orphan sweep: pack files on disk without an index entry
 * are deleted. NOT currently wired to run automatically anywhere (no
 * call site triggers it after a sync download applies a tombstone) —
 * it exists as a standalone utility a future cleanup pass can call.
 * Wiring it in after the index-merge landed (so a GC'd tombstone's
 * orphaned body file gets swept) is tracked as follow-up in
 * `Task-sync-remote-reset-and-discovery-gaps.md`. */
export async function sweepOrphans(): Promise<number> {
  let removed = 0
  try {
    const index = await readIndex()
    const known = new Set(index.metas.map((m) => `${m.id}.json`))
    const entries = await readdir(getPacksDir())
    for (const file of entries) {
      if (!file.endsWith('.json')) continue
      if (known.has(file)) continue
      try {
        await unlink(join(getPacksDir(), file))
        removed += 1
      } catch { /* swallow */ }
    }
  } catch {
    // packs dir may not exist yet
  }
  return removed
}

// --- Test-only helpers -------------------------------------------------------

export const __testing = {
  getStoreDir,
  getPacksDir,
  getIndexPath,
  getPackPath,
  readIndex,
  writeIndex,
  packSyncUnit,
}
