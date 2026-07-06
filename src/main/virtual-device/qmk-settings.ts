// SPDX-License-Identifier: GPL-2.0-or-later
// QMK Settings store and wire protocol for the virtual GPK60-63R emulator.
//
// The field list, per-qsid width, and defaults mirror vial-qmk's
// quantum/qmk_settings.c `protos[]` table and qmk_settings_reset(). Qsids 9-17
// (mousekey_*) are only registered when `defined(MOUSEKEY_ENABLE) &&
// !defined(MK_3_SPEED)`; the keyboard's info.json sets `"mousekey": true` and
// nothing defines MK_3_SPEED, so those qsids are included. Qsid 8 (a legacy
// tapping_v2 bitfield from older vial-qmk releases) was never assigned a slot
// in this vial-qmk version's `protos[]` table — the ids jump from 7 to 9 — so
// it is intentionally absent here too, matching upstream.

import { readLE16, writeLE16, readLE32, writeLE32 } from './byte-utils'

export interface QmkSettingsStore {
  graveEscOverride: number
  comboTerm: number
  autoShift: number
  autoShiftTimeout: number
  oskTapToggle: number
  oskTimeout: number
  tappingTerm: number
  mousekeyDelay: number
  mousekeyInterval: number
  mousekeyMoveDelta: number
  mousekeyMaxSpeed: number
  mousekeyTimeToMax: number
  mousekeyWheelDelay: number
  mousekeyWheelInterval: number
  mousekeyWheelMaxSpeed: number
  mousekeyWheelTimeToMax: number
  tapCodeDelay: number
  tapHoldCapsDelay: number
  tappingToggle: number
  /** Magic-settings bit flags (mod swaps, NKRO, ...) — qsid 21. */
  magicFlags: number
  /** Bitfield backing qsids 22/23/24/26 (permissive hold / hold-on-other / retro tapping / chordal hold). */
  tappingV2: number
  quickTapTerm: number
  flowTapTerm: number
}

/**
 * Wire descriptor per qsid, mirroring qmk_settings.c's `protos[]` entries:
 * scalar qsids carry a byte width + backing store field, the tapping_v2
 * qsids carry the bit they address inside `tappingV2`. Declared in the same
 * (already qsid-ascending) order the firmware table declares them —
 * qmk_settings_query() walks that order.
 */
type QsidProto = { width: 1 | 2 | 4; field: keyof QmkSettingsStore } | { bit: number }

const QSID_PROTOS: ReadonlyMap<number, QsidProto> = new Map<number, QsidProto>([
  [1, { width: 1, field: 'graveEscOverride' }],
  [2, { width: 2, field: 'comboTerm' }],
  [3, { width: 1, field: 'autoShift' }],
  [4, { width: 2, field: 'autoShiftTimeout' }],
  [5, { width: 1, field: 'oskTapToggle' }],
  [6, { width: 2, field: 'oskTimeout' }],
  [7, { width: 2, field: 'tappingTerm' }],
  [9, { width: 2, field: 'mousekeyDelay' }],
  [10, { width: 2, field: 'mousekeyInterval' }],
  [11, { width: 2, field: 'mousekeyMoveDelta' }],
  [12, { width: 2, field: 'mousekeyMaxSpeed' }],
  [13, { width: 2, field: 'mousekeyTimeToMax' }],
  [14, { width: 2, field: 'mousekeyWheelDelay' }],
  [15, { width: 2, field: 'mousekeyWheelInterval' }],
  [16, { width: 2, field: 'mousekeyWheelMaxSpeed' }],
  [17, { width: 2, field: 'mousekeyWheelTimeToMax' }],
  [18, { width: 2, field: 'tapCodeDelay' }],
  [19, { width: 2, field: 'tapHoldCapsDelay' }],
  [20, { width: 1, field: 'tappingToggle' }],
  [21, { width: 4, field: 'magicFlags' }],
  [22, { bit: 0 }],
  [23, { bit: 1 }],
  [24, { bit: 2 }],
  [25, { width: 2, field: 'quickTapTerm' }],
  [26, { bit: 3 }],
  [27, { width: 2, field: 'flowTapTerm' }],
])

/** Supported qsids in firmware-table order (Map preserves insertion order). */
export const SUPPORTED_QSIDS: readonly number[] = [...QSID_PROTOS.keys()]

