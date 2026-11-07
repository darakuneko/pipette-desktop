// SPDX-License-Identifier: GPL-2.0-or-later
// i18n keys for keycode tooltips. Language pack keys must match the
// segment pattern `^[\w\-]+$` (src/shared/i18n/validate.ts, shared with
// the Hub upload check), so a qmkId such as `OSM(MOD_LCTL|MOD_LSFT)` or
// `LSFT_T(kc)` cannot be used as a key segment verbatim. Imports nothing
// so keycodes.ts can use it without a cycle.

export const KEYCODE_TOOLTIP_NS = 'keycodeTooltip'

/** Map a qmkId to a valid key segment: each run of non-word characters
 *  becomes `_`, and trailing `_` is dropped (`LSFT_T(kc)` -> `LSFT_T_kc`). */
export function sanitizeQmkIdForKey(qmkId: string): string {
  return qmkId.replace(/\W+/g, '_').replace(/_+$/, '')
}

/** i18n key for a keycode's fixed tooltip text (`keycodeTooltip.KC_A`). */
export function keycodeTooltipKey(qmkId: string): string {
  return `${KEYCODE_TOOLTIP_NS}.${sanitizeQmkIdForKey(qmkId)}`
}
