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

/** How a physical press resolved for masked (tap-hold style) keys. The
 * heatmap uses this to colour the outer (hold) and inner (tap) rects
 * independently. `undefined` is reserved for non-masked keys and for
 * release-edge data that the press-edge pipeline dispatches eagerly.*/
export type TypingMatrixAction = 'tap' | 'hold'

/** Partial event emitted by `useTypingTest` before the active keyboard is
 * attached. `useInputModes` wraps it into a full {@link TypingAnalyticsEvent}
 * before dispatching to the main process. */
export type TypingAnalyticsEventPayload =
  | { kind: 'char'; key: string; ts: number }
  | {
      kind: 'matrix'
      row: number
      col: number
      layer: number
      keycode: number
      ts: number
      /** Only set for masked keys (LT/MT/etc.) after the release edge
       * has been classified against TAPPING_TERM. Non-masked presses
       * and presses that have not yet seen a release leave this
       * undefined; the count still lands in the `count` total column. */
      action?: TypingMatrixAction
    }

/** Normalized analytics event carried over the IPC to the main process. */
export type TypingAnalyticsEvent = TypingAnalyticsEventPayload & {
  keyboard: TypingAnalyticsKeyboard
}

/** Summary of a keyboard that currently has typing analytics data
 * visible locally. Produced by the data-modal list API. */
export interface TypingKeyboardSummary {
  uid: string
  productName: string
  vendorId: number
  productId: number
}

/** Day-level aggregation of typing analytics data for a single keyboard,
 * summed across every scope (machine) sharing the uid. */
export interface TypingDailySummary {
  date: string
  keystrokes: number
  activeMs: number
}

/** One cell of the typing-view heatmap. `total` is the overall press
 * count for the cell; `tap` and `hold` are the portions of that total
 * that the release-edge classifier routed to the tap vs hold arm of
 * an LT/MT key. Non-tap-hold presses leave both at 0 and consumers
 * fall back to `total` as a single intensity. */
export interface TypingHeatmapCell {
  total: number
  tap: number
  hold: number
}

/** Wire format for the heatmap IPC. Keyed by `"row,col"` so the
 * renderer can plug it straight into KeyWidget without reshaping. */
export type TypingHeatmapByCell = Record<string, TypingHeatmapCell>

/** Row counts returned from a tombstone / delete-all call. The renderer
 * uses the total to decide whether to surface a "no rows changed" notice. */
export interface TypingTombstoneResult {
  charMinutes: number
  matrixMinutes: number
  minuteStats: number
  sessions: number
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
