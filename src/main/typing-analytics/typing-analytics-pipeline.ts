// SPDX-License-Identifier: GPL-2.0-or-later
// Ingest validation, event ingestion, and the debounced flush pipeline that
// drains the in-memory MinuteBuffer + session queue to the per-device JSONL
// master file and the local SQLite cache.

import { app } from 'electron'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingAnalyticsKeyboard,
} from '../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../shared/types/typing-analytics'
import { OBSERVATION_HOLE_MS } from '../../shared/typing-analytics-timing'
import { log } from '../logger'
import { getCurrentAppName } from './app-monitor'
import { buildFingerprint } from './fingerprint'
import type { FinalizedSession } from './session-detector'
import { getTypingAnalyticsDB } from './db/typing-analytics-db'
import { typingAnalyticsDeviceDaySyncUnit } from './sync'
import { getMachineHash } from './machine-hash'
import { applyRowsToCache } from './jsonl/apply-to-cache'
import type { JsonlRow } from './jsonl/jsonl-row'
import { appendRowsToFile } from './jsonl/jsonl-writer'
import { deviceDayJsonlPath } from './jsonl/paths'
import type { UtcDay } from './jsonl/utc-day'
import { emptySyncState, saveSyncState } from './sync-state'
import { taState, type ResolvedScope } from './typing-analytics-state'
import { groupRowsByUidDay } from './typing-analytics-rows'

const FLUSH_DEBOUNCE_MS = 1_000

/**
 * True when there is unsaved analytics state — either live (buffer entries,
 * queued session records, active sessions) or work currently in flight on
 * the flush chain. Both must be visible so the before-quit finalizer waits
 * even when a flush snapshot has already cleared the live state.
 */
export function hasTypingAnalyticsPendingWork(): boolean {
  return (
    taState.dirty ||
    taState.pendingSessions.length > 0 ||
    !taState.minuteBuffer.isEmpty() ||
    taState.sessionDetector.hasAnyActiveSession() ||
    taState.inFlightFlushCount > 0
  )
}

/**
 * Drain everything for a clean shutdown. Closes any active sessions,
 * persists all minute buckets (including the live one), and writes any queued
 * session records. Safe to call when there is nothing pending — no-op then.
 */
export async function flushTypingAnalyticsBeforeQuit(): Promise<void> {
  taState.pendingSessions.push(...taState.sessionDetector.closeAll())
  if (taState.pendingSessions.length > 0) taState.dirty = true
  await flushNow({ final: true })
}

function isValidKeyboard(value: unknown): value is TypingAnalyticsKeyboard {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.uid === 'string' && obj.uid.length > 0 &&
    typeof obj.vendorId === 'number' && Number.isFinite(obj.vendorId) &&
    typeof obj.productId === 'number' && Number.isFinite(obj.productId) &&
    typeof obj.productName === 'string'
  )
}

/** Longest duration (ms) a single keypress is allowed to report. Well
 * above any real tap or held layer key, but low enough to reject a
 * clearly corrupt/fabricated sample (e.g. a renderer bug feeding a stale
 * press record) instead of letting it skew the per-cell histogram. */
const MAX_MATRIX_RELEASE_DURATION_MS = 60_000

/** row/col/keycode validity (non-negative integers for row/col, any
 * finite number for keycode) — shared with `typing-run-log-store.ts`'s
 * per-keystroke validation, which carries the same three fields but no
 * `layer` (a run-log keystroke isn't tagged by layer), hence this being
 * split out from `isValidMatrixCommon` rather than that function being
 * reused directly. */
export function isValidRowColKeycode(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.row === 'number' && Number.isInteger(obj.row) && obj.row >= 0 &&
    typeof obj.col === 'number' && Number.isInteger(obj.col) && obj.col >= 0 &&
    typeof obj.keycode === 'number' && Number.isFinite(obj.keycode)
  )
}

function isValidMatrixCommon(obj: Record<string, unknown>): boolean {
  return (
    isValidRowColKeycode(obj) &&
    typeof obj.layer === 'number' && Number.isInteger(obj.layer) && obj.layer >= 0
  )
}

