// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — orchestrates the per-minute in-memory buffer,
// session detector, and SQLite persistence. See
// .claude/plans/typing-analytics.md for the design rationale.

import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingAnalyticsKeyboard,
  TypingHeatmapByCell,
} from '../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../shared/types/typing-analytics'
import { log } from '../logger'
import { buildFingerprint } from './fingerprint'
import { getInstallationId } from './installation-id'
import {
  MinuteBuffer,
  MINUTE_MS,
  type MinuteSnapshot,
} from './minute-buffer'
import { SessionDetector, type FinalizedSession } from './session-detector'
import {
  getTypingAnalyticsDB,
  type CharMinuteRow,
  type MatrixMinuteRow,
  type MinuteStatsRow,
  type TypingAnalyticsDB,
  type TypingDailySummary,
  type TypingKeyboardSummary,
  type TypingScopeRow,
  type TypingTombstoneResult,
} from './db/typing-analytics-db'
import { typingAnalyticsSyncUnit } from './sync'
import { getMachineHash } from './machine-hash'

const FLUSH_DEBOUNCE_MS = 1_000

let initialization: Promise<void> | null = null
let ipcRegistered = false

/** Injected sync-change notifier. Kept as a callback instead of a direct
 * import to avoid coupling the analytics service to sync-service at module
 * load time — the main-process bootstrap wires in the real implementation
 * via {@link setTypingAnalyticsSyncNotifier}. */
type SyncNotifier = (syncUnit: string) => void
let syncNotifier: SyncNotifier | null = null

export function setTypingAnalyticsSyncNotifier(notifier: SyncNotifier | null): void {
  syncNotifier = notifier
}

interface ResolvedScope {
  fingerprint: TypingAnalyticsFingerprint
  scopeKey: string
}

const minuteBuffer = new MinuteBuffer()
const sessionDetector = new SessionDetector()
const scopeCache = new Map<string, ResolvedScope>()
const pendingSessions: FinalizedSession[] = []

let dirty = false
let flushChain: Promise<void> = Promise.resolve()
let inFlightFlushCount = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

async function initialize(): Promise<void> {
  await getInstallationId()
}

/**
 * Warm the installation-id cache and other lazy resources. Concurrent callers
 * share the in-flight promise; a failed initialization clears the cached
 * promise so the next call can retry.
 */
export function setupTypingAnalytics(): Promise<void> {
  if (!initialization) {
    initialization = initialize().catch((err) => {
      initialization = null
      throw err
    })
  }
  return initialization
}

/**
 * Register typing-analytics IPC handlers. Called synchronously at startup so
 * the handler is in place before the renderer creates the first BrowserWindow;
 * independent from the async initialization performed by setupTypingAnalytics.
 */
