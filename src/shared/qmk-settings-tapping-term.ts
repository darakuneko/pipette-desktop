// SPDX-License-Identifier: GPL-2.0-or-later
// Read the QMK TAPPING_TERM setting (QSID 7) out of the keyboard's cached
// qmkSettingsValues blob. Falls back to 200 ms — QMK's default and the
// value used by typing tests before we had the configurator — whenever
// the keyboard didn't expose the setting or the payload is malformed.

import { EMPTY_UID } from './constants/protocol'

/** QSID for TAPPING_TERM in QMK settings (see qmk-settings-defs.json). */
export const QSID_TAPPING_TERM = 7

/** QMK's own default when TAPPING_TERM is not configured. */
export const DEFAULT_TAPPING_TERM_MS = 200

export interface ResolvedTappingTerm {
  termMs: number
  /** Whether the keyboard's own QMK settings payload actually supplied
   * this value — false whenever `termMs` fell back to the QMK default,
   * for any reason (key absent, malformed payload, or a legal-but-
   * unusable zero). A caller that needs to tell a keyboard's own 200ms
   * apart from an assumed 200ms default reads this, not just `termMs`. */
  reported: boolean
}

/** Resolve TAPPING_TERM from the keyboard's cached QMK settings. Pass
 * the `qmkSettingsValues` record produced by useKeyboardReload (or
 * `undefined` for keyboards without QMK settings support). `reported`
 * uses the exact same validity rule `termMs` falls back under — a
 * malformed or zero payload is `reported: false`, matching the value
 * it produces (the QMK default), not just "was the key present". */
export function resolveTappingTerm(
  qmkSettingsValues: Record<string, number[]> | undefined,
): ResolvedTappingTerm {
  const bytes = qmkSettingsValues?.[String(QSID_TAPPING_TERM)]
  if (!bytes || bytes.length < 2) return { termMs: DEFAULT_TAPPING_TERM_MS, reported: false }
  // QMK settings are little-endian; TAPPING_TERM is width=2.
  const value = (bytes[0] | (bytes[1] << 8)) & 0xFFFF
  // A zero is technically legal in QMK but reduces to "tap never succeeds",
  // which would flag every press as a hold. Treat it as "not configured".
  if (value <= 0) return { termMs: DEFAULT_TAPPING_TERM_MS, reported: false }
  return { termMs: value, reported: true }
}

/** Thin wrapper over `resolveTappingTerm` for callers that only need
 * the millisecond value. */
export function resolveTappingTermMs(
  qmkSettingsValues: Record<string, number[]> | undefined,
): number {
  return resolveTappingTerm(qmkSettingsValues).termMs
}

/** `resolveTappingTerm`'s result plus which keyboard it belongs to —
 * threaded from App.tsx down through AnalyzePage / TypingAnalyticsView
 * / AnalyzePane to TappingTermCard, which only shows a diagnosis when
 * `uid` matches the pane's own selected keyboard. Re-exported from
 * `analyze-types.ts` for renderer call sites. */
export interface ConnectedTappingTerm extends ResolvedTappingTerm {
  uid: string
}

/** Gates `{uid, ...tappingTerm}` behind an actual LIVE connection,
 * returning `null` whenever there's nothing trustworthy to diagnose
 * against:
 *
 * - `hasConnectedDevice` false — no keyboard is physically connected
 *   right now. `keyboard.uid` alone can't stand in for this: it lags
 *   behind an auto-disconnect (unplug), so it can still read as a real
 *   uid for a keyboard that's no longer there. App.tsx passes
 *   `!!device.connectedDevice` (see useDeviceConnection's
 *   `handleDisconnect` / `disconnectDevice`, both of which null it
 *   synchronously on disconnect).
 * - `isPipetteFile` true — a `.pipette` file loaded for viewing, not a
 *   live device. Its `qmkSettingsValues` reflect whatever the file
 *   says, not necessarily what's actually flashed to real firmware, so
 *   the honest answer is the guidance state, not a diagnosis against
 *   an unverifiable value.
 * - `uid` missing or still `EMPTY_UID` — keyboard not loaded yet. */
export function resolveConnectedTappingTerm(
  hasConnectedDevice: boolean,
  isPipetteFile: boolean,
  uid: string | undefined,
  tappingTerm: ResolvedTappingTerm,
): ConnectedTappingTerm | null {
  if (!hasConnectedDevice || isPipetteFile) return null
  if (!uid || uid === EMPTY_UID) return null
  return { uid, ...tappingTerm }
}

/** Hard ceiling (ms) on how long the renderer's typing-analytics queue
 * (`matrix-analytics-queue.ts`) may defer classifying an LT/MT press as
 * tap vs hold. TAPPING_TERM is read off the keyboard as a raw u16 (up to
 * 65535), and nothing in the protocol stops a keyboard from reporting a
 * value far larger than any sane typing cadence — but the analytics
 * pipeline needs a *fixed* upper bound on how late a deferred press can
 * arrive, not one that tracks whatever the keyboard happens to report.
 * A press still unresolved this many ms after being pressed always
 * settles as `hold`, even when the configured TAPPING_TERM is larger.
 *
 * Trade-off, deliberately accepted: with TAPPING_TERM configured above
 * this cap, a genuine tap held past the cap is misclassified as a hold.
 * That only breaks the n-gram chain at that one key — a hold is dropped
 * from bigram/trigram pairing but never fabricates a pair that wasn't
 * actually typed (see `MinuteBuffer.recordNgramChain`). The alternative
 * — sizing the defer window to the live TAPPING_TERM instead of capping
 * it — would let a single slow config defer a press long enough to land
 * after its minute was already flushed, silently overwriting that
 * minute's recorded totals instead of losing one keystroke's chain
 * position (see `DRAIN_CLOSE_GRACE_MS` in `minute-buffer.ts`). A
 * TAPPING_TERM this large is already well past the point where tap-hold
 * behaves like ordinary typing, so the misclassification this trades
 * for is the cheaper failure mode. */
export const MAX_TAP_HOLD_DEFER_MS = 1000
