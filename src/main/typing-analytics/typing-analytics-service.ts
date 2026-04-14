// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — PR2 Slice 2b introduces an in-memory ring buffer
// that collects events emitted by the renderer. Persistence, rotation, archive,
// and machine fingerprinting land in Slice 2c as described in
// .claude/plans/typing-analytics.md.

import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type { TypingAnalyticsEvent } from '../../shared/types/typing-analytics'
import { getInstallationId } from './installation-id'

const BUFFER_CAPACITY = 50000

let initialization: Promise<void> | null = null
let ipcRegistered = false

const buffer: TypingAnalyticsEvent[] = []

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
      pushEvent(payload)
    },
  )
}

function isValidKeyboard(value: unknown): value is TypingAnalyticsEvent['keyboard'] {
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

function pushEvent(event: TypingAnalyticsEvent): void {
  if (buffer.length >= BUFFER_CAPACITY) {
    buffer.shift()
  }
  buffer.push(event)
}

// --- Test helpers ---

export function resetTypingAnalyticsForTests(): void {
  initialization = null
  ipcRegistered = false
  buffer.length = 0
}

export function getTypingAnalyticsBufferForTests(): TypingAnalyticsEvent[] {
  return [...buffer]
}
