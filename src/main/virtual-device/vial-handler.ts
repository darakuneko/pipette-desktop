// SPDX-License-Identifier: GPL-2.0-or-later
// Vial protocol command handler for the virtual device (byte0 === 0xFE,
// byte1 selects the sub-command). Supported commands build their response
// from a zeroed buffer; unsupported ones echo the request back unchanged
// so the app's echo-detection correctly reports the feature as absent.

import { MSG_LEN } from '../../shared/constants/protocol'
import {
  CMD_VIAL_GET_KEYBOARD_ID,
  CMD_VIAL_GET_SIZE,
  CMD_VIAL_GET_DEFINITION,
  CMD_VIAL_GET_UNLOCK_STATUS,
  CMD_VIAL_UNLOCK_START,
  CMD_VIAL_UNLOCK_POLL,
  CMD_VIAL_LOCK,
  CMD_VIAL_QMK_SETTINGS_QUERY,
  CMD_VIAL_QMK_SETTINGS_GET,
  CMD_VIAL_QMK_SETTINGS_SET,
  CMD_VIAL_QMK_SETTINGS_RESET,
  CMD_VIAL_DYNAMIC_ENTRY_OP,
  DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES,
  DYNAMIC_VIAL_TAP_DANCE_GET,
  DYNAMIC_VIAL_TAP_DANCE_SET,
  DYNAMIC_VIAL_COMBO_GET,
  DYNAMIC_VIAL_COMBO_SET,
  DYNAMIC_VIAL_KEY_OVERRIDE_GET,
  DYNAMIC_VIAL_KEY_OVERRIDE_SET,
  DYNAMIC_VIAL_ALT_REPEAT_KEY_GET,
  DYNAMIC_VIAL_ALT_REPEAT_KEY_SET,
} from '../../shared/constants/protocol'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../shared/types/protocol'
import { readLE16, readLE32, writeLE32 } from './byte-utils'
import { VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO, isBootKeycode } from './gpk60-63r'
import type { VirtualDeviceState } from './state'
import { unlockPollTick } from './state'
import {
  TAP_DANCE_ENTRY_COUNT,
  COMBO_ENTRY_COUNT,
  KEY_OVERRIDE_ENTRY_COUNT,
  ALT_REPEAT_KEY_ENTRY_COUNT,
  DYNAMIC_ENTRY_FEATURE_FLAGS,
  getTapDance,
  setTapDance,
  getCombo,
  setCombo,
  getKeyOverride,
  setKeyOverride,
  getAltRepeatKey,
  setAltRepeatKey,
  readTapDanceEntry,
  writeTapDanceEntry,
  readComboEntry,
  writeComboEntry,
  readKeyOverrideEntry,
  writeKeyOverrideEntry,
  readAltRepeatKeyEntry,
  writeAltRepeatKeyEntry,
} from './dynamic-entries'
import type { EntryLookup } from './dynamic-entries'
import { qmkSettingsQuery, qmkSettingsGet, qmkSettingsSet, resetQmkSettings } from './qmk-settings'

/** VialRGB support flag reported in the keyboard-id response (byte 12). */
const VIALRGB_FLAG = 1
const UNLOCK_COMBO_SLOTS = 15

function handleKeyboardId(): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  writeLE32(resp, 0, VIAL_PROTOCOL)
  resp.set(VIRTUAL_DEVICE_UID_BYTES, 4)
  resp[12] = VIALRGB_FLAG
  return resp
}

function handleDefinitionSize(compressedLength: number): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  writeLE32(resp, 0, compressedLength)
  return resp
}

function handleDefinitionBlock(req: Uint8Array, compressed: Uint8Array): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  const block = readLE32(req, 2)
  const start = block * MSG_LEN
  const copyLen = Math.max(0, Math.min(MSG_LEN, compressed.length - start))
  for (let i = 0; i < copyLen; i++) {
    resp[i] = compressed[start + i]
  }
  return resp
}

