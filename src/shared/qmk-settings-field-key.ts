// SPDX-License-Identifier: GPL-2.0-or-later
// i18n keys for the field labels in the QMK settings modals. A field is
// identified by its qsid, plus its bit for the boolean rows that share one
// qsid, so the key stays stable when a title is reworded and two fields
// with the same title (e.g. "Permissive Hold" on qsid 8 bit 0 and qsid 22)
// still get separate keys. The segment fits the language pack key pattern
// `^[\w\-]+$` (src/shared/i18n/validate.ts).

export const QMK_SETTINGS_FIELD_NS = 'qmkSettingsField'

/** i18n key for a QMK settings field (`qmkSettingsField.q7`, `qmkSettingsField.q1_b0`). */
export function qmkSettingsFieldKey(field: { qsid: number; bit?: number }): string {
  const bit = field.bit === undefined ? '' : `_b${field.bit}`
  return `${QMK_SETTINGS_FIELD_NS}.q${field.qsid}${bit}`
}