/** Strip an invalid optional auxiliary field from a `matrix` event
 * payload in place, rather than rejecting the whole keystroke over it.
 * `action`/`overlap`/`pollGapMs` are all best-effort classification data
 * layered on top of a real physical press — an out-of-range value there
 * (a stale/misordered pollGapMs sample, a corrupted boolean) is a timing
 * or classification artifact, not evidence the press itself didn't
 * happen. Rejecting the whole event over it would lose a real keystroke
 * to something the renderer could compute wrong — precisely the class of
 * bug already fixed elsewhere in this pipeline. Core fields
 * (row/col/layer/keycode, checked by isValidMatrixCommon before this runs)
 * are NOT sanitized: there is no safe fallback for "which cell was this",
 * so those still reject the whole event as before.
 *
 * The pollGapMs bound (`0 < pollGapMs <= OBSERVATION_HOLE_MS`) reuses the
 * same shared constant the renderer's hole detection is built on (see
 * matrix-press-duration.ts's onFrame) — by construction, any pollGapMs
 * the renderer ever legitimately attaches already satisfies it, so this
 * is a self-consistency check on the wire value, not an independent
 * policy choice that could drift from the renderer's own threshold. */
function sanitizeMatrixAuxFields(obj: Record<string, unknown>): void {
  if (obj.action !== undefined && obj.action !== 'tap' && obj.action !== 'hold') delete obj.action
  if (obj.overlap !== undefined && typeof obj.overlap !== 'boolean') delete obj.overlap
  if (obj.pollGapMs !== undefined) {
    const gap = obj.pollGapMs
    if (typeof gap !== 'number' || !Number.isFinite(gap) || gap <= 0 || gap > OBSERVATION_HOLE_MS) delete obj.pollGapMs
  }
}

export function isValidEvent(value: unknown): value is TypingAnalyticsEvent {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) return false
  if (!isValidKeyboard(obj.keyboard)) return false
  if (obj.kind === 'char') {
    return typeof obj.key === 'string' && obj.key.length > 0
  }
  if (obj.kind === 'matrix') {
    if (!isValidMatrixCommon(obj)) return false
    sanitizeMatrixAuxFields(obj)
    return true
  }
  if (obj.kind === 'matrix-release') {
    if (!isValidMatrixCommon(obj)) return false
    return (
      typeof obj.durationMs === 'number' && Number.isFinite(obj.durationMs) &&
      obj.durationMs > 0 && obj.durationMs < MAX_MATRIX_RELEASE_DURATION_MS
    )
  }
  return false
}

async function resolveScope(keyboard: TypingAnalyticsKeyboard): Promise<ResolvedScope> {
  const cached = taState.scopeCache.get(keyboard.uid)
  if (cached) return cached
  const fingerprint = await buildFingerprint(keyboard)
  const resolved: ResolvedScope = { fingerprint, scopeKey: canonicalScopeKey(fingerprint) }
  taState.scopeCache.set(keyboard.uid, resolved)
  return resolved
}

export async function ingestEvent(event: TypingAnalyticsEvent): Promise<void> {
  const { fingerprint, scopeKey } = await resolveScope(event.keyboard)
  taState.minuteBuffer.addEvent(event, fingerprint, Date.now())
  // matrix-release events are duration-only by contract (see the shared
  // event type's doc comment) — they carry no new keystroke, so they
  // must not participate in session detection. A held key's release can
  // land minutes after its press (a long hold, or a press near a poll
  // gap); if it counted here, that gap-spanning release could silently
  // extend — or even re-open — a session a press-only stream would have
  // already let idle-close.
  if (event.kind !== 'matrix-release') {
    const finalized = taState.sessionDetector.recordEvent(event.keyboard.uid, scopeKey, event.ts)
    if (finalized.length > 0) taState.pendingSessions.push(...finalized)
  }
  taState.dirty = true
  scheduleFlush()
}

/** Close the active sessions of `uid` (only those whose start `closes`
 * accepts, when given) and queue them for the next flush. */
