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
  type TypingScopeRow,
} from './db/typing-analytics-db'

const FLUSH_DEBOUNCE_MS = 1_000

let initialization: Promise<void> | null = null
let ipcRegistered = false

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
  for (const { row, col, layer, keycode, count } of snapshot.matrixCounts.values()) {
    rows.push({
      scopeId: snapshot.scopeId,
      minuteTs: snapshot.minuteTs,
      row,
      col,
      layer,
      keycode,
      count,
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