export function setupTypingAnalyticsIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_EVENT,
    async (_event, payload: unknown): Promise<void> => {
      if (!isValidEvent(payload)) return
      await ingestEvent(payload)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_FLUSH,
    async (_event, uid: unknown): Promise<void> => {
      if (typeof uid !== 'string' || uid.length === 0) return
      closeSessionsForUid(uid)
      await flushNow({ final: true })
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_KEYBOARDS,
    async (): Promise<TypingKeyboardSummary[]> => listTypingKeyboards(),
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ITEMS,
    async (_event, uid: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      return listTypingDailySummaries(uid)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS,
    async (_event, uid: unknown, dates: unknown): Promise<TypingTombstoneResult> => {
      const empty: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
      if (typeof uid !== 'string' || uid.length === 0) return empty
      if (!Array.isArray(dates)) return empty
      const validDates = dates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      if (validDates.length === 0) return empty
      return deleteTypingDailySummaries(uid, validDates)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_DELETE_ALL,
    async (_event, uid: unknown): Promise<TypingTombstoneResult> => {
      const empty: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
      if (typeof uid !== 'string' || uid.length === 0) return empty
      return deleteAllTypingForKeyboard(uid)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_MATRIX_HEATMAP,
    async (_event, uid: unknown, layer: unknown, sinceMs: unknown): Promise<TypingHeatmapByCell> => {
      if (typeof uid !== 'string' || uid.length === 0) return {}
      if (typeof layer !== 'number' || !Number.isFinite(layer) || layer < 0) return {}
      if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return {}
      return getMatrixHeatmap(uid, layer, sinceMs)
    },
  )
}

/**
 * True when there is unsaved analytics state — either live (buffer entries,
 * queued session records, active sessions) or work currently in flight on
 * the flush chain. Both must be visible so the before-quit finalizer waits
 * even when a flush snapshot has already cleared the live state.
 */
export function hasTypingAnalyticsPendingWork(): boolean {
  return (
    dirty ||
    pendingSessions.length > 0 ||
    !minuteBuffer.isEmpty() ||
    sessionDetector.hasAnyActiveSession() ||
    inFlightFlushCount > 0
  )
}

/**
 * Drain everything for a clean shutdown. Closes any active sessions,
 * persists all minute buckets (including the live one), and writes any queued
 * session records. Safe to call when there is nothing pending — no-op then.
 */
export async function flushTypingAnalyticsBeforeQuit(): Promise<void> {
  pendingSessions.push(...sessionDetector.closeAll())
  if (pendingSessions.length > 0) dirty = true
  await flushNow({ final: true })
}

// --- Data modal API --------------------------------------------------

/** Keyboards that currently have live typing analytics rows, aggregated
 * across every machine that has synced to this device. */
export function listTypingKeyboards(): TypingKeyboardSummary[] {
  return getTypingAnalyticsDB().listKeyboardsWithTypingData()
}

/** Day-level summaries for one keyboard uid, newest first. */
export function listTypingDailySummaries(uid: string): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUid(uid)
}

/** Heatmap intensity for the typing-view overlay: summed matrix counts
 * per (row, col) on a single keyboard + machine + layer, covering the
 * window `[floorMinute(sinceMs), now]`. Values are the sum of:
 *
 *  - DB rows flushed for that window (closed minutes), and
 *  - the live current-minute entries still sitting in the `MinuteBuffer`.
 *
 * Each cell carries a `{ total, tap, hold }` triple so the UI can
 * colour the outer (hold) and inner (tap) rects of LT/MT keys
 * independently while non-tap-hold keys stay painted by `total`.
 * The live-minute path is what keeps a 5s poll usable — without it
 * the heatmap would lag the debounced flush by up to ~59 seconds.
 * Serializes the Map as a plain keyed object so the triple round-trips
 * through IPC unchanged. */
export async function getMatrixHeatmap(
  uid: string,
  layer: number,
  sinceMs: number,
): Promise<TypingHeatmapByCell> {
  const machineHash = await getMachineHash()
  const sinceMinuteMs = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS

  const db = getTypingAnalyticsDB()
  const totals = db.aggregateMatrixCountsForUid(uid, machineHash, layer, sinceMinuteMs)
  const live = minuteBuffer.peekMatrixCountsForUid(uid, machineHash, layer)
  for (const [key, cell] of live) {
    const existing = totals.get(key)
    if (existing) {
      existing.total += cell.total
      existing.tap += cell.tap
      existing.hold += cell.hold
    } else {
      totals.set(key, { total: cell.total, tap: cell.tap, hold: cell.hold })
    }
  }

  const result: TypingHeatmapByCell = {}
  for (const [key, cell] of totals) result[key] = cell
  return result
}

/** Convert a 'YYYY-MM-DD' local-calendar date into a [startMs, endMs)
 * window that matches the strftime('%Y-%m-%d', ..., 'localtime') buckets
 * used by listDailySummariesForUid. */
function localDayRangeMs(date: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  const startMs = new Date(y, mo - 1, d).getTime()
  const endMs = new Date(y, mo - 1, d + 1).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}

/** Tombstone the live rows for a set of local-calendar dates. Live
 * analytics state is flushed first so any in-memory events land in the
 * DB before the tombstone window is applied. All per-date tombstones
 * run inside a single outer transaction so the renderer sees a single
 * atomic delete instead of N independent writes. */
export async function deleteTypingDailySummaries(
  uid: string,
  dates: string[],
): Promise<TypingTombstoneResult> {
  await flushNow({ final: true })
  const ranges: Array<{ startMs: number; endMs: number }> = []
  for (const date of dates) {
    const range = localDayRangeMs(date)
    if (range) ranges.push(range)
  }
  const total: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
  if (ranges.length === 0) return total

  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  db.getConnection().transaction(() => {
    for (const range of ranges) {
      const result = db.tombstoneRowsForUidInRange(uid, range.startMs, range.endMs, updatedAt)
      total.charMinutes += result.charMinutes
      total.matrixMinutes += result.matrixMinutes
      total.minuteStats += result.minuteStats
      total.sessions += result.sessions
    }
  })()
  notifySyncIfTouched(uid, total)
  return total
}

/** Tombstone every live row for a keyboard uid. */
export async function deleteAllTypingForKeyboard(uid: string): Promise<TypingTombstoneResult> {
  await flushNow({ final: true })
  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  const result = db.tombstoneAllRowsForUid(uid, updatedAt)
  notifySyncIfTouched(uid, result)
  return result
}

function notifySyncIfTouched(uid: string, result: TypingTombstoneResult): void {
  const touched = result.charMinutes + result.matrixMinutes + result.minuteStats + result.sessions
  if (touched === 0) return
  const notifier = syncNotifier
  if (!notifier) return
  try {
    notifier(typingAnalyticsSyncUnit(uid))
  } catch (err) {
    log('warn', `typing-analytics sync notify failed for ${uid}: ${String(err)}`)
  }
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

function isValidEvent(value: unknown): value is TypingAnalyticsEvent {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) return false
  if (!isValidKeyboard(obj.keyboard)) return false
  if (obj.kind === 'char') {
    return typeof obj.key === 'string' && obj.key.length > 0
  }
  if (obj.kind === 'matrix') {
    return (
      typeof obj.row === 'number' && Number.isInteger(obj.row) && obj.row >= 0 &&
      typeof obj.col === 'number' && Number.isInteger(obj.col) && obj.col >= 0 &&
      typeof obj.layer === 'number' && Number.isInteger(obj.layer) && obj.layer >= 0 &&
      typeof obj.keycode === 'number' && Number.isFinite(obj.keycode)
    )
  }
  return false
}

async function resolveScope(keyboard: TypingAnalyticsKeyboard): Promise<ResolvedScope> {
  const cached = scopeCache.get(keyboard.uid)
  if (cached) return cached
  const fingerprint = await buildFingerprint(keyboard)
  const resolved: ResolvedScope = { fingerprint, scopeKey: canonicalScopeKey(fingerprint) }
  scopeCache.set(keyboard.uid, resolved)
  return resolved
}

async function ingestEvent(event: TypingAnalyticsEvent): Promise<void> {
  const { fingerprint, scopeKey } = await resolveScope(event.keyboard)
  minuteBuffer.addEvent(event, fingerprint)
  const finalized = sessionDetector.recordEvent(event.keyboard.uid, scopeKey, event.ts)
  if (finalized.length > 0) pendingSessions.push(...finalized)
  dirty = true
  scheduleFlush()
}

function closeSessionsForUid(uid: string): void {
  const finalized = sessionDetector.closeForUid(uid)
  if (finalized.length === 0) return
  pendingSessions.push(...finalized)
  dirty = true
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow({ final: false })
  }, FLUSH_DEBOUNCE_MS)
}