export function closeSessionsForUid(uid: string, closes?: (startMs: number) => boolean): void {
  const finalized = taState.sessionDetector.closeForUid(uid, closes)
  if (finalized.length === 0) return
  taState.pendingSessions.push(...finalized)
  taState.dirty = true
}

function scheduleFlush(): void {
  if (taState.flushTimer) return
  taState.flushTimer = setTimeout(() => {
    taState.flushTimer = null
    void flushNow({ final: false })
  }, FLUSH_DEBOUNCE_MS)
}

/** Append rows to a per-day JSONL master file and replay them into the
 * local cache. The flush pass batches `saveSyncState` afterwards so a
 * multi-uid flush hits disk once. Only tasks on the flush chain call it,
 * which keeps this device the single, ordered writer of its own files. */
export async function persistOwnJsonlDay(
  uid: string,
  utcDay: UtcDay,
  rows: readonly JsonlRow[],
  machineHash: string,
  userDataDir: string,
): Promise<void> {
  const path = deviceDayJsonlPath(userDataDir, uid, machineHash, utcDay)
  await appendRowsToFile(path, rows)
  applyRowsToCache(getTypingAnalyticsDB(), rows)
}

/**
 * Run a single flush pass: drain the live buffer + session queue, append
 * every row to the per-device JSONL master file, and apply the same rows
 * to the local SQLite cache via the LWW merge helpers. On `final: true`
 * every buffered minute is drained; otherwise only minutes strictly
 * older than the current wall-clock minute are drained so the live
 * minute keeps accumulating.
 */
