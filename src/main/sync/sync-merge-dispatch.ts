// SPDX-License-Identifier: GPL-2.0-or-later
// Per-sync-unit upload/merge/dispatch: uploading a bundle, merging a
// downloaded remote bundle into local state by sync-unit shape, and the
// upload-or-merge-with-remote decision.

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { encrypt, decrypt } from './sync-crypto'
import { listFiles, uploadFile, downloadFile, driveFileName, type DriveFile } from './google-drive'
import { safeTimestamp, MalformedSyncBundleError } from './merge'
import { type BaseEntryMeta, type EntryStore, type StoreMetaMap, STORE_GROUPS, bodyHash, idBodyFilename } from './entry-clocks'
import { type MergeSide, mergeEntries } from './entry-merge'
import { readIndexDirMigrated, unlinkUnreferencedBodyFiles } from './body-filename-migration'
import {
  mergePackIndexBundle,
  mergePackBodyBundle,
  parsePackBodySyncUnit,
  markPackRosterSynced,
} from './pack-bundle-merge'
import { readSettingsFile, bundleSyncUnit, entryStoreForSyncUnit, storeLockKey } from './sync-bundle'
import { writeFileAtomic } from '../utils/write-file-atomic'
import { isSafePathSegment } from '../utils/safe-filename'
import { MAX_RUN_LOGS_PER_KEYBOARD } from '../../shared/types/typing-run-log'
import { applyRemoteKeyboardMetaIndex } from './keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT, type KeyboardMetaIndex } from '../../shared/types/keyboard-meta'
import { KEY_LABEL_SYNC_UNIT } from '../key-label-store'
import { I18N_INDEX_SYNC_UNIT } from '../../shared/types/i18n-store'
import { THEME_INDEX_SYNC_UNIT } from '../../shared/types/theme-store'
import {
  parseTypingAnalyticsDeviceDaySyncUnit,
} from '../typing-analytics/sync'
import { applyRowsToCache } from '../typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../typing-analytics/jsonl/jsonl-reader'
import { deviceDayDir, deviceDayJsonlPath, readPointerKey } from '../typing-analytics/jsonl/paths'
import type { UtcDay } from '../typing-analytics/jsonl/utc-day'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { emptySyncState, loadSyncState, saveSyncState } from '../typing-analytics/sync-state'
import { log } from '../logger'
import { withWriteLock } from '../per-uid-write-lock'
import { recordRemoteState, syncRuntime } from './sync-runtime-state'
import { pickCanonicalFile } from './drive-canonical'
import { notifySyncUnitApplied } from './sync-unit-applied'
import type { SyncBundle, SyncEnvelope } from '../../shared/types/sync'

// The Analyze-panel analytics sync and the debounced flush run on different
// mutexes and can upload the same unit at once. Serializing bundle→upload per
// unit makes the later one bundle the current local file after the earlier
// upload finished, so it cannot overwrite Drive with older content. The
// `upload:` prefix keeps the key apart from the stores' per-uid keys.
async function uploadSyncUnit(
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  return withWriteLock(`upload:${syncUnit}`, () => uploadSyncUnitLocked(syncUnit, password, remoteFiles))
}

async function uploadSyncUnitLocked(
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  const bundle = await bundleSyncUnit(syncUnit)
  if (!bundle) return

  const plaintext = JSON.stringify(bundle)
  const envelope = await encrypt(plaintext, password, syncUnit)

  const files = remoteFiles ?? await listFiles()
  const targetName = driveFileName(syncUnit)
  const listedId = pickCanonicalFile(files, targetName)?.id
  // A listing taken before an earlier upload of this run created the file
  // does not show it (e.g. the Analyze-panel sync and a flush both start
  // without today's analytics file): update that file rather than creating
  // a second one with the same name. No extra listing is requested — a pass
  // that uploads many units would multiply the `files.list` calls.
  const createdId = listedId ? undefined : syncRuntime.createdFileIds.get(targetName)
  // A remembered id may have been deleted since (a reset, another machine),
  // so a missing file is created again; a listed id that is gone fails
  // like any other upload error.
  const uploaded = createdId
    ? await uploadFile(targetName, envelope, createdId, { createIfMissing: true })
    : await uploadFile(targetName, envelope, listedId)
  if (uploaded.id !== listedId) syncRuntime.createdFileIds.set(targetName, uploaded.id)
  recordRemoteState([{ id: uploaded.id, name: targetName, modifiedTime: uploaded.modifiedTime }])

  // Post-upload bookkeeping: record a successful cloud upload for
  // per-day units so the reconcile logic can later distinguish
  // "never uploaded" from "uploaded then remotely deleted".
  const dayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (dayRef) await recordDayUploaded(dayRef)
}

