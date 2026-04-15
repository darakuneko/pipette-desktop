// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics shared types — see .claude/plans/typing-analytics.md.

export const TYPING_ANALYTICS_REV = 1
export const TYPING_ANALYTICS_VERSION = 1

export const DEFAULT_TYPING_SYNC_SPAN_DAYS = 7
export const ALLOWED_TYPING_SYNC_SPAN_DAYS = [1, 7, 30, 90] as const
export type TypingSyncSpanDays = typeof ALLOWED_TYPING_SYNC_SPAN_DAYS[number]

/** Anonymized fingerprint that scopes counts by machine / OS / keyboard. */
export interface TypingAnalyticsFingerprint {
  machineHash: string
  os: {
    platform: string
    release: string
    arch: string
  }
  keyboard: {
    uid: string
    vendorId: number
    productId: number
    productName: string
  }
}

/** Keyboard identification carried on each event so the main process can
 * resolve the scope without tracking the active device separately. */
export interface TypingAnalyticsKeyboard {
  uid: string
  vendorId: number
  productId: number
  productName: string
}

/** Partial event emitted by `useTypingTest` before the active keyboard is
 * attached. `useInputModes` wraps it into a full {@link TypingAnalyticsEvent}
 * before dispatching to the main process. */
export type TypingAnalyticsEventPayload =
  | { kind: 'char'; key: string; ts: number }
  | { kind: 'matrix'; row: number; col: number; layer: number; keycode: number; ts: number }

/** Normalized analytics event carried over the IPC to the main process. */
export type TypingAnalyticsEvent = TypingAnalyticsEventPayload & {
  keyboard: TypingAnalyticsKeyboard
}

/** Build the canonical scope key from a fingerprint. Excludes productName
 * so that cross-OS descriptor variation doesn't fragment the same device. */
export function canonicalScopeKey(fp: TypingAnalyticsFingerprint): string {
  return [
    fp.machineHash,
    fp.os.platform,
    fp.os.release,
    fp.keyboard.uid,
    fp.keyboard.vendorId,
    fp.keyboard.productId,
  ].join('|')
}