async function doFlushPass(options: { final: boolean }): Promise<void> {
  if (!taState.dirty && taState.pendingSessions.length === 0) return
  if (taState.flushTimer) {
    clearTimeout(taState.flushTimer)
    taState.flushTimer = null
  }

  // Confirm the DB is usable BEFORE draining the buffer. A failed open here
  // would otherwise throw the drained counts away with no way to recover.
  // persistOwnJsonlRows resolves the singleton on each call, so the return
  // value isn't captured here.
  try {
    getTypingAnalyticsDB()
  } catch (err) {
    log('error', `typing-analytics DB open failed: ${String(err)}`)
    return
  }

  // Resolve the active application name once per flush, then tag every
  // open buffer entry. Done before the drain so the snapshot finalize
  // sees the up-to-date app set. Errors inside getCurrentAppName are
  // swallowed there (returns null), so this never blocks a flush.
  try {
    const appName = await getCurrentAppName()
    taState.minuteBuffer.markAppName(appName)
  } catch (err) {
    // Defensive — getCurrentAppName already catches its own errors,
    // but a bug in markAppName shouldn't drop the whole flush either.
    log('warn', `typing-analytics app-name tag failed: ${String(err)}`)
  }

  // No await may be introduced between this drain and buildSnapshotRows /
  // groupRowsByUidDay below: those functions copy each snapshot's Maps
  // into plain row payloads synchronously, and a retained entry can be
  // reopened (mutated) by the very next ingestEvent. Without that
  // synchronous handoff, a snapshot already handed to a caller could be
  // mutated out from under it before its rows are built.
  const snapshots = options.final
    ? taState.minuteBuffer.drainAll()
    : taState.minuteBuffer.drainClosed(Date.now())
  const sessionsToWrite = taState.pendingSessions.splice(0)

  if (snapshots.length === 0 && sessionsToWrite.length === 0) {
    taState.dirty = !taState.minuteBuffer.isEmpty()
    return
  }

  // Resolve the scope for each session up front. A missing scope is only
  // reachable after a reset (tests) or if the uid never produced an event —
  // drop with a warning rather than requeueing, otherwise the session would
  // loop forever on every subsequent pass.
  const validSessions: Array<{ session: FinalizedSession; resolved: ResolvedScope }> = []
  for (const session of sessionsToWrite) {
    const resolved = taState.scopeCache.get(session.uid)
    if (!resolved) {
      log('warn', `typing-analytics session dropped — scope missing for ${session.uid} (${session.keystrokeCount} keystrokes)`)
      continue
    }
    validSessions.push({ session, resolved })
  }

  // Deduplicate scope upserts: a burst of snapshots or sessions for one
  // scope only needs a single row write per pass.
  const scopesToUpsert = new Map<string, TypingAnalyticsFingerprint>()
  for (const snapshot of snapshots) {
    scopesToUpsert.set(snapshot.scopeId, snapshot.fingerprint)
  }
  for (const { resolved } of validSessions) {
    scopesToUpsert.set(resolved.scopeKey, resolved.fingerprint)
  }

  /** Last `updatedAt` a flush pass wrote. The DB's LWW merge only accepts a
   * row when `excluded.updated_at > current.updated_at` (strict), so two
   * passes landing in the same millisecond would make the second one — the
   * cumulative, corrected re-send of a retained minute — silently lose to
   * the first. Forcing each pass's `updatedAt` strictly past the previous
   * one closes that race regardless of how fast passes run back to back.
   *
   * A backwards clock correction (e.g. NTP) does not roll `updatedAt` back:
   * it stays pinned above the pre-correction value (potentially reading as
   * up to that offset in the future) and flows into `state.last_synced_at`
   * too. This is harmless — rows are scoped per `machineHash`, so there is
   * no cross-machine contention over what "future" means — and required:
   * without it, a re-send after the clock jumps backward would lose the
   * strict `>` LWW race against its own earlier, partial write. Do not
   * "fix" an apparently future-dated row by removing this bump. */
  const updatedAt = claimOwnRowUpdatedAt()
  const rowsByUidDay = groupRowsByUidDay(scopesToUpsert, snapshots, validSessions, updatedAt)
  if (rowsByUidDay.size === 0) {
    taState.dirty = !taState.minuteBuffer.isEmpty()
    return
  }

  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  const state = taState.syncState ?? emptySyncState(machineHash)
  taState.syncState = state

  const touchedUids: string[] = []
  const touchedByUid = new Map<string, UtcDay[]>()
  try {
    // JSONL master write happens first: the file is the source of truth.
    // If the cache apply later fails we still have the data on disk, and
    // the next startup rebuild replays it. Days are written in ascending
    // order so the pointer lands on the most recent row id.
    for (const [uid, byDay] of rowsByUidDay) {
      const orderedDays = Array.from(byDay.keys()).sort()
      const writtenDays: UtcDay[] = []
      for (const day of orderedDays) {
        const rows = byDay.get(day)
        if (!rows || rows.length === 0) continue
        await persistOwnJsonlDay(uid, day, rows, machineHash, userDataDir)
        writtenDays.push(day)
      }
      if (writtenDays.length === 0) continue
      touchedUids.push(uid)
      touchedByUid.set(uid, writtenDays)
      // `state.uploaded` is intentionally NOT updated here — that map
      // tracks days confirmed to be in cloud, and is bumped by the
      // sync layer after a successful upload. Flush only guarantees
      // local disk + cache coherence, so writing here would conflate
      // the two states and break reconcile's "uploaded but cloud
      // missing" signal in C5b.
    }
    state.last_synced_at = updatedAt
    await saveSyncState(userDataDir, state)
  } catch (err) {
    log('error', `typing-analytics flush failed: ${String(err)}`)
    // Re-queue sessions so the next pass can retry. The drained snapshots
    // themselves are NOT lost: minuteBuffer.reopenAll() flips every
    // 'retained' entry back to 'reopened', so the next drain re-finalizes
    // and re-sends the full cumulative minute rather than just whatever
    // arrives after this point — a failed persist is not lossy for
    // retained minutes. (Reopening entries that weren't actually part of
    // this failed pass is harmless — see reopenAll's docblock — so this
    // can run unconditionally.) The one gap this doesn't cover: an entry
    // both finalized and evicted within this same failed pass is already
    // gone from the map and cannot be recovered here — a rare boundary
    // case, accepted.
    taState.minuteBuffer.reopenAll()
    taState.pendingSessions.push(...sessionsToWrite)
    taState.dirty = true
    return
  }

  // Notify the sync layer that new rows are ready for upload.
  for (const uid of touchedUids) {
    notifyOwnDaysChanged(uid, machineHash, touchedByUid.get(uid) ?? [])
  }

  taState.dirty = !taState.minuteBuffer.isEmpty()
}