function handleUnlockStatus(state: VirtualDeviceState): Uint8Array {
  const resp = new Uint8Array(MSG_LEN).fill(0xff)
  resp[0] = state.unlocked ? 1 : 0
  resp[1] = state.unlockInProgress ? 1 : 0
  for (let i = 0; i < UNLOCK_COMBO_SLOTS; i++) {
    const pair = VIRTUAL_DEVICE_UNLOCK_COMBO[i]
    if (pair) {
      resp[2 + i * 2] = pair[0]
      resp[3 + i * 2] = pair[1]
    }
    // Empty slots keep the 0xff sentinel from the pre-fill, matching firmware.
  }
  return resp
}

function handleUnlockPoll(state: VirtualDeviceState, now: number): Uint8Array {
  unlockPollTick(state, now)
  const resp = new Uint8Array(MSG_LEN).fill(0xff)
  resp[0] = state.unlocked ? 1 : 0
  resp[1] = state.unlockInProgress ? 1 : 0
  resp[2] = Math.max(0, state.unlockCounter)
  return resp
}

/** Replaces a QK_BOOT keycode with KC_NO while locked — vial_keycode_firewall()'s behavior. */
function gateBootKeycode(state: VirtualDeviceState, keycode: number): number {
  return !state.unlocked && isBootKeycode(keycode) ? 0 : keycode
}

function handleGetNumberOfEntries(): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  resp[0] = TAP_DANCE_ENTRY_COUNT
  resp[1] = COMBO_ENTRY_COUNT
  resp[2] = KEY_OVERRIDE_ENTRY_COUNT
  resp[3] = ALT_REPEAT_KEY_ENTRY_COUNT
  resp[MSG_LEN - 1] = DYNAMIC_ENTRY_FEATURE_FLAGS
  return resp
}

/**
 * Shared shape of every dynamic-entry GET: echo the request, look the entry
 * up by req[3], put the status byte at offset 0 and the wire entry at offset 1.
 * (SET handlers stay separate — each entry kind firewalls a different subset
 * of its fields against QK_BOOT.)
 */
function handleEntryGet<T>(
  req: Uint8Array,
  entries: T[],
  lookup: (entries: T[], index: number) => EntryLookup<T>,
  writeEntry: (buf: Uint8Array, offset: number, entry: T) => void,
): Uint8Array {
  const resp = new Uint8Array(req)
  const { status, entry } = lookup(entries, req[3])
  resp[0] = status
  writeEntry(resp, 1, entry)
  return resp
}

function handleTapDanceSet(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const raw = readTapDanceEntry(req, 4)
  const entry: TapDanceEntry = {
    onTap: gateBootKeycode(state, raw.onTap),
    onHold: gateBootKeycode(state, raw.onHold),
    onDoubleTap: gateBootKeycode(state, raw.onDoubleTap),
    onTapHold: gateBootKeycode(state, raw.onTapHold),
    tappingTerm: raw.tappingTerm,
  }
  resp[0] = setTapDance(state.tapDanceEntries, req[3], entry)
  return resp
}

function handleComboSet(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const raw = readComboEntry(req, 4)
  const entry: ComboEntry = { ...raw, output: gateBootKeycode(state, raw.output) }
  resp[0] = setCombo(state.comboEntries, req[3], entry)
  return resp
}

function handleKeyOverrideSet(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const raw = readKeyOverrideEntry(req, 4)
  const entry: KeyOverrideEntry = { ...raw, replacementKey: gateBootKeycode(state, raw.replacementKey) }
  resp[0] = setKeyOverride(state.keyOverrideEntries, req[3], entry)
  return resp
}

function handleAltRepeatKeySet(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const raw = readAltRepeatKeyEntry(req, 4)
  const entry: AltRepeatKeyEntry = {
    ...raw,
    lastKey: gateBootKeycode(state, raw.lastKey),
    altKey: gateBootKeycode(state, raw.altKey),
  }
  resp[0] = setAltRepeatKey(state.altRepeatKeyEntries, req[3], entry)
  return resp
}

