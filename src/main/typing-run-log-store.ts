// SPDX-License-Identifier: GPL-2.0-or-later
// Per-run raw keystroke log store — save/list/get per keyboard. File
// layout mirrors analyze-filter-store.ts (index.json + one JSON file per
// entry under sync/keyboards/{uid}/runs/), but retention and trust model
// differ deliberately:
//
//  - Retention is a deterministic TRIM (newest MAX_RUN_LOGS_PER_KEYBOARD
//    kept, overflow tombstoned), not a reject-at-cap like
//    analyze-filter-store / snapshot-store. The trim itself lives in
//    `sync/merge.ts` (`applyRunLogRetention`), shared with
//    `sync-service.ts`'s post-merge step for this sync unit — see that
//    function's doc comment for why ranking by immutable `startedAt`
//    (not local `savedAt`/LWW `updatedAt`) is what lets every device
//    converge on the same kept set after a sync merge.
//  - This is the highest input-content-recovery-risk data in the app
//    (see `../shared/types/typing-run-log.ts`), so `saveRunLog` re-checks
//    the recording-consent flag itself (main-side defense in depth,
//    independent of the renderer's own gate) and validates the payload's
//    shape/size/timestamps before writing anything to disk.
//  - No delete endpoint: retention is the only eviction path. A
//    renderer-reachable delete for this data is speculative until a
//    timeline UI actually needs it.

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { getAppConfigStore } from './app-config'
import { notifyChange } from './sync/sync-service'
import { withWriteLock } from './per-uid-write-lock'
import { applyRunLogRetention } from './sync/merge'
import { isSafePathSegment, tsForFilename } from './utils/safe-filename'
import { isValidRowColKeycode } from './typing-analytics/typing-analytics-service'
import {
  MAX_RUN_LOG_BYTES,
  MAX_RUN_LOG_EVENTS,
  MAX_RUN_LOGS_PER_KEYBOARD,
  type RunKeystroke,
  type RunKeystrokeLog,
  type RunLogIndex,
  type RunLogMeta,
  type RunWord,
} from '../shared/types/typing-run-log'

/** How far past the run's own duration a keystroke timestamp may land
 *  before it's rejected as implausible (clock jitter / rounding, not an
 *  absolute-time leak) — see `validateRunLog`. */
const TIMESTAMP_SLACK_MS = 5000

function getStoreDir(uid: string): string {
  return join(app.getPath('userData'), 'sync', 'keyboards', uid, 'runs')
}

function getIndexPath(uid: string): string {
  return join(getStoreDir(uid), 'index.json')
}

function getSafeFilePath(uid: string, filename: string): string {
  if (!isSafePathSegment(filename)) throw new Error('Invalid filename')
  return join(getStoreDir(uid), filename)
}

async function readIndex(uid: string): Promise<RunLogIndex> {
  try {
    const raw = await readFile(getIndexPath(uid), 'utf-8')
    const parsed = JSON.parse(raw) as RunLogIndex
    if (parsed.uid === uid && Array.isArray(parsed.entries)) return parsed
  } catch {
    // Missing or corrupt — start fresh
  }
  return { uid, entries: [] }
}

async function writeIndex(uid: string, index: RunLogIndex): Promise<void> {
  await writeFile(getIndexPath(uid), JSON.stringify(index, null, 2), 'utf-8')
}

/** Best-effort unlink of the entries `applyRunLogRetention` just evicted
 *  during a local save — never throws (a file already gone, e.g. from a
 *  previous partial trim, is not an error). Kept private and separate
 *  from `sync-service.ts`'s own inline unlink for the same eviction
 *  during a merge: the two run under different write-lock/ownership
 *  assumptions, so duplicating this handful of lines is simpler than
 *  sharing it across a module boundary that isn't otherwise coupled. */
async function unlinkEvictedRunLogs(dir: string, entries: readonly RunLogMeta[]): Promise<void> {
  for (const meta of entries) {
    if (!isSafePathSegment(meta.filename)) continue
    try {
      await unlink(join(dir, meta.filename))
    } catch {
      // best-effort
    }
  }
}