function scopeRowFromFingerprint(
  scopeKey: string,
  fingerprint: TypingAnalyticsFingerprint,
  updatedAt: number,
): TypingScopeRow {
  return {
    id: scopeKey,
    machineHash: fingerprint.machineHash,
    osPlatform: fingerprint.os.platform,
    osRelease: fingerprint.os.release,
    osArch: fingerprint.os.arch,
    keyboardUid: fingerprint.keyboard.uid,
    keyboardVendorId: fingerprint.keyboard.vendorId,
    keyboardProductId: fingerprint.keyboard.productId,
    keyboardProductName: fingerprint.keyboard.productName,
    updatedAt,
  }
}

function minuteStatsRowFromSnapshot(snapshot: MinuteSnapshot): MinuteStatsRow {
  return {
    scopeId: snapshot.scopeId,
    minuteTs: snapshot.minuteTs,
    keystrokes: snapshot.keystrokes,
    activeMs: snapshot.activeMs,
    intervalAvgMs: snapshot.intervalAvgMs,
    intervalMinMs: snapshot.intervalMinMs,
    intervalP25Ms: snapshot.intervalP25Ms,
    intervalP50Ms: snapshot.intervalP50Ms,
    intervalP75Ms: snapshot.intervalP75Ms,
    intervalMaxMs: snapshot.intervalMaxMs,
  }
}

function charRowsFromSnapshot(snapshot: MinuteSnapshot): CharMinuteRow[] {
  const rows: CharMinuteRow[] = []
  for (const [char, count] of snapshot.charCounts) {
    rows.push({ scopeId: snapshot.scopeId, minuteTs: snapshot.minuteTs, char, count })
  }
  return rows
}

function matrixRowsFromSnapshot(snapshot: MinuteSnapshot): MatrixMinuteRow[] {
  const rows: MatrixMinuteRow[] = []
  for (const { row, col, layer, keycode, count, tapCount, holdCount } of snapshot.matrixCounts.values()) {
    rows.push({
      scopeId: snapshot.scopeId,
      minuteTs: snapshot.minuteTs,
      row,
      col,
      layer,
      keycode,
      count,
      tapCount,
      holdCount,
    })
  }
  return rows
}

/**
 * Run a single flush pass: snapshot the live buffer + session queue, persist
 * them via the SQLite store in one batched transaction. On `final: true`
 * every buffered minute is drained; otherwise only minutes strictly older
 * than the current wall-clock minute are drained so the live minute keeps
 * accumulating.
 */