/** Tell the sync layer that this device's day files of `uid` changed, one
 * sync unit per `(uid, hash, day)` so cloud storage tracks days as
 * independent units. The notifier is captured once so a reset between
 * days cannot null it mid-loop; a failing notify is logged and the other
 * days are still announced. */
export function notifyOwnDaysChanged(uid: string, machineHash: string, days: readonly UtcDay[]): void {
  const notifier = taState.syncNotifier
  if (!notifier) return
  for (const day of days) {
    try {
      notifier(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, day))
    } catch (err) {
      log('warn', `typing-analytics sync notify failed for ${uid} ${day}: ${String(err)}`)
    }
  }
}

/**
 * Schedule a flush behind any in-flight one. Concurrent callers (the
 * debounce timer, the FLUSH IPC, the before-quit finalizer) all await the
 * same chain so quit-time persistence cannot race with an in-flight pass.
 * Tracks an in-flight counter so hasTypingAnalyticsPendingWork() reports
 * pending work even after a snapshot has cleared the live state.
 */
export function flushNow(options: { final: boolean }): Promise<void> {
  return runOnFlushChain(() => doFlushPass(options))
}

/** The `updated_at` for the next batch of rows this device appends to its
 * own JSONL files: strictly above every earlier batch (see the comment in
 * doFlushPass) and above `aboveMs`. A delete passes the newest
 * `updated_at` of the rows it marks deleted, so the marks win the LWW
 * merge, and every later flush stays above the marks. */
export function claimOwnRowUpdatedAt(aboveMs = 0): number {
  const updatedAt = Math.max(Date.now(), taState.lastFlushUpdatedAt + 1, aboveMs + 1)
  taState.lastFlushUpdatedAt = updatedAt
  return updatedAt
}

/** Drop what `uid` has buffered whose time `drops` accepts: minute entries
 * by their minute start, finalized sessions not yet written by their
 * start. Synchronous, so callers run it inside a flush-chain task. */
export function dropBufferedTyping(uid: string, drops: (ms: number) => boolean): void {
  taState.minuteBuffer.discardForUid(uid, drops)
  const kept = taState.pendingSessions.filter((session) => session.uid !== uid || !drops(session.startMs))
  taState.pendingSessions.splice(0, taState.pendingSessions.length, ...kept)
}

/**
 * Drop what `uid` has buffered up to `cutoffMs` (the moment the user asked
 * for the delete): the minute entries starting at or before `cutoffMs` (so
 * the clicked minute goes whole) and the finalized sessions not yet written
 * that started by then. Runs on the flush chain, after every flush queued
 * before it. That data is being deleted, so it is dropped rather than
 * flushed; minutes after the cutoff stay buffered and are written by later
 * flushes. The resolved scope stays cached: a session started after the
 * delete still needs it to be written. The day delete
 * (typing-analytics-day-delete.ts) applies the same rule limited to the
 * deleted ranges.
 */
export function discardBufferedTyping(uid: string, cutoffMs: number): Promise<void> {
  const drops = deletedByCutoff(cutoffMs)
  return runOnFlushChain(() => dropBufferedTyping(uid, drops))
}

/** True for a time (a minute start, or a session start) that a delete with
 * this cutoff and these ranges removes: at or before `cutoffMs` and, when
 * `ranges` is given, inside one of them. */
export function deletedByCutoff(
  cutoffMs: number,
  ranges?: readonly { startMs: number; endMs: number }[],
): (ms: number) => boolean {
  return (ms) => ms <= cutoffMs && (!ranges || ranges.some((r) => ms >= r.startMs && ms < r.endMs))
}

/** Runs `task` behind everything already on the flush chain. */
export function runOnFlushChain(task: () => Promise<void> | void): Promise<void> {
  taState.inFlightFlushCount++
  const next = taState.flushChain
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      taState.inFlightFlushCount--
      if (taState.dirty || taState.pendingSessions.length > 0) {
        scheduleFlush()
      }
    })
  taState.flushChain = next
  return next
}

export function flushTypingAnalyticsNowForTests(): Promise<void> {
  return flushNow({ final: true })
}