/** Best-effort reconciliation: unlink any `*.json` payload file in the
 *  runs dir that appears in NEITHER `index.entries` nor its tombstones —
 *  a tombstoned entry still carries its own `filename` (`applyRunLogRetention`
 *  spreads the original entry when converting it), so this only ever
 *  catches a file the index has no memory of at all, e.g. one left behind
 *  by an index write that failed or was corrupted after its payload was
 *  already written. Cheap: `MAX_RUN_LOGS_PER_KEYBOARD` retention already
 *  bounds this directory to a small number of files, so a full `readdir`
 *  on every save is not a scaling concern. Never throws — a listing or
 *  unlink failure here is not fatal to the save that just succeeded. */
async function reconcileOrphanRunLogFiles(dir: string, index: RunLogIndex): Promise<void> {
  const known = new Set(index.entries.map((e) => e.filename))
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return
  }
  for (const file of files) {
    if (file === 'index.json') continue
    if (!file.endsWith('.json')) continue
    if (known.has(file)) continue
    if (!isSafePathSegment(file)) continue
    try {
      await unlink(join(dir, file))
    } catch {
      // best-effort
    }
  }
}

function isRecordingConsentAccepted(): boolean {
  return getAppConfigStore().get('typingRecordingConsentAccepted') === true
}

function isValidKeystroke(value: unknown, durationMs: number): value is RunKeystroke {
  if (!value || typeof value !== 'object') return false
  const k = value as Record<string, unknown>
  if (typeof k.pressMs !== 'number' || !Number.isFinite(k.pressMs)) return false
  const bound = durationMs + TIMESTAMP_SLACK_MS
  if (k.pressMs < 0 || k.pressMs > bound) return false
  if (k.releaseMs !== undefined) {
    if (typeof k.releaseMs !== 'number' || !Number.isFinite(k.releaseMs)) return false
    if (k.releaseMs < k.pressMs || k.releaseMs > bound) return false
  }
  if (!isValidRowColKeycode(k)) return false
  if (k.expectedChar !== undefined && typeof k.expectedChar !== 'string') return false
  if (k.correct !== undefined && typeof k.correct !== 'boolean') return false
  if (k.overlapped !== undefined && typeof k.overlapped !== 'boolean') return false
  return true
}

function isValidWord(value: unknown, durationMs: number): value is RunWord {
  if (!value || typeof value !== 'object') return false
  const w = value as Record<string, unknown>
  if (typeof w.index !== 'number' || !Number.isInteger(w.index)) return false
  if (w.index < 0) return false
  if (w.partial !== undefined && typeof w.partial !== 'boolean') return false
  if (typeof w.display !== 'string') return false
  if (typeof w.typed !== 'string') return false
  if (typeof w.correct !== 'boolean') return false
  if (!Array.isArray(w.keystrokes)) return false
  return w.keystrokes.every((k) => isValidKeystroke(k, durationMs))
}

/** Structural + size + timestamp validation for a run log about to be
 *  saved — main-side defense in depth, independent of whatever the
 *  renderer already enforced (`run-log-recorder.ts`'s own caps).
 *  `expectedUid` must match the payload's own `uid` field. Returns the
 *  already-serialized JSON alongside the validated data so `saveRunLog`
 *  doesn't stringify the (potentially ~1MB) payload a second time. */
function validateRunLog(
  raw: unknown,
  expectedUid: string,
): { ok: true; data: RunKeystrokeLog; serialized: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Malformed run log' }
  const log = raw as Record<string, unknown>
  if (typeof log.runId !== 'string' || !isSafePathSegment(log.runId)) return { ok: false, error: 'Invalid runId' }
  if (typeof log.uid !== 'string' || log.uid !== expectedUid) return { ok: false, error: 'uid mismatch' }
  if (typeof log.startedAt !== 'string' || Number.isNaN(new Date(log.startedAt).getTime())) return { ok: false, error: 'Invalid startedAt' }
  if (typeof log.durationMs !== 'number' || !Number.isFinite(log.durationMs) || log.durationMs < 0) return { ok: false, error: 'Invalid durationMs' }
  if (typeof log.mode !== 'string') return { ok: false, error: 'Invalid mode' }
  if (typeof log.language !== 'string') return { ok: false, error: 'Invalid language' }
  if (log.charCorrelationUnavailable !== undefined && typeof log.charCorrelationUnavailable !== 'boolean') {
    return { ok: false, error: 'Invalid charCorrelationUnavailable' }
  }
  if (!Array.isArray(log.words)) return { ok: false, error: 'Invalid words' }

  const words: RunWord[] = []
  let eventCount = 0
  for (const word of log.words) {
    if (!isValidWord(word, log.durationMs)) return { ok: false, error: 'Invalid word entry' }
    words.push(word)
    eventCount += word.keystrokes.length
  }
  if (eventCount > MAX_RUN_LOG_EVENTS) return { ok: false, error: 'Too many keystrokes' }

  let serialized: string
  try {
    serialized = JSON.stringify(log)
  } catch {
    return { ok: false, error: 'Unserializable run log' }
  }
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_RUN_LOG_BYTES) return { ok: false, error: 'Run log too large' }

  return {
    ok: true,
    data: {
      runId: log.runId,
      uid: log.uid,
      startedAt: log.startedAt,
      durationMs: log.durationMs,
      mode: log.mode,
      language: log.language,
      charCorrelationUnavailable: log.charCorrelationUnavailable,
      words,
    },
    serialized,
  }
}