export function createDefaultQmkSettings(): QmkSettingsStore {
  return {
    graveEscOverride: 0,
    comboTerm: 50, // quantum/process_keycode/process_combo.h COMBO_TERM
    autoShift: 0,
    autoShiftTimeout: 175, // quantum/process_keycode/process_auto_shift.h AUTO_SHIFT_TIMEOUT
    oskTapToggle: 5, // qmk_settings.h ONESHOT_TAP_TOGGLE
    oskTimeout: 5000, // qmk_settings.h ONESHOT_TIMEOUT
    tappingTerm: 200, // quantum/action_tapping.h TAPPING_TERM
    mousekeyDelay: 10, // quantum/mousekey.h MOUSEKEY_DELAY (no MK_3_SPEED/MK_KINETIC_SPEED/MOUSEKEY_INERTIA)
    mousekeyInterval: 20, // MOUSEKEY_INTERVAL
    mousekeyMoveDelta: 8, // MOUSEKEY_MOVE_DELTA
    mousekeyMaxSpeed: 10, // MOUSEKEY_MAX_SPEED
    mousekeyTimeToMax: 30, // MOUSEKEY_TIME_TO_MAX
    mousekeyWheelDelay: 10, // MOUSEKEY_WHEEL_DELAY
    mousekeyWheelInterval: 80, // MOUSEKEY_WHEEL_INTERVAL
    mousekeyWheelMaxSpeed: 8, // MOUSEKEY_WHEEL_MAX_SPEED
    mousekeyWheelTimeToMax: 40, // MOUSEKEY_WHEEL_TIME_TO_MAX
    tapCodeDelay: 10, // qmk_settings.h TAP_CODE_DELAY
    tapHoldCapsDelay: 80, // qmk_settings.h TAP_HOLD_CAPS_DELAY
    tappingToggle: 5, // quantum/action_tapping.h TAPPING_TOGGLE
    magicFlags: 0,
    tappingV2: 0,
    quickTapTerm: 200, // qmk_settings_reset(): QS.quick_tap_term = TAPPING_TERM
    flowTapTerm: 0,
  }
}

export function resetQmkSettings(store: QmkSettingsStore): void {
  Object.assign(store, createDefaultQmkSettings())
}

/**
 * Fill `buf` with the qsids greater than `qsidGreaterThan`, LE16-encoded,
 * starting at offset 0 — mirrors qmk_settings_query()'s full-buffer memset(0xFF)
 * + append-in-table-order behavior (the buffer IS the response, unlike get/set
 * which only touch a sub-range).
 */
export function qmkSettingsQuery(qsidGreaterThan: number, buf: Uint8Array): void {
  buf.fill(0xff)
  let offset = 0
  for (const qsid of SUPPORTED_QSIDS) {
    if (offset + 2 > buf.length) break
    if (qsid > qsidGreaterThan) {
      writeLE16(buf, offset, qsid)
      offset += 2
    }
  }
}

/** Returns 0 (ok, value written to buf at offset) or 0xff (unsupported qsid, buf untouched). */
export function qmkSettingsGet(store: QmkSettingsStore, qsid: number, buf: Uint8Array, offset: number): number {
  const proto = QSID_PROTOS.get(qsid)
  if (!proto) return 0xff

  if ('bit' in proto) {
    buf[offset] = (store.tappingV2 >> proto.bit) & 1
    return 0
  }
  const value = store[proto.field]
  if (proto.width === 1) {
    buf[offset] = value & 0xff
  } else if (proto.width === 2) {
    writeLE16(buf, offset, value)
  } else {
    writeLE32(buf, offset, value)
  }
  return 0
}

/** Returns 0 (ok, value read from buf at offset) or 0xff (unsupported qsid, store untouched). */
export function qmkSettingsSet(store: QmkSettingsStore, qsid: number, buf: Uint8Array, offset: number): number {
  const proto = QSID_PROTOS.get(qsid)
  if (!proto) return 0xff

  if ('bit' in proto) {
    if (buf[offset] & 1) {
      store.tappingV2 |= 1 << proto.bit
    } else {
      store.tappingV2 &= ~(1 << proto.bit)
    }
    return 0
  }
  if (proto.width === 1) {
    store[proto.field] = buf[offset]
  } else if (proto.width === 2) {
    store[proto.field] = readLE16(buf, offset)
  } else {
    store[proto.field] = readLE32(buf, offset)
  }
  return 0
}
