// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — orchestrates the scope-map aggregator, ingests
// IPC events, and will hand off to persistence / rotate / archive once later
// slices land. See .claude/plans/typing-analytics.md.

import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingAnalyticsKeyboard,
} from '../../shared/types/typing-analytics'
import { buildFingerprint } from './fingerprint'
import { getInstallationId } from './installation-id'
import { TypingAnalyticsAggregator } from './aggregator'

let initialization: Promise<void> | null = null
let ipcRegistered = false

const aggregator = new TypingAnalyticsAggregator()
const fingerprintCache = new Map<string, TypingAnalyticsFingerprint>()

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

async function resolveFingerprint(keyboard: TypingAnalyticsKeyboard): Promise<TypingAnalyticsFingerprint> {
  const cached = fingerprintCache.get(keyboard.uid)
  if (cached) return cached
  const fp = await buildFingerprint(keyboard)
  fingerprintCache.set(keyboard.uid, fp)
  return fp
}

async function ingestEvent(event: TypingAnalyticsEvent): Promise<void> {
  const fingerprint = await resolveFingerprint(event.keyboard)
  aggregator.addEvent(event, fingerprint)
}

// --- Test helpers ---

export function resetTypingAnalyticsForTests(): void {
  initialization = null
  ipcRegistered = false
  aggregator.clear()
  fingerprintCache.clear()
}

export function getTypingAnalyticsAggregatorForTests(): TypingAnalyticsAggregator {
  return aggregator
}
