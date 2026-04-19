// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — orchestrates the per-minute in-memory buffer,
// session detector, and SQLite persistence. See
// .claude/plans/typing-analytics.md for the design rationale.

import { app } from 'electron'
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
import { ensureCacheIsFresh } from './cache-rebuild'
import { buildFingerprint } from './fingerprint'
import {
  MinuteBuffer,
  MINUTE_MS,
  type MinuteSnapshot,
} from './minute-buffer'
import { SessionDetector, type FinalizedSession } from './session-detector'
import {
  getTypingAnalyticsDB,
  type TypingDailySummary,
  type TypingKeyboardSummary,
  type TypingTombstoneResult,
} from './db/typing-analytics-db'
import { typingAnalyticsDeviceSyncUnit } from './sync'
import { getMachineHash } from './machine-hash'
import { applyRowsToCache } from './jsonl/apply-to-cache'
import {
  charMinuteRowId,
  matrixMinuteRowId,
  minuteStatsRowId,
  scopeRowId,
  sessionRowId,
  type JsonlRow,
} from './jsonl/jsonl-row'
import { appendRowsToFile } from './jsonl/jsonl-writer'
import { deviceDayJsonlPath, deviceJsonlPath, readPointerKey } from './jsonl/paths'
import { utcDayFromMs, type UtcDay } from './jsonl/utc-day'
import {
  emptySyncState,
  saveSyncState,
  type TypingSyncState,
} from './sync-state'

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
let syncState: TypingSyncState | null = null

