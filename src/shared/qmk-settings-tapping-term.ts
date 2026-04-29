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
