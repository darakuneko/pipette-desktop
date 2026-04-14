// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — orchestrates the in-memory aggregator, session
// detector, and on-disk persistence. See .claude/plans/typing-analytics.md.

import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingAnalyticsKeyboard,
  TypingScopeEntry,
} from '../../shared/types/typing-analytics'
import {
  DEFAULT_TYPING_SYNC_SPAN_DAYS,
  canonicalScopeKey,
} from '../../shared/types/typing-analytics'
import { log } from '../logger'
import { TypingAnalyticsAggregator } from './aggregator'
import { cleanupArchiveForKeyboard } from './archive-cleanup'
import { flushDailyFile } from './daily-file-store'
import { buildFingerprint } from './fingerprint'
import { getInstallationId } from './installation-id'
import { SessionDetector, type FinalizedSession } from './session-detector'
import { appendSessionRecord } from './sessions-file-store'

const FLUSH_DEBOUNCE_MS = 1_000

let initialization: Promise<void> | null = null
let ipcRegistered = false

interface ResolvedScope {
  fingerprint: TypingAnalyticsFingerprint
  scopeKey: string
}

const aggregator = new TypingAnalyticsAggregator()
const sessionDetector = new SessionDetector()
const scopeCache = new Map<string, ResolvedScope>()
const cleanedUids = new Set<string>()
const pendingSessions: FinalizedSession[] = []

let dirty = false
let flushChain: Promise<void> = Promise.resolve()
let inFlightFlushCount = 0
let lastFlushDate: string | null = null
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
      await flushNow()
    },
  )
}

/**
 * True when there is unsaved analytics state — either live (aggregator,
 * queued session records, active sessions) or work currently in flight on
 * the flush chain. Both must be visible so the before-quit finalizer waits
 * even when a flush snapshot has already cleared the live state.
 */
export function hasTypingAnalyticsPendingWork(): boolean {
  return (
    dirty ||
    pendingSessions.length > 0 ||
    !aggregator.isEmpty() ||
    sessionDetector.hasAnyActiveSession() ||
    inFlightFlushCount > 0
  )
}

/**
 * Drain everything for a clean shutdown. Closes any active sessions,
 * persists the daily aggregate, and writes any queued session records.
 * Safe to call when there is nothing pending — it is a no-op then.
 */
export async function flushTypingAnalyticsBeforeQuit(): Promise<void> {
  pendingSessions.push(...sessionDetector.closeAll())
  await flushNow()
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
  aggregator.addEvent(event, fingerprint)
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
    void flushNow()
  }, FLUSH_DEBOUNCE_MS)
}

function todayDate(): string {
  // UTC YYYY-MM-DD — kept in sync with archive-cleanup's cutoff so day
  // rollover detection and archive boundaries agree.
  return new Date().toISOString().slice(0, 10)
}

function groupScopesByUid(
  scopes: ReadonlyMap<string, TypingScopeEntry>,
): Map<string, Record<string, TypingScopeEntry>> {
  const byUid = new Map<string, Record<string, TypingScopeEntry>>()
  for (const [key, entry] of scopes) {
    const uid = entry.scope.keyboard.uid
    const bucket = byUid.get(uid) ?? {}
    bucket[key] = entry
    byUid.set(uid, bucket)
  }
  return byUid
}

async function resolveSyncSpanDays(uid: string): Promise<number> {
  try {
    // Dynamic import keeps this module independent from pipette-settings-store
    // at module-load time (avoids the sync-service ↔ pipette-settings circle).
    const { readPipetteSettings } = await import('../pipette-settings-store')
    const prefs = await readPipetteSettings(uid)
    return prefs?.typingSyncSpanDays ?? DEFAULT_TYPING_SYNC_SPAN_DAYS
  } catch {
    return DEFAULT_TYPING_SYNC_SPAN_DAYS
  }
}

/**
 * Run a single flush pass: snapshot the live aggregator + session queue,
 * persist them, and then handle archive cleanup. Snapshotting up front means
 * events arriving during the async writes accumulate into a fresh aggregator
 * instead of being thrown away by the trailing clear.
 */
async function doFlushPass(): Promise<void> {
  if (!dirty && pendingSessions.length === 0) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  // Atomic snapshot: copy out current state and drop the live state so any
  // events arriving during the async writes go into a fresh bucket.
  const grouped = groupScopesByUid(aggregator.getScopes())
  aggregator.clear()
  const sessionsToWrite = pendingSessions.splice(0)
  dirty = false

  const today = todayDate()
  let dailyOk = true
  for (const [uid, scopes] of grouped) {
    try {
      await flushDailyFile(uid, today, scopes)
    } catch (err) {
      dailyOk = false
      log('error', `typing-analytics daily flush failed for ${uid}: ${String(err)}`)
    }
  }

  // Drain finalized sessions; failures stay in the queue for the next pass.
  const remainingSessions: FinalizedSession[] = []
  for (const next of sessionsToWrite) {
    try {
      await appendSessionRecord(next.uid, next.record)
    } catch (err) {
      log('error', `typing-analytics session append failed for ${next.uid}: ${String(err)}`)
      remainingSessions.push(next)
    }
  }
  if (remainingSessions.length > 0) pendingSessions.push(...remainingSessions)

  // Lazy archive cleanup: run once per uid the first time it surfaces, plus
  // every known uid on day rollover so files get archived even when the user
  // keeps recording past midnight.
  const newUids: string[] = []
  for (const uid of grouped.keys()) {
    if (!cleanedUids.has(uid)) {
      cleanedUids.add(uid)
      newUids.push(uid)
    }
  }
  const rolloverUids = lastFlushDate && lastFlushDate !== today
    ? Array.from(cleanedUids)
    : newUids
  await Promise.all(
    rolloverUids.map(async (uid) => {
      try {
        const syncSpanDays = await resolveSyncSpanDays(uid)
        await cleanupArchiveForKeyboard(uid, { today, syncSpanDays })
      } catch (err) {
        log('error', `typing-analytics archive cleanup failed for ${uid}: ${String(err)}`)
      }
    }),
  )
  lastFlushDate = today

  if (!dailyOk || remainingSessions.length > 0) {
    dirty = true
  }
}

/**
 * Schedule a flush behind any in-flight one. Concurrent callers (the
 * debounce timer, the FLUSH IPC, the before-quit finalizer) all await the
 * same chain so quit-time persistence cannot race with an in-flight pass.
 * Tracks an in-flight counter so hasTypingAnalyticsPendingWork() reports
 * pending work even after a snapshot has cleared the live state.
 */
function flushNow(): Promise<void> {
  inFlightFlushCount++
  flushChain = flushChain
    .catch(() => undefined)
    .then(doFlushPass)
    .finally(() => {
      inFlightFlushCount--
      if (dirty || pendingSessions.length > 0) {
        scheduleFlush()
      }
    })
  return flushChain
}

// --- Test helpers ---

export function resetTypingAnalyticsForTests(): void {
  initialization = null
  ipcRegistered = false
  aggregator.clear()
  sessionDetector.closeAll()
  scopeCache.clear()
  cleanedUids.clear()
  pendingSessions.length = 0
  dirty = false
  flushChain = Promise.resolve()
  inFlightFlushCount = 0
  lastFlushDate = null
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

export function getTypingAnalyticsAggregatorForTests(): TypingAnalyticsAggregator {
  return aggregator
}

export function flushTypingAnalyticsNowForTests(): Promise<void> {
  return flushNow()
}