async function doFlushPass(options: { final: boolean }): Promise<void> {
  if (!dirty && pendingSessions.length === 0) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  // Confirm the DB is usable BEFORE draining the buffer. A failed open here
  // would otherwise throw the drained counts away with no way to recover.
  let db: TypingAnalyticsDB
  try {
    db = getTypingAnalyticsDB()
  } catch (err) {
    log('error', `typing-analytics DB open failed: ${String(err)}`)
    return
  }

  const snapshots = options.final
    ? minuteBuffer.drainAll()
    : minuteBuffer.drainClosed(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS)
  const sessionsToWrite = pendingSessions.splice(0)

  if (snapshots.length === 0 && sessionsToWrite.length === 0) {
    dirty = !minuteBuffer.isEmpty()
    return
  }

  // Resolve the scope for each session up front. A missing scope is only
  // reachable after a reset (tests) or if the uid never produced an event —
  // drop with a warning rather than requeueing, otherwise the session would
  // loop forever on every subsequent pass.
  const validSessions: Array<{ session: FinalizedSession; resolved: ResolvedScope }> = []
  for (const session of sessionsToWrite) {
    const resolved = scopeCache.get(session.uid)
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

  const updatedAt = Date.now()
  const connection = db.getConnection()

  try {
    connection.transaction(() => {
      for (const [scopeId, fingerprint] of scopesToUpsert) {
        db.upsertScope(scopeRowFromFingerprint(scopeId, fingerprint, updatedAt))
      }
      for (const snapshot of snapshots) {
        db.writeMinute(
          minuteStatsRowFromSnapshot(snapshot),
          charRowsFromSnapshot(snapshot),
          matrixRowsFromSnapshot(snapshot),
          updatedAt,
        )
      }
      for (const { session, resolved } of validSessions) {
        db.insertSession(
          {
            id: session.id,
            scopeId: resolved.scopeKey,
            startMs: session.startMs,
            endMs: session.endMs,
          },
          updatedAt,
        )
      }
    })()
  } catch (err) {
    log('error', `typing-analytics batch persist failed: ${String(err)}`)
    // Transaction rolled back — re-queue sessions so the next pass can
    // retry. Snapshots are already drained and cannot be cheaply reinserted,
    // so they are accepted as lost (aggregate counts only).
    pendingSessions.push(...sessionsToWrite)
    dirty = true
    return
  }

  // Notify the sync layer that the typing-analytics unit for each touched
  // keyboard has new rows to upload. Derived from the committed snapshots
  // and sessions, so rollback never fires this. Capture the notifier into
  // a local so a reset-clear between iterations cannot null it mid-loop.
  const notifier = syncNotifier
  if (notifier) {
    const touchedUids = new Set<string>()
    for (const snapshot of snapshots) {
      touchedUids.add(snapshot.fingerprint.keyboard.uid)
    }
    for (const { resolved } of validSessions) {
      touchedUids.add(resolved.fingerprint.keyboard.uid)
    }
    for (const uid of touchedUids) {
      try {
        notifier(typingAnalyticsSyncUnit(uid))
      } catch (notifyErr) {
        log('warn', `typing-analytics sync notify failed for ${uid}: ${String(notifyErr)}`)
      }
    }
  }

  dirty = !minuteBuffer.isEmpty()
}

/**
 * Schedule a flush behind any in-flight one. Concurrent callers (the
 * debounce timer, the FLUSH IPC, the before-quit finalizer) all await the
 * same chain so quit-time persistence cannot race with an in-flight pass.
 * Tracks an in-flight counter so hasTypingAnalyticsPendingWork() reports
 * pending work even after a snapshot has cleared the live state.
 */
function flushNow(options: { final: boolean }): Promise<void> {
  inFlightFlushCount++
  const next = flushChain
    .catch(() => undefined)
    .then(() => doFlushPass(options))
    .finally(() => {
      inFlightFlushCount--
      if (dirty || pendingSessions.length > 0) {
        scheduleFlush()
      }
    })
  flushChain = next
  return next
}

// --- Test helpers ---

export function resetTypingAnalyticsForTests(): void {
  initialization = null
  ipcRegistered = false
  minuteBuffer.drainAll()
  sessionDetector.closeAll()
  scopeCache.clear()
  pendingSessions.length = 0
  dirty = false
  flushChain = Promise.resolve()
  inFlightFlushCount = 0
  syncNotifier = null
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

export function getMinuteBufferForTests(): MinuteBuffer {
  return minuteBuffer
}

export function flushTypingAnalyticsNowForTests(): Promise<void> {
  return flushNow({ final: true })
}
