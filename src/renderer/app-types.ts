// SPDX-License-Identifier: GPL-2.0-or-later

import type { DeviceInfo } from '../shared/types/protocol'

/** Keyboard with saved pipette files, shown in the File tab */
export interface PipetteFileKeyboard {
  uid: string
  name: string
  entryCount: number
}

/** Entry from locally-saved v2 files shown in the File tab */
export interface PipetteFileEntry {
  uid: string
  entryId: string
  label: string
  keyboardName: string
  savedAt: string
}

/** Lighting types that require the RGBConfigurator modal */
export const LIGHTING_TYPES = new Set([
  'qmk_backlight',
  'qmk_rgblight',
  'qmk_backlight_rgblight',
  'vialrgb',
])

export function formatDeviceId(dev: DeviceInfo): string {
  const vid = dev.vendorId.toString(16).padStart(4, '0')
  const pid = dev.productId.toString(16).padStart(4, '0')
  return `${vid}:${pid}`
}