/** Add `{uid}|{hash}` → utcDay to sync-state.uploaded after a
 * successful cloud upload. Idempotent: the list is kept sorted and
 * duplicate-free so repeated uploads of the current-day file don't
 * grow the array. */
async function recordDayUploaded(dayRef: {
  uid: string
  machineHash: string
  utcDay: UtcDay
}): Promise<void> {
  const userData = app.getPath('userData')
  const ownHash = await getMachineHash()
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  const pointerKey = readPointerKey(dayRef.uid, dayRef.machineHash)
  const existing = new Set(state.uploaded[pointerKey] ?? [])
  if (existing.has(dayRef.utcDay)) return
  existing.add(dayRef.utcDay)
  state.uploaded[pointerKey] = Array.from(existing).sort()
  state.last_synced_at = Date.now()
  await saveSyncState(userData, state)
}

/** Write a downloaded per-day JSONL under the owning device's `{hash}/`
 * directory and apply every row in the file. Each day is a distinct
 * file so a partial download of one day does not affect other days for
 * the same remote hash. No-op when the unit's machineHash matches our own:
 * mergeWithRemote never routes own-hash days here (it uploads them in
 * place), so this guards direct callers such as fetchRemoteTypingDay. */
export async function mergeDeviceDayBundle(
  remoteBundle: SyncBundle,
  dayRef: { uid: string; machineHash: string; utcDay: UtcDay },
  userData: string,
  ownHash: string,
): Promise<void> {
  if (dayRef.machineHash === ownHash) return
  const data = remoteBundle.files['data.jsonl']
  if (!data) return

  const localPath = deviceDayJsonlPath(userData, dayRef.uid, dayRef.machineHash, dayRef.utcDay)
  await mkdir(deviceDayDir(userData, dayRef.uid, dayRef.machineHash), { recursive: true })
  await writeFileAtomic(localPath, data)

  // Per-day bundles are replayed in full. The LWW merge is idempotent,
  // so re-applying every row in the file is cheap, correct, and avoids
  // any per-hash `afterId` bookkeeping at the merge layer.
  const { rows } = await readRows(localPath)
  if (rows.length > 0) {
    applyRowsToCache(getTypingAnalyticsDB(), rows)
  }
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  state.last_synced_at = Date.now()
  await saveSyncState(userData, state)
}

// Merges remote bundle into local state, returns whether remote needs update
async function mergeSyncUnit(
  syncUnit: string,
  envelope: SyncEnvelope,
  password: string,
  remoteModifiedTime: string,
): Promise<boolean> {
  const plaintext = await decrypt(envelope, password)
  const remoteBundle = JSON.parse(plaintext) as SyncBundle

  // Handle meta/keyboard-names (entry-level LWW, no data files)
  if (syncUnit === KEYBOARD_META_SYNC_UNIT) {
    const remoteIndex = remoteBundle.index as KeyboardMetaIndex
    const { remoteNeedsUpdate } = await applyRemoteKeyboardMetaIndex(remoteIndex)
    return remoteNeedsUpdate
  }

  const parts = syncUnit.split('/')
  const userData = app.getPath('userData')

  // `syncUnit` here is derived from `syncUnitFromFileName(file.name)` —
  // a Drive filename is attacker-reachable data (anyone who can write
  // to this appData folder), and a crafted name (e.g.
  // `favorites_../../evil.enc` or `keyboards_../../evil_settings.enc`)
  // can make a capture group in that regex contain a path separator.
  // Every `/`-split segment must pass `isSafePathSegment` before ANY
  // branch below joins it into a filesystem path (the settings branch
  // and the generic index-based tail both do) — a single unsafe segment
  // throws the same `MalformedSyncBundleError` a corrupt bundle shape
  // does, so the sync poll's unchanged-revision skip applies here too
  // instead of retrying a permanently-hostile filename every 3 minutes.
  if (parts.some((part) => !isSafePathSegment(part))) {
    throw new MalformedSyncBundleError(syncUnit)
  }

  // Typing-analytics JSONL: each file is owned by one device. Own-hash days
  // are handled earlier in mergeWithRemote (uploaded in place); a remote
  // device's file overwrites the local copy and replays its rows into the
  // cache.
  const dayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (dayRef) {
    await mergeDeviceDayBundle(remoteBundle, dayRef, userData, await getMachineHash())
    return false
  }

  // Handle settings sync unit (single-file LWW)
  if (parts.length === 3 && parts[0] === 'keyboards' && parts[2] === 'settings') {
    const dir = join(userData, 'sync', 'keyboards', parts[1])
    await mkdir(dir, { recursive: true })

    const filePath = join(dir, 'pipette_settings.json')
    const remoteContent = remoteBundle.files['pipette_settings.json']
    if (!remoteContent) return false

    return withWriteLock(storeLockKey(syncUnit), async () => {
      let localTime = 0
      try {
        const raw = await readSettingsFile(dir)
        if (raw !== null) {
          const local = JSON.parse(raw) as { _updatedAt?: string }
          localTime = safeTimestamp(local._updatedAt)
        }
      } catch { /* unreadable local settings */ }

      const remoteSettings = JSON.parse(remoteContent) as { _updatedAt?: string }
      const remoteTime = safeTimestamp(remoteSettings._updatedAt)

      if (remoteTime > localTime) {
        await writeFileAtomic(filePath, remoteContent)
        notifySyncUnitApplied(syncUnit)
        return false
      }
      return localTime > remoteTime
    })
  }

  // Handle "i18n/index" / "themes/index" — the language/theme pack
  // roster, merged per entry (see mergePackIndexBundle's doc).
  if (syncUnit === I18N_INDEX_SYNC_UNIT || syncUnit === THEME_INDEX_SYNC_UNIT) {
    return mergePackIndexBundle(syncUnit, remoteBundle)
  }

  // Handle "i18n/packs/{packId}" / "themes/packs/{packId}" — a single
  // pack body, compared on the body clock it carries (see
  // mergePackBodyBundle's doc).
  const packBodyRef = parsePackBodySyncUnit(syncUnit)
  if (packBodyRef) {
    return mergePackBodyBundle(packBodyRef, remoteBundle, remoteModifiedTime)
  }

  // Handle index-based sync units (favorites, snapshots, analyze-filter,
  // key-label, typing-test-text, run-log)
  const basePath = join(userData, 'sync', ...parts)
  await mkdir(basePath, { recursive: true })

  return withWriteLock(storeLockKey(syncUnit), () => mergeIndexBasedLocked(syncUnit, remoteBundle, basePath))
}