function handleDynamicEntryOp(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  switch (req[2]) {
    case DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES:
      return handleGetNumberOfEntries()
    case DYNAMIC_VIAL_TAP_DANCE_GET:
      return handleEntryGet(req, state.tapDanceEntries, getTapDance, writeTapDanceEntry)
    case DYNAMIC_VIAL_TAP_DANCE_SET:
      return handleTapDanceSet(state, req)
    case DYNAMIC_VIAL_COMBO_GET:
      return handleEntryGet(req, state.comboEntries, getCombo, writeComboEntry)
    case DYNAMIC_VIAL_COMBO_SET:
      return handleComboSet(state, req)
    case DYNAMIC_VIAL_KEY_OVERRIDE_GET:
      return handleEntryGet(req, state.keyOverrideEntries, getKeyOverride, writeKeyOverrideEntry)
    case DYNAMIC_VIAL_KEY_OVERRIDE_SET:
      return handleKeyOverrideSet(state, req)
    case DYNAMIC_VIAL_ALT_REPEAT_KEY_GET:
      return handleEntryGet(req, state.altRepeatKeyEntries, getAltRepeatKey, writeAltRepeatKeyEntry)
    case DYNAMIC_VIAL_ALT_REPEAT_KEY_SET:
      return handleAltRepeatKeySet(state, req)
    default:
      // Unrecognized dynamic-entry sub-op: unsupported, echo.
      return new Uint8Array(req)
  }
}

function handleQmkSettingsQuery(req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  const qsidGreaterThan = readLE16(req, 2)
  qmkSettingsQuery(qsidGreaterThan, resp)
  return resp
}

function handleQmkSettingsGet(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const qsid = readLE16(req, 2)
  resp[0] = qmkSettingsGet(state.qmkSettings, qsid, resp, 1)
  return resp
}

function handleQmkSettingsSet(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const qsid = readLE16(req, 2)
  resp[0] = qmkSettingsSet(state.qmkSettings, qsid, req, 4)
  return resp
}

export function handleVialReport(
  state: VirtualDeviceState,
  req: Uint8Array,
  compressedDefinition: Uint8Array,
  now: number,
): Uint8Array {
  const sub = req[1]

  switch (sub) {
    case CMD_VIAL_GET_KEYBOARD_ID:
      return handleKeyboardId()

    case CMD_VIAL_GET_SIZE:
      return handleDefinitionSize(compressedDefinition.length)

    case CMD_VIAL_GET_DEFINITION:
      return handleDefinitionBlock(req, compressedDefinition)

    case CMD_VIAL_GET_UNLOCK_STATUS:
      return handleUnlockStatus(state)

    case CMD_VIAL_UNLOCK_START:
      state.unlockInProgress = true
      state.unlockCounter = state.unlockCounterMax
      state.unlockTimer = now
      return new Uint8Array(req)

    case CMD_VIAL_UNLOCK_POLL:
      return handleUnlockPoll(state, now)

    case CMD_VIAL_LOCK:
      state.unlocked = false
      return new Uint8Array(req)

    case CMD_VIAL_QMK_SETTINGS_QUERY:
      return handleQmkSettingsQuery(req)

    case CMD_VIAL_QMK_SETTINGS_GET:
      return handleQmkSettingsGet(state, req)

    case CMD_VIAL_QMK_SETTINGS_SET:
      return handleQmkSettingsSet(state, req)

    case CMD_VIAL_QMK_SETTINGS_RESET:
      resetQmkSettings(state.qmkSettings)
      // vial.c's reset case never touches msg, so the request is echoed back unchanged.
      return new Uint8Array(req)

    case CMD_VIAL_DYNAMIC_ENTRY_OP:
      return handleDynamicEntryOp(state, req)

    default:
      // Encoders (0x03/0x04): unsupported, echo.
      return new Uint8Array(req)
  }
}