async function initialize(): Promise<void> {
  // getMachineHash transitively warms getInstallationId (and caches its
  // own hash), so later sync notifications can `await` without triggering
  // fresh I/O.
  const machineHash = await getMachineHash()
  const db = getTypingAnalyticsDB()
  const userDataDir = app.getPath('userData')
  const { state } = await ensureCacheIsFresh(db, userDataDir, machineHash)
  syncState = state
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

const FULL_RANGE: { startMs: number; endMs: number } = {
  startMs: Number.MIN_SAFE_INTEGER,
  endMs: Number.MAX_SAFE_INTEGER,
}

/** Collect live rows for the local machine's scopes of `uid` within each
 * given range and produce tombstone JSONL rows that mark them deleted
 * (`is_deleted: true`, `updated_at: now`). Composite ids match the
 * original live rows so `applyRowsToCache` can flip `is_deleted` via the
 * LWW merge path. Only our own machineHash is touched — remote devices'
 * data stays intact (their machine is responsible for deleting it). */
async function tombstoneOwnScopeRows(
  uid: string,
  ranges: readonly { startMs: number; endMs: number }[],
  updatedAt: number,
): Promise<{ rows: JsonlRow[]; result: TypingTombstoneResult }> {
  const result: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
  const rows: JsonlRow[] = []
  const machineHash = await getMachineHash()
  const db = getTypingAnalyticsDB()
  const scopeIds = db.listOwnScopeIdsForUid(machineHash, uid)
  if (scopeIds.length === 0) return { rows, result }

  for (const scopeId of scopeIds) {
    for (const range of ranges) {
      for (const c of db.listLiveCharMinutesForScope(scopeId, range.startMs, range.endMs)) {
        rows.push({
          id: charMinuteRowId(c.scopeId, c.minuteTs, c.char),
          kind: 'char-minute',
          updated_at: updatedAt,
          is_deleted: true,
          payload: c,
        })
        result.charMinutes += 1
      }
      for (const m of db.listLiveMatrixMinutesForScope(scopeId, range.startMs, range.endMs)) {
        rows.push({
          id: matrixMinuteRowId(m.scopeId, m.minuteTs, m.row, m.col, m.layer),
          kind: 'matrix-minute',
          updated_at: updatedAt,
          is_deleted: true,
          payload: {
            scopeId: m.scopeId,
            minuteTs: m.minuteTs,
            row: m.row,
            col: m.col,
            layer: m.layer,
            keycode: m.keycode,
            count: m.count,
            tapCount: m.tapCount ?? 0,
            holdCount: m.holdCount ?? 0,
          },
        })
        result.matrixMinutes += 1
      }
      for (const s of db.listLiveMinuteStatsForScope(scopeId, range.startMs, range.endMs)) {
        rows.push({
          id: minuteStatsRowId(s.scopeId, s.minuteTs),
          kind: 'minute-stats',
          updated_at: updatedAt,
          is_deleted: true,
          payload: s,
        })
        result.minuteStats += 1
      }
      for (const ss of db.listLiveSessionsForScope(scopeId, range.startMs, range.endMs)) {
        rows.push({
          id: sessionRowId(ss.id),
          kind: 'session',
          updated_at: updatedAt,
          is_deleted: true,
          payload: ss,
        })
        result.sessions += 1
      }
    }
  }
  return { rows, result }
}

/** Append rows to a JSONL master file, apply them to the cache, and
 * advance the sync-state pointer for (uid, machineHash) to the last row
 * id in this batch. Does NOT save the sync state — callers batch the
 * write so multi-uid flushes hit disk once. */
async function persistOwnJsonlAt(
  path: string,
  uid: string,
  rows: readonly JsonlRow[],
  machineHash: string,
  state: TypingSyncState,
): Promise<void> {
  await appendRowsToFile(path, rows)
  applyRowsToCache(getTypingAnalyticsDB(), rows)
  const lastId = rows[rows.length - 1]?.id
  if (lastId) state.read_pointers[readPointerKey(uid, machineHash)] = lastId
}

/** v6 flat layout, retained for the tombstone write path until
 * row-level tombstones are removed. */
function persistOwnJsonlRows(
  uid: string,
  rows: readonly JsonlRow[],
  machineHash: string,
  userDataDir: string,
  state: TypingSyncState,
): Promise<void> {
  return persistOwnJsonlAt(deviceJsonlPath(userDataDir, uid, machineHash), uid, rows, machineHash, state)
}

/** v7 per-day layout. Multiple days within a single flush must be
 * persisted in ascending chronological order so the pointer lands on
 * the most recent row. */
function persistOwnJsonlDay(
  uid: string,
  utcDay: UtcDay,
  rows: readonly JsonlRow[],
  machineHash: string,
  userDataDir: string,
  state: TypingSyncState,
): Promise<void> {
  return persistOwnJsonlAt(
    deviceDayJsonlPath(userDataDir, uid, machineHash, utcDay),
    uid,
    rows,
    machineHash,
    state,
  )
}

/** Persist tombstone rows for one uid and sync the sync-state to disk. */
async function flushTombstoneRows(
  uid: string,
  rows: readonly JsonlRow[],
  updatedAt: number,
): Promise<void> {
  if (rows.length === 0) return
  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  const state = syncState ?? emptySyncState(machineHash)
  syncState = state
  await persistOwnJsonlRows(uid, rows, machineHash, userDataDir, state)
  state.last_synced_at = updatedAt
  await saveSyncState(userDataDir, state)
}

/** Tombstone the live rows for a set of local-calendar dates. Live
 * analytics state is flushed first so any in-memory events land in the
 * cache before the tombstone ids are computed. Tombstones cover only
 * the local machine's scope — other devices delete their own copies. */
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
  if (ranges.length === 0) {
    return { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
  }
  const updatedAt = Date.now()
  const { rows, result } = await tombstoneOwnScopeRows(uid, ranges, updatedAt)
  await flushTombstoneRows(uid, rows, updatedAt)
  await notifySyncIfTouched(uid, result)
  return result
}

/** Tombstone every live row for a keyboard uid on this machine. */
export async function deleteAllTypingForKeyboard(uid: string): Promise<TypingTombstoneResult> {
  await flushNow({ final: true })
  const updatedAt = Date.now()
  const { rows, result } = await tombstoneOwnScopeRows(uid, [FULL_RANGE], updatedAt)
  await flushTombstoneRows(uid, rows, updatedAt)
  await notifySyncIfTouched(uid, result)
  return result
}

async function notifySyncIfTouched(uid: string, result: TypingTombstoneResult): Promise<void> {
  const touched = result.charMinutes + result.matrixMinutes + result.minuteStats + result.sessions
  if (touched === 0) return
  const notifier = syncNotifier
  if (!notifier) return
  try {
    const machineHash = await getMachineHash()
    notifier(typingAnalyticsDeviceSyncUnit(uid, machineHash))
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

function buildScopeRow(
  scopeKey: string,
  fingerprint: TypingAnalyticsFingerprint,
  updatedAt: number,
): JsonlRow {
  return {
    id: scopeRowId(scopeKey),
    kind: 'scope',
    updated_at: updatedAt,
    payload: {
      id: scopeKey,
      machineHash: fingerprint.machineHash,
      osPlatform: fingerprint.os.platform,
      osRelease: fingerprint.os.release,
      osArch: fingerprint.os.arch,
      keyboardUid: fingerprint.keyboard.uid,
      keyboardVendorId: fingerprint.keyboard.vendorId,
      keyboardProductId: fingerprint.keyboard.productId,
      keyboardProductName: fingerprint.keyboard.productName,
    },
  }
}

function buildSnapshotRows(snapshot: MinuteSnapshot, updatedAt: number): JsonlRow[] {
  const rows: JsonlRow[] = [
    {
      id: minuteStatsRowId(snapshot.scopeId, snapshot.minuteTs),
      kind: 'minute-stats',
      updated_at: updatedAt,
      payload: {
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
      },
    },
  ]
  for (const [char, count] of snapshot.charCounts) {
    rows.push({
      id: charMinuteRowId(snapshot.scopeId, snapshot.minuteTs, char),
      kind: 'char-minute',
      updated_at: updatedAt,
      payload: { scopeId: snapshot.scopeId, minuteTs: snapshot.minuteTs, char, count },
    })
  }
  for (const cell of snapshot.matrixCounts.values()) {
    rows.push({
      id: matrixMinuteRowId(snapshot.scopeId, snapshot.minuteTs, cell.row, cell.col, cell.layer),
      kind: 'matrix-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        row: cell.row,
        col: cell.col,
        layer: cell.layer,
        keycode: cell.keycode,
        count: cell.count,
        tapCount: cell.tapCount,
        holdCount: cell.holdCount,
      },
    })
  }
  return rows
}

function buildSessionRow(
  session: FinalizedSession,
  resolved: ResolvedScope,
  updatedAt: number,
): JsonlRow {
  return {
    id: sessionRowId(session.id),
    kind: 'session',
    updated_at: updatedAt,
    payload: {
      id: session.id,
      scopeId: resolved.scopeKey,
      startMs: session.startMs,
      endMs: session.endMs,
    },
  }
}

/** Partition the flush's rows into per-(uid, UTC-day) buckets.
 *
 * The UTC day is derived from the row's native timestamp:
 *   - snapshot rows (minute-stats / char-minute / matrix-minute) use
 *     `minuteTs` so every row in the same minute bucket lands on the
 *     same day regardless of how long the flush takes to run.
 *   - session rows use `startMs`; a session that spans 00:00 UTC is
 *     kept whole on the start day (no splitting).
 *   - scope rows don't carry a timestamp, so they're replicated into
 *     every day that references the scope in this flush. The LWW merge
 *     makes the duplicates idempotent on the cache side. */
function groupRowsByUidDay(
  scopesToUpsert: Map<string, TypingAnalyticsFingerprint>,
  snapshots: MinuteSnapshot[],
  sessionsWithScope: Array<{ session: FinalizedSession; resolved: ResolvedScope }>,
  updatedAt: number,
): Map<string, Map<UtcDay, JsonlRow[]>> {
  const rowsByUidDay = new Map<string, Map<UtcDay, JsonlRow[]>>()
  const scopeDays = new Map<string, Set<UtcDay>>()
  const scopeDayKey = (uid: string, scopeId: string): string => `${uid}\0${scopeId}`

  const addRow = (uid: string, day: UtcDay, row: JsonlRow): void => {
    let byDay = rowsByUidDay.get(uid)
    if (!byDay) {
      byDay = new Map<UtcDay, JsonlRow[]>()
      rowsByUidDay.set(uid, byDay)
    }
    const list = byDay.get(day)
    if (list) list.push(row)
    else byDay.set(day, [row])
  }

  const recordScopeDay = (uid: string, scopeId: string, day: UtcDay): void => {
    const key = scopeDayKey(uid, scopeId)
    const set = scopeDays.get(key)
    if (set) set.add(day)
    else scopeDays.set(key, new Set([day]))
  }

  for (const snapshot of snapshots) {
    const uid = snapshot.fingerprint.keyboard.uid
    const day = utcDayFromMs(snapshot.minuteTs)
    recordScopeDay(uid, snapshot.scopeId, day)
    for (const row of buildSnapshotRows(snapshot, updatedAt)) {
      addRow(uid, day, row)
    }
  }
  for (const { session, resolved } of sessionsWithScope) {
    const uid = resolved.fingerprint.keyboard.uid
    const day = utcDayFromMs(session.startMs)
    recordScopeDay(uid, resolved.scopeKey, day)
    addRow(uid, day, buildSessionRow(session, resolved, updatedAt))
  }
  for (const [scopeId, fingerprint] of scopesToUpsert) {
    const uid = fingerprint.keyboard.uid
    const days = scopeDays.get(scopeDayKey(uid, scopeId))
    if (!days) continue
    const scopeRow = buildScopeRow(scopeId, fingerprint, updatedAt)
    for (const day of days) addRow(uid, day, scopeRow)
  }
  return rowsByUidDay
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
  if (!dirty && pendingSessions.length === 0) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
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
  const rowsByUidDay = groupRowsByUidDay(scopesToUpsert, snapshots, validSessions, updatedAt)
  if (rowsByUidDay.size === 0) {
    dirty = !minuteBuffer.isEmpty()
    return
  }

  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  const state = syncState ?? emptySyncState(machineHash)
  syncState = state

  const touchedUids: string[] = []
  try {
    // JSONL master write happens first: the file is the source of truth.
    // If the cache apply later fails we still have the data on disk, and
    // the next startup rebuild replays it. Days are written in ascending
    // order so the pointer lands on the most recent row id.
    for (const [uid, byDay] of rowsByUidDay) {
      const orderedDays = Array.from(byDay.keys()).sort()
      let wroteAny = false
      for (const day of orderedDays) {
        const rows = byDay.get(day)
        if (!rows || rows.length === 0) continue
        // Transitional mirror: write the v6 flat file first so the
        // existing sync bundle / merge paths (still reading
        // `{hash}.jsonl`) pick up fresh rows. If this fails we throw
        // before touching the v7 per-day path or the cache, so the
        // outer catch requeues sessions and the batch is atomically
        // lost (same failure mode the service already tolerates).
        // Dropped when sync switches to per-day enumeration.
        await appendRowsToFile(
          deviceJsonlPath(userDataDir, uid, machineHash),
          rows,
        )
        await persistOwnJsonlDay(uid, day, rows, machineHash, userDataDir, state)
        wroteAny = true
      }
      if (wroteAny) touchedUids.push(uid)
    }
    state.last_synced_at = updatedAt
    await saveSyncState(userDataDir, state)
  } catch (err) {
    log('error', `typing-analytics flush failed: ${String(err)}`)
    // Re-queue sessions so the next pass can retry. Snapshots are already
    // drained and cannot be cheaply reinserted, so their counts are
    // accepted as lost (the JSONL append for the failed uid may or may
    // not have landed; an eventual cache rebuild reconciles).
    pendingSessions.push(...sessionsToWrite)
    dirty = true
    return
  }

  // Notify the sync layer that this device's JSONL for each touched
  // keyboard has new rows to upload. Capture the notifier into a local so
  // a reset-clear between iterations cannot null it mid-loop.
  const notifier = syncNotifier
  if (notifier) {
    for (const uid of touchedUids) {
      try {
        notifier(typingAnalyticsDeviceSyncUnit(uid, machineHash))
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
  syncState = null
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