export async function saveRunLog(uid: string, raw: unknown): Promise<{ success: boolean; entry?: RunLogMeta; error?: string }> {
  if (!isSafePathSegment(uid)) return { success: false, error: 'Invalid uid' }
  if (!isRecordingConsentAccepted()) {
    return { success: false, error: 'Recording consent not accepted' }
  }
  const validated = validateRunLog(raw, uid)
  if (!validated.ok) return { success: false, error: validated.error }
  const log = validated.data

  return withWriteLock(uid, async () => {
    try {
      const dir = getStoreDir(uid)
      await mkdir(dir, { recursive: true })

      const now = new Date()
      const filename = `${tsForFilename(now)}_${log.runId}.json`
      await writeFile(getSafeFilePath(uid, filename), validated.serialized, 'utf-8')

      const index = await readIndex(uid)
      const nowIso = now.toISOString()
      const meta: RunLogMeta = { id: log.runId, startedAt: log.startedAt, filename, savedAt: nowIso, updatedAt: nowIso }
      // Replace-by-id defensively (a run only finishes once per the
      // renderer's own save latch, but never trust that from here). The
      // replaced entry's own payload file (a different filename — the
      // timestamp prefix differs) must be unlinked too, or it leaks on
      // disk forever: it's gone from the index either way, so retention
      // will never see or evict it.
      const existingDup = index.entries.find((e) => e.id === meta.id)
      const withoutDup = index.entries.filter((e) => e.id !== meta.id)
      const { entries, evicted } = applyRunLogRetention([meta, ...withoutDup], MAX_RUN_LOGS_PER_KEYBOARD)
      index.entries = entries
      await writeIndex(uid, index)
      await unlinkEvictedRunLogs(dir, evicted)
      if (existingDup && existingDup.filename !== meta.filename) {
        await unlinkEvictedRunLogs(dir, [existingDup])
      }
      // Corrupt-index reconciliation (defense in depth, not this save's
      // own concern): a payload file the index has no memory of at all —
      // e.g. left behind by a previous save whose index write failed
      // after its payload was already on disk — would otherwise never be
      // evicted by retention (which only ever sees indexed entries),
      // silently defeating the disk bound this data class relies on.
      await reconcileOrphanRunLogFiles(dir, index)

      notifyChange(`keyboards/${uid}/runs`)
      return { success: true, entry: meta }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

export async function listRunLogs(uid: string): Promise<{ success: boolean; entries?: RunLogMeta[]; error?: string }> {
  if (!isSafePathSegment(uid)) return { success: false, error: 'Invalid uid' }
  try {
    const index = await readIndex(uid)
    return { success: true, entries: index.entries.filter((e) => !e.deletedAt) }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function getRunLog(uid: string, runId: string): Promise<{ success: boolean; data?: RunKeystrokeLog; error?: string }> {
  if (!isSafePathSegment(uid)) return { success: false, error: 'Invalid uid' }
  try {
    const index = await readIndex(uid)
    const meta = index.entries.find((e) => e.id === runId)
    if (!meta || meta.deletedAt) return { success: false, error: 'Not found' }
    const raw = await readFile(getSafeFilePath(uid, meta.filename), 'utf-8')
    return { success: true, data: JSON.parse(raw) as RunKeystrokeLog }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
