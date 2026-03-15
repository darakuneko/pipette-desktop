// SPDX-License-Identifier: GPL-2.0-or-later

import type { QmkSettingsTab } from './types/protocol'
import settingsDefs from './qmk-settings-defs.json'

const tabs = (settingsDefs as { tabs: QmkSettingsTab[] }).tabs

/** Width (in bytes) for each known QSID, derived from qmk-settings-defs.json */
const qsidWidthMap = new Map<number, number>()
for (const tab of tabs) {
  for (const field of tab.fields) {
    // Multiple fields may share a QSID (e.g. boolean bit-fields).
    // They all share the same width, so first-write wins.
    if (!qsidWidthMap.has(field.qsid)) {
      qsidWidthMap.set(field.qsid, field.width ?? 1)
    }
  }
}

/** Maximum byte width for any QMK setting (defensive upper bound) */
export const MAX_SETTING_WIDTH = 4

/**
 * Trim a raw HID response (up to 31 bytes) to the declared width for the QSID.
 *
 * qmkSettingsGet() returns the full HID payload (31 bytes after status byte).
 * Only the first `width` bytes carry the setting value; the rest are padding.
 * The Python reference (vial-gui) performs the same trim via
 * `data[0:fields[0]["width"]]` in QmkSettings.qsid_deserialize().
 */
export function normalizeQmkSettingData(qsid: number, data: number[]): number[] {
  const width = qsidWidthMap.get(qsid) ?? MAX_SETTING_WIDTH
  return data.slice(0, width)
}