async function mergeIndexBasedLocked(
  syncUnit: string,
  remoteBundle: SyncBundle,
  basePath: string,
): Promise<boolean> {
  const store = entryStoreForSyncUnit(syncUnit)
  if (!store) throw new MalformedSyncBundleError(syncUnit)
  return mergeStoreIndexLocked(store, syncUnit, remoteBundle, basePath)
}

async function mergeStoreIndexLocked<S extends EntryStore>(
  store: S,
  syncUnit: string,
  remoteBundle: SyncBundle,
  basePath: string,
): Promise<boolean> {
  // A remote bundle is attacker-reachable data (anyone who can write to
  // this sync unit's Drive file): a non-array `.entries` or `.files` throws
  // MalformedSyncBundleError (see its doc for how callers contain it per
  // unit), and entries that are not objects with string `id` / `filename`
  // are dropped.
  const remoteIndexEntries = (remoteBundle.index as { entries?: unknown } | undefined)?.entries
  const remoteFiles: unknown = remoteBundle.files
  if (!Array.isArray(remoteIndexEntries) || remoteFiles === null || typeof remoteFiles !== 'object') {
    throw new MalformedSyncBundleError(syncUnit)
  }
  const remoteBodies = remoteFiles as Record<string, unknown>
  const remoteEntries = remoteIndexEntries.filter(isEntryShaped) as StoreMetaMap[S][]

  // Local body filenames carry their id before the merge compares them. An
  // index that exists but cannot be read is left alone, and so are the
  // body files it may still name: the unit fails and is tried again.
  const local = await readIndexDirMigrated(store, basePath)
  if (local.state === 'corrupt') throw new Error(`sync: local index of ${syncUnit} is unreadable`)
  const localEntries = local.state === 'ok' ? local.entries.filter((e) => typeof e.filename === 'string') : []

  let localNames: Set<string>
  try {
    localNames = new Set(await readdir(basePath))
  } catch {
    localNames = new Set()
  }
  const remoteBody = (filename: string): string | undefined => {
    const body = Object.hasOwn(remoteBodies, filename) ? remoteBodies[filename] : undefined
    return typeof body === 'string' ? body : undefined
  }
  // A remote body counts only when both its bundle key and the id-carrying
  // local name it would be saved under are safe path segments.
  const hasBody = (side: MergeSide, entry: BaseEntryMeta): boolean => side === 'local'
    ? isSafePathSegment(entry.filename) && localNames.has(entry.filename)
    : isSafePathSegment(entry.filename) && isSafePathSegment(idBodyFilename(store, entry.id, entry.filename)) && remoteBody(entry.filename) !== undefined
  // Read only on an exact (clock, fields) tie, which is rare.
  const hashOf = STORE_GROUPS[store].hashBody
    ? (side: MergeSide, entry: BaseEntryMeta): string | undefined => {
      if (side === 'remote') {
        const body = remoteBody(entry.filename)
        return body === undefined ? undefined : bodyHash(body)
      }
      try {
        return bodyHash(readFileSync(join(basePath, entry.filename), 'utf-8'))
      } catch {
        return undefined
      }
    }
    : undefined

  const result = mergeEntries(store, localEntries, remoteEntries, {
    hasBody,
    bodyHash: hashOf,
    // Order is per device for key labels (`reorderActive`, key-label-store.ts).
    preserveLocalOrder: syncUnit === KEY_LABEL_SYNC_UNIT,
    runLogRetentionMax: store === 'runLogs' ? MAX_RUN_LOGS_PER_KEYBOARD : undefined,
  })

  // Apply: remote bodies under their id-carrying names, then the index,
  // then the body files nothing names any more.
  let copied = 0
  for (const { from, to } of result.remoteFilesToCopy) {
    const body = remoteBody(from)
    if (!isSafePathSegment(from) || !isSafePathSegment(to) || body === undefined) {
      // `hasBody` already refused these, so the merge never picks them.
      log('warn', `sync: skipped an unsafe remote body filename for ${syncUnit}`)
      continue
    }
    await writeFileAtomic(join(basePath, to), body)
    copied++
  }

  const indexWritten = local.state === 'missing' || result.localNeedsWrite
  if (indexWritten) {
    const base: object = local.state === 'ok' ? local.index : (remoteBundle.index as object)
    await writeFileAtomic(join(basePath, 'index.json'), JSON.stringify({ ...base, entries: result.entries }, null, 2))
  }

  // Run logs evicted by retention keep a tombstone that names their file,
  // so the sweep below would keep it: unlink them here.
  let removed = 0
  for (const meta of result.evicted) {
    if (!isSafePathSegment(meta.filename)) continue
    try {
      await unlink(join(basePath, meta.filename))
      removed++
    } catch {
      // best-effort
    }
  }
  // With no local index, body files already in the directory are not known
  // to be orphans (a lost index could have named them): leave them for a
  // later merge, which sweeps against an index that exists.
  if (local.state === 'ok') removed += await unlinkUnreferencedBodyFiles(store, basePath, result.referencedFilenames)

  if (indexWritten || copied > 0 || removed > 0) notifySyncUnitApplied(syncUnit)
  return result.remoteNeedsUpdate
}

