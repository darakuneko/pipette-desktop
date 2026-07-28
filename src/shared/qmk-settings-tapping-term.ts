// SPDX-License-Identifier: GPL-2.0-or-later
// Read the QMK TAPPING_TERM setting (QSID 7) out of the keyboard's cached
// qmkSettingsValues blob. Falls back to 200 ms — QMK's default and the
// value used by typing tests before we had the configurator — whenever
// the keyboard didn't expose the setting or the payload is malformed.

/** QSID for TAPPING_TERM in QMK settings (see qmk-settings-defs.json). */
export const QSID_TAPPING_TERM = 7

/** QMK's own default when TAPPING_TERM is not configured. */
export const DEFAULT_TAPPING_TERM_MS = 200

/** Resolve TAPPING_TERM (ms) from the keyboard's cached QMK settings.
 * Pass the `qmkSettingsValues` record produced by useKeyboardReload (or
 * `undefined` for keyboards without QMK settings support). */
export function resolveTappingTermMs(
  qmkSettingsValues: Record<string, number[]> | undefined,
): number {
  if (!qmkSettingsValues) return DEFAULT_TAPPING_TERM_MS
  const bytes = qmkSettingsValues[String(QSID_TAPPING_TERM)]
  if (!bytes || bytes.length < 2) return DEFAULT_TAPPING_TERM_MS
  // QMK settings are little-endian; TAPPING_TERM is width=2.
  const value = (bytes[0] | (bytes[1] << 8)) & 0xFFFF
  // A zero is technically legal in QMK but reduces to "tap never succeeds",
  // which would flag every press as a hold. Treat it as "not configured".
  return value > 0 ? value : DEFAULT_TAPPING_TERM_MS
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
