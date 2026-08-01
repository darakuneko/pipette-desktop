// SPDX-License-Identifier: GPL-2.0-or-later
// Per-sync-unit upload/merge/dispatch: uploading a bundle, merging a
// downloaded remote bundle into local state by sync-unit shape, and the
// upload-or-merge-with-remote decision. Split out of sync-service.ts
// (Task-split-sync-service) — see .claude/rules/file-splitting.md.

import { app } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { encrypt, decrypt } from './sync-crypto'
import { listFiles, uploadFile, downloadFile, driveFileName, type DriveFile } from './google-drive'
import { mergeEntries, gcTombstones, safeTimestamp, MalformedSyncBundleError, type EntryMeta } from './merge'
import {
  mergePackIndexBundle,
  mergePackBodyBundle,
  parsePackBodySyncUnit,
  packBodyLocalWins,
  pinPackBodyMtimeAfterUpload,
  statPackBodyLocalMtime,
} from './pack-bundle-merge'
import { readIndexFile, bundleSyncUnit, isRunLogSyncUnit } from './sync-bundle'
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
import type { SyncBundle, SyncEnvelope } from '../../shared/types/sync'

async function uploadSyncUnit(
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  // i18n/theme pack bodies: snapshot the local file's mtime BEFORE
  // bundling — bundling/encrypting/uploading all happen without holding
  // the store's write lock, so a user save (savePack/renamePack) can
  // land in that window. This snapshot is the CAS baseline
  // pinPackBodyMtimeAfterUpload needs below to detect that race — see
  // its doc for why a blind post-upload pin would otherwise stamp a
  // fresher local edit with this upload's stale Drive time.
  const packBodyRef = parsePackBodySyncUnit(syncUnit)
  const packBodyMtimeSnapshot = packBodyRef ? await statPackBodyLocalMtime(packBodyRef) : null

  const bundle = await bundleSyncUnit(syncUnit)
  if (!bundle) return

  const plaintext = JSON.stringify(bundle)
  const envelope = await encrypt(plaintext, password, syncUnit)

  const files = remoteFiles ?? await listFiles()
  const targetName = driveFileName(syncUnit)
  const existing = files.find((f) => f.name === targetName)

  const uploaded = await uploadFile(targetName, envelope, existing?.id)

  // Post-upload bookkeeping: record a successful cloud upload for
  // per-day units so the reconcile logic can later distinguish
  // "never uploaded" from "uploaded then remotely deleted".
  const dayRef = parseTypingAnalyticsDeviceDaySyncUnit(syncUnit)
  if (dayRef) await recordDayUploaded(dayRef)

  // i18n/theme pack bodies: a local-wins upload just gave Drive a fresh
  // `modifiedTime` — pin the local file's mtime to it (rather than
  // leaving it at "now") so a locally-ahead wall clock can't make this
  // file look newer than Drive's own stamped time forever. See
  // pinPackBodyMtimeAfterUpload's doc for the full clock-skew rationale
  // and why the snapshot above is passed through as a CAS guard.
  if (packBodyRef) await pinPackBodyMtimeAfterUpload(packBodyRef, uploaded.modifiedTime, packBodyMtimeSnapshot)
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
 * the same remote hash. No-op when the unit's machineHash matches our
 * own. */
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
  await writeFile(localPath, data, 'utf-8')

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

  // Typing-analytics JSONL: each file is owned by one device. Skip our
  // own hash so a stale remote never clobbers freshly-flushed local
  // rows. For a remote device's file we overwrite the local copy and
  // replay only the newly-appended rows into the cache.
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

    let localTime = 0
    try {
      const raw = await readFile(filePath, 'utf-8')
      const local = JSON.parse(raw) as { _updatedAt?: string }
      localTime = safeTimestamp(local._updatedAt)
    } catch { /* no local settings */ }

    const remoteSettings = JSON.parse(remoteContent) as { _updatedAt?: string }
    const remoteTime = safeTimestamp(remoteSettings._updatedAt)

    if (remoteTime > localTime) {
      await writeFile(filePath, remoteContent, 'utf-8')
      return false
    }
    return localTime > remoteTime
  }

  // Handle "i18n/index" / "themes/index" — the language/theme pack
  // roster, entry-level LWW (same mergeEntries/gcTombstones machinery
  // as favorites/key-labels/etc. below, applied to the pack meta shape
  // instead of a whole-file "newer roster wins wholesale" comparison —
  // see mergePackIndexBundle's doc for why the old file-level strategy
  // was a data-loss bug).
  if (syncUnit === I18N_INDEX_SYNC_UNIT || syncUnit === THEME_INDEX_SYNC_UNIT) {
    return mergePackIndexBundle(syncUnit, remoteBundle)
  }

  // Handle "i18n/packs/{packId}" / "themes/packs/{packId}" — a single
  // pack body, file-level LWW using the Drive file's own modifiedTime
  // (the bundle carries no timestamp of its own — see
  // mergePackBodyBundle's doc).
  const packBodyRef = parsePackBodySyncUnit(syncUnit)
  if (packBodyRef) {
    return mergePackBodyBundle(packBodyRef, remoteBundle, remoteModifiedTime)
  }

  // Handle index-based sync units (favorites, snapshots, analyze-filter,
  // key-label, typing-test-text, run-log)
  const basePath = join(userData, 'sync', ...parts)
  await mkdir(basePath, { recursive: true })

  const localIndex = await readIndexFile(basePath)
  // Both sides' index shape is a union of each possible sync unit's own
  // index type, which a generic function call can't unify against — every
  // constituent reached on this branch is an EntryMeta[] at runtime.
  // i18n/theme/keyboard-meta bundles are intercepted by the dedicated
  // branches above and never reach here.
  //
  // Deliberate coerce-vs-throw asymmetry below: a non-array `.entries` on
  // the LOCAL side is coerced to `[]` (trusted data — a missing/corrupt
  // local index is just an empty starting point, not a reason to fail
  // the merge), while the same shape on the REMOTE side throws
  // MalformedSyncBundleError (untrusted, attacker-reachable data — see
  // its doc for why silently coercing there would be the wrong call).
  const localEntries = gcTombstones(
    Array.isArray(localIndex?.entries) ? (localIndex.entries as EntryMeta[]) : [],
  )
  // A remote bundle is attacker-reachable data (anyone who can write to
  // this sync unit's Drive file) — validate `.entries` is actually an
  // array before handing it to gcTombstones/mergeEntries instead of
  // letting a malformed shape throw an opaque TypeError deep inside
  // them. See MalformedSyncBundleError's doc for how callers contain
  // this per-unit.
  const remoteIndexEntries = (remoteBundle.index as { entries?: unknown } | undefined)?.entries
  if (!Array.isArray(remoteIndexEntries)) {
    throw new MalformedSyncBundleError(syncUnit)
  }
  const remoteEntries = gcTombstones(remoteIndexEntries as EntryMeta[])

  // Merge entries (both sides GC'd to prevent expired-tombstone upload loops).
  // Run-log retention is a deterministic trim (not reject-at-cap like
  // analyze-filter/snapshot), applied as part of this same merge via
  // `runLogRetentionMax` — see applyRunLogRetention's doc comment for why
  // ranking by immutable `startedAt` lets two devices that independently
  // exceeded the cap converge on the same kept set.
  const preserveLocalOrder = syncUnit === KEY_LABEL_SYNC_UNIT
  const runLogRetentionMax = isRunLogSyncUnit(syncUnit) ? MAX_RUN_LOGS_PER_KEYBOARD : undefined
  const result = mergeEntries(localEntries, remoteEntries, { preserveLocalOrder, runLogRetentionMax })

  // Copy files from remote bundle for entries that remote won. Every
  // remote entry's filename must pass isSafePathSegment before it's
  // joined into a local path — a remote bundle is attacker-reachable
  // data (anyone who can write to this sync unit's Drive file), and this
  // is the generic write site every index-based sync unit (favorites,
  // snapshots, analyze-filter, key-label, typing-test-text, run logs)
  // funnels through, so the guard has to live here rather than per-unit.
  let unsafeRemoteFilenames = 0
  for (const filename of result.remoteFilesToCopy) {
    if (!isSafePathSegment(filename)) {
      unsafeRemoteFilenames++
      continue
    }
    if (filename in remoteBundle.files) {
      await writeFile(join(basePath, filename), remoteBundle.files[filename], 'utf-8')
    }
  }
  if (unsafeRemoteFilenames > 0) {
    log('warn', `sync: skipped ${unsafeRemoteFilenames} unsafe remote filename(s) for ${syncUnit}`)
  }

  // Write merged index
  let mergedIndex = localIndex
    ? { ...localIndex, entries: result.entries }
    : remoteBundle.index

  // For the remote-only-so-far branch (no local index yet) the retention
  // trim above must still land in what gets written — narrow override
  // kept to exactly this sync unit.
  if (isRunLogSyncUnit(syncUnit)) {
    mergedIndex = { ...mergedIndex, entries: result.entries }
  }

  await writeFile(
    join(basePath, 'index.json'),
    JSON.stringify(mergedIndex, null, 2),
    'utf-8',
  )

  // Unlink files for entries retention evicted during the merge above —
  // best-effort, a file already gone is not an error. Always empty for
  // every sync unit except run logs (runLogRetentionMax above). Inlined
  // here (rather than shared with typing-run-log-store.ts's own local-save
  // eviction) since this module already owns basePath/fs for this branch.
  for (const meta of result.evicted) {
    if (!isSafePathSegment(meta.filename)) continue
    try {
      await unlink(join(basePath, meta.filename))
    } catch {
      // best-effort
    }
  }

  return result.remoteNeedsUpdate
}