function isEntryShaped(value: unknown): value is BaseEntryMeta {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.id === 'string' && typeof e.filename === 'string'
}

// Merges with remote, uploads if local has changes remote doesn't have.
// Takes the full DriveFile (not just its id) because it's the single
// choke point every merge path funnels through (download sync, polling,
// analytics sync, upload-time merge-before-upload).
//
// Every success path records exactly the revision it handled (the merged
// remote file, or the one uploadSyncUnit just wrote), so callers never record
// on their own. A throw records nothing and the unit stays visible to the
// next poll.
//
// `remoteFile` must be the copy `pickCanonicalFile` (drive-canonical.ts)
// chooses from `remoteFiles` when Drive lists several with its name: an
// upload after the merge writes that same copy, so the merged and the
// recorded revision belong to one file.
export async function mergeWithRemote(
  remoteFile: DriveFile,
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  // Own-device analytics days are append-only logs this machine owns, so
  // nothing on Drive can be newer: re-upload in place without a download.
  const ownDayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (ownDayRef && ownDayRef.machineHash === await getMachineHash()) {
    // The uid comes from a Drive filename, so it is validated before
    // bundleSyncUnit joins it into a local path (same rule as mergeSyncUnit).
    if (!isSafePathSegment(ownDayRef.uid)) throw new MalformedSyncBundleError(syncUnit)
    await uploadSyncUnit(syncUnit, password, remoteFiles)
    return
  }

  const envelope = await downloadFile(remoteFile.id)
  const needsUpload = await mergeSyncUnit(syncUnit, envelope, password, remoteFile.modifiedTime)
  if (needsUpload) {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
  } else {
    recordRemoteState([remoteFile])
  }
  markPackRosterSynced(syncUnit)
}

export async function syncOrUpload(
  syncUnit: string,
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const remoteFile = pickCanonicalFile(remoteFiles, driveFileName(syncUnit))

  if (remoteFile) {
    await mergeWithRemote(remoteFile, syncUnit, password, remoteFiles)
  } else {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
    markPackRosterSynced(syncUnit)
  }
}