// Merges with remote, uploads if local has changes remote doesn't have.
// Takes the full DriveFile (not just its id) because it's the single
// choke point every merge path funnels through (download sync, polling,
// analytics sync, upload-time merge-before-upload) — an i18n/theme
// pack-body unit can skip the download+decrypt entirely here when local
// is already known to be newer (see `packBodyLocalWins`'s doc).
export async function mergeWithRemote(
  remoteFile: DriveFile,
  syncUnit: string,
  password: string,
  remoteFiles?: DriveFile[],
): Promise<void> {
  const packBodyRef = parsePackBodySyncUnit(syncUnit)
  if (packBodyRef && await packBodyLocalWins(packBodyRef, remoteFile.modifiedTime)) {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
    return
  }

  const envelope = await downloadFile(remoteFile.id)
  const needsUpload = await mergeSyncUnit(syncUnit, envelope, password, remoteFile.modifiedTime)
  if (needsUpload) {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
  }
}

export async function syncOrUpload(
  syncUnit: string,
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const targetName = driveFileName(syncUnit)
  const remoteFile = remoteFiles.find((f) => f.name === targetName)

  if (remoteFile) {
    await mergeWithRemote(remoteFile, syncUnit, password, remoteFiles)
  } else {
    await uploadSyncUnit(syncUnit, password, remoteFiles)
  }
}
