/**
 * VIA/Vial protocol command implementation.
 * Runs in preload context, directly uses WebHID transport.
 *
 * Byte-level packet construction follows the vial-gui Python reference:
 * - VIA commands: [cmd, ...args] padded to 32 bytes
 * - Vial commands: [0xFE, subcmd, ...args] padded to 32 bytes
 * - Endianness is INCONSISTENT by design (matches firmware):
 *     Big-endian: keycodes, keymap offsets, macro offsets, layout options
 *     Little-endian: vial protocol, keyboard uid, definition block, dynamic entries, QMK settings
 */

import { sendReceive } from './hid-transport'
import {
  MSG_LEN,
  BUFFER_FETCH_CHUNK,
  CMD_VIA_GET_PROTOCOL_VERSION,
  CMD_VIA_GET_KEYBOARD_VALUE,
  CMD_VIA_SET_KEYBOARD_VALUE,
  CMD_VIA_SET_KEYCODE,
  CMD_VIA_LIGHTING_SET_VALUE,
  CMD_VIA_LIGHTING_GET_VALUE,
  CMD_VIA_LIGHTING_SAVE,
  CMD_VIA_MACRO_GET_COUNT,
  CMD_VIA_MACRO_GET_BUFFER_SIZE,
  CMD_VIA_MACRO_GET_BUFFER,
  CMD_VIA_MACRO_SET_BUFFER,
  CMD_VIA_GET_LAYER_COUNT,
  CMD_VIA_KEYMAP_GET_BUFFER,
  CMD_VIA_VIAL_PREFIX,
  VIA_LAYOUT_OPTIONS,
  VIA_SWITCH_MATRIX_STATE,
  VIALRGB_GET_INFO,
  VIALRGB_GET_MODE,
  VIALRGB_GET_SUPPORTED,
  VIALRGB_SET_MODE,
  CMD_VIAL_GET_KEYBOARD_ID,
  CMD_VIAL_GET_SIZE,
  CMD_VIAL_GET_DEFINITION,
  CMD_VIAL_GET_ENCODER,
  CMD_VIAL_SET_ENCODER,
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
  ECHO_RETRY_COUNT,
  ECHO_RETRY_DELAY_MS,
  ECHO_DETECTED_MSG,
} from '../shared/constants/protocol'
import type {
  KeyboardId,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
  DynamicEntryCounts,
  UnlockStatus,
} from '../shared/types/protocol'

// --- Byte helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Detect echo: device echoes the sent packet when it doesn't support
 * the command. Compare first 4 bytes to avoid false positives
 * (e.g. a valid QSID of 0x09FE would match a 2-byte check).
 */
const ECHO_CHECK_BYTES = 4

function isVialEcho(resp: Uint8Array, pkt: Uint8Array): boolean {
  for (let i = 0; i < ECHO_CHECK_BYTES; i++) {
    if (resp[i] !== pkt[i]) return false
  }
  return true
}

/**
 * Send a Vial command with echo retry.
 * If the device echoes the command, retry up to ECHO_RETRY_COUNT times.
 * Throws with ECHO_DETECTED_MSG if all retries return echoes.
 */
async function sendWithEchoRetry(pkt: Uint8Array): Promise<Uint8Array> {
  for (let attempt = 0; attempt < ECHO_RETRY_COUNT; attempt++) {
    const resp = await sendReceive(pkt)
    if (!isVialEcho(resp, pkt)) return resp
    if (attempt < ECHO_RETRY_COUNT - 1) {
      await delay(ECHO_RETRY_DELAY_MS)
    }
  }
  throw new Error(ECHO_DETECTED_MSG)
}

/** Build a command packet (auto-padded to MSG_LEN). */
function cmd(...bytes: number[]): Uint8Array {
  const buf = new Uint8Array(MSG_LEN)
  for (let i = 0; i < bytes.length && i < MSG_LEN; i++) {
    buf[i] = bytes[i]
  }
  return buf
}

/** Write a big-endian u16 into buf at offset. */
function writeBE16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 8) & 0xff
  buf[offset + 1] = value & 0xff
}

/** Read a big-endian u16 from buf at offset. */
function readBE16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1]
}

/** Read a big-endian u32 from buf at offset. */
function readBE32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
}

/** Write a big-endian u32 into buf at offset. */
function writeBE32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

/** Read a little-endian u16 from buf at offset. */
function readLE16(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

/** Write a little-endian u16 into buf at offset. */
function writeLE16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >> 8) & 0xff
}

/** Read a little-endian u32 from buf at offset. */
function readLE32(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
}

/** Write a little-endian u32 into buf at offset. */
function writeLE32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >> 8) & 0xff
  buf[offset + 2] = (value >> 16) & 0xff
  buf[offset + 3] = (value >> 24) & 0xff
}

/** Read a little-endian u64 from buf at offset as hex string. */
function readLE64Hex(buf: Uint8Array, offset: number): string {
  let hex = ''
  for (let i = 7; i >= 0; i--) {
    hex += buf[offset + i].toString(16).padStart(2, '0')
  }
  return '0x' + hex
}

// =====================================================================
// VIA Protocol Commands
// =====================================================================

/** Get VIA protocol version. Response bytes 1-2: u16 big-endian. */
export async function getProtocolVersion(): Promise<number> {
  const resp = await sendReceive(cmd(CMD_VIA_GET_PROTOCOL_VERSION))
  return readBE16(resp, 1)
}

/** Get layer count. Response byte 1: u8. */
export async function getLayerCount(): Promise<number> {
  const resp = await sendReceive(cmd(CMD_VIA_GET_LAYER_COUNT))
  return resp[1]
}

/**
 * Get keymap buffer chunk.
 * Request: [0x12, offset_BE16, size_u8]
 * Response: [4-byte echo, up to 28 bytes of keycode data]
 */
export async function getKeymapBuffer(offset: number, size: number): Promise<number[]> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_KEYMAP_GET_BUFFER
  writeBE16(pkt, 1, offset)
  pkt[3] = size
  const resp = await sendReceive(pkt)
  return Array.from(resp.subarray(4, 4 + size))
}

/**
 * Set a single keycode.
 * Request: [0x05, layer, row, col, keycode_BE16]
 */
export async function setKeycode(
  layer: number,
  row: number,
  col: number,
  keycode: number,
): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_SET_KEYCODE
  pkt[1] = layer
  pkt[2] = row
  pkt[3] = col
  writeBE16(pkt, 4, keycode)
  await sendReceive(pkt)
}

/** Get layout options. Response bytes 2-5: u32 big-endian. */
export async function getLayoutOptions(): Promise<number> {
  const resp = await sendReceive(cmd(CMD_VIA_GET_KEYBOARD_VALUE, VIA_LAYOUT_OPTIONS))
  return readBE32(resp, 2)
}

/** Set layout options. Request bytes 2-5: u32 big-endian. */
export async function setLayoutOptions(options: number): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_SET_KEYBOARD_VALUE
  pkt[1] = VIA_LAYOUT_OPTIONS
  writeBE32(pkt, 2, options)
  await sendReceive(pkt)
}

// --- Macro ---

/** Get macro count. Response byte 1: u8. */
export async function getMacroCount(): Promise<number> {
  const resp = await sendReceive(cmd(CMD_VIA_MACRO_GET_COUNT))
  return resp[1]
}

/** Get macro buffer size. Response bytes 1-2: u16 big-endian. */
export async function getMacroBufferSize(): Promise<number> {
  const resp = await sendReceive(cmd(CMD_VIA_MACRO_GET_BUFFER_SIZE))
  return readBE16(resp, 1)
}

/**
 * Get entire macro buffer by fetching 28-byte chunks.
 * Returns the full buffer as a number array.
 */
export async function getMacroBuffer(totalSize: number): Promise<number[]> {
  const buffer: number[] = []
  for (let offset = 0; offset < totalSize; offset += BUFFER_FETCH_CHUNK) {
    const chunkSize = Math.min(BUFFER_FETCH_CHUNK, totalSize - offset)
    const pkt = new Uint8Array(MSG_LEN)
    pkt[0] = CMD_VIA_MACRO_GET_BUFFER
    writeBE16(pkt, 1, offset)
    pkt[3] = chunkSize
    const resp = await sendReceive(pkt)
    for (let i = 0; i < chunkSize; i++) {
      buffer.push(resp[4 + i])
    }
  }
  return buffer
}

/**
 * Set macro buffer by writing 28-byte chunks.
 */
export async function setMacroBuffer(data: number[]): Promise<void> {
  for (let offset = 0; offset < data.length; offset += BUFFER_FETCH_CHUNK) {
    const chunkSize = Math.min(BUFFER_FETCH_CHUNK, data.length - offset)
    const pkt = new Uint8Array(MSG_LEN)
    pkt[0] = CMD_VIA_MACRO_SET_BUFFER
    writeBE16(pkt, 1, offset)
    pkt[3] = chunkSize
    for (let i = 0; i < chunkSize; i++) {
      pkt[4 + i] = data[offset + i]
    }
    await sendReceive(pkt)
  }
}

// --- Lighting ---

/** Get a lighting value. Returns raw response bytes from offset 2. */
export async function getLightingValue(id: number): Promise<number[]> {
  const resp = await sendReceive(cmd(CMD_VIA_LIGHTING_GET_VALUE, id))
  return Array.from(resp.subarray(2))
}

/** Set a lighting value. */
export async function setLightingValue(id: number, ...args: number[]): Promise<void> {
  await sendReceive(cmd(CMD_VIA_LIGHTING_SET_VALUE, id, ...args))
}

/** Save lighting settings to EEPROM. */
export async function saveLighting(): Promise<void> {
  await sendReceive(cmd(CMD_VIA_LIGHTING_SAVE))
}

// --- VialRGB ---

/** Get VialRGB info: protocol version and max brightness. */
export async function getVialRGBInfo(): Promise<{ version: number; maxBrightness: number }> {
  const resp = await sendReceive(cmd(CMD_VIA_LIGHTING_GET_VALUE, VIALRGB_GET_INFO))
  return {
    version: readLE16(resp, 2),
    maxBrightness: resp[4],
  }
}

/** Get VialRGB current mode, speed, and HSV color. */
export async function getVialRGBMode(): Promise<{
  mode: number
  speed: number
  hue: number
  sat: number
  val: number
}> {
  const resp = await sendReceive(cmd(CMD_VIA_LIGHTING_GET_VALUE, VIALRGB_GET_MODE))
  return {
    mode: readLE16(resp, 2),
    speed: resp[4],
    hue: resp[5],
    sat: resp[6],
    val: resp[7],
  }
}

/**
 * Get VialRGB supported effects.
 * Queries paginated effect lists using maxEffect as cursor.
 * Loop terminates when maxEffect reaches 0xFFFF (sentinel)
 * or when no progress is made on a page (stall guard).
 * Always includes effect 0.
 */
export async function getVialRGBSupported(): Promise<Set<number>> {
  const supported = new Set<number>([0])
  let maxEffect = 0

  while (maxEffect < 0xffff) {
    const prevMax = maxEffect
    const pkt = new Uint8Array(MSG_LEN)
    pkt[0] = CMD_VIA_LIGHTING_GET_VALUE
    pkt[1] = VIALRGB_GET_SUPPORTED
    writeLE16(pkt, 2, maxEffect)
    const resp = await sendReceive(pkt)

    for (let i = 2; i + 1 < resp.length; i += 2) {
      const val = readLE16(resp, i)
      if (val !== 0xffff) {
        supported.add(val)
      }
      maxEffect = Math.max(maxEffect, val)
    }

    if (maxEffect === prevMax) break
  }

  return supported
}

/** Set VialRGB mode, speed, and HSV color. */
export async function setVialRGBMode(
  mode: number,
  speed: number,
  hue: number,
  sat: number,
  val: number,
): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_LIGHTING_SET_VALUE
  pkt[1] = VIALRGB_SET_MODE
  writeLE16(pkt, 2, mode)
  pkt[4] = speed
  pkt[5] = hue
  pkt[6] = sat
  pkt[7] = val
  await sendReceive(pkt)
}

// --- Matrix tester ---

/** Get switch matrix state. Returns raw response bytes from offset 2. */
export async function getMatrixState(): Promise<number[]> {
  const resp = await sendReceive(cmd(CMD_VIA_GET_KEYBOARD_VALUE, VIA_SWITCH_MATRIX_STATE))
  return Array.from(resp.subarray(2))
}

// =====================================================================
// Vial Protocol Commands (prefixed with 0xFE)
// =====================================================================

/**
 * Get keyboard ID.
 * Response bytes 0-3: vial_protocol (u32 LE), bytes 4-11: uid (u64 LE as hex string).
 */
export async function getKeyboardId(): Promise<KeyboardId> {
  const resp = await sendReceive(cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_KEYBOARD_ID))
  return {
    vialProtocol: readLE32(resp, 0),
    uid: readLE64Hex(resp, 4),
  }
}

/**
 * Get compressed definition size.
 * Response bytes 0-3: size (u32 LE).
 */
export async function getDefinitionSize(): Promise<number> {
  const resp = await sendReceive(cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_SIZE))
  return readLE32(resp, 0)
}

/**
 * Get compressed definition data by fetching 32-byte blocks.
 * Returns the raw LZMA-compressed bytes.
 */
export async function getDefinitionRaw(size: number): Promise<Uint8Array> {
  const blocks = Math.ceil(size / MSG_LEN)
  const result = new Uint8Array(size)

  for (let block = 0; block < blocks; block++) {
    const pkt = new Uint8Array(MSG_LEN)
    pkt[0] = CMD_VIA_VIAL_PREFIX
    pkt[1] = CMD_VIAL_GET_DEFINITION
    writeLE32(pkt, 2, block)
    const resp = await sendReceive(pkt)
    const copyLen = Math.min(MSG_LEN, size - block * MSG_LEN)
    result.set(resp.subarray(0, copyLen), block * MSG_LEN)
  }

  return result
}

/**
 * Get encoder keycode pair for a given layer and encoder index.
 * Response: [cw_keycode_BE16, ccw_keycode_BE16]
 */
export async function getEncoder(
  layer: number,
  encoderIndex: number,
): Promise<[number, number]> {
  const resp = await sendReceive(
    cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_ENCODER, layer, encoderIndex),
  )
  return [readBE16(resp, 0), readBE16(resp, 2)]
}

/**
 * Set encoder keycode.
 * Request: [0xFE, 0x04, layer, index, direction, keycode_BE16]
 */
export async function setEncoder(
  layer: number,
  encoderIndex: number,
  direction: number,
  keycode: number,
): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_SET_ENCODER
  pkt[2] = layer
  pkt[3] = encoderIndex
  pkt[4] = direction
  writeBE16(pkt, 5, keycode)
  await sendReceive(pkt)
}

// --- Unlock ---

/**
 * Get unlock status.
 * Response byte 0: locked(0)/unlocked(1)
 * Response byte 1: unlock in progress flag
 * Response bytes 2-31: up to 15 (row,col) pairs (0xFF,0xFF = unused)
 */
export async function getUnlockStatus(): Promise<UnlockStatus> {
  const resp = await sendReceive(
    cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_UNLOCK_STATUS),
  )
  const unlocked = resp[0] === 1
  const inProgress = resp[1] !== 0
  const keys: [number, number][] = []
  for (let i = 0; i < 15; i++) {
    const row = resp[2 + i * 2]
    const col = resp[3 + i * 2]
    if (row !== 0xff && col !== 0xff) {
      keys.push([row, col])
    }
  }
  return { unlocked, inProgress, keys }
}

/** Start unlock sequence. */
export async function unlockStart(): Promise<void> {
  await sendReceive(cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_UNLOCK_START))
}

/**
 * Poll unlock progress.
 * Returns raw response for UI to interpret:
 * byte 0 = unlocked, byte 2 = counter.
 */
export async function unlockPoll(): Promise<number[]> {
  const resp = await sendReceive(cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_UNLOCK_POLL))
  return Array.from(resp)
}

/** Lock keyboard. */
export async function lock(): Promise<void> {
  await sendReceive(cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_LOCK))
}

// --- Dynamic Entries ---

/**
 * Get dynamic entry counts.
 * Unlike other dynamic entry commands, GET_NUMBER_OF_ENTRIES has no status byte.
 * Response bytes 0-3: tap_dance, combo, key_override, alt_repeat_key counts.
 * Response byte at last position: feature flags (bit 0 = caps_word, bit 1 = layer_lock).
 * Note: matches Python data[-1]. On older firmware with short responses,
 * this may overlap with the altRepeatKey byte — same as the Python reference.
 */
export async function getDynamicEntryCount(): Promise<DynamicEntryCounts> {
  const pkt = cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_DYNAMIC_ENTRY_OP, DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES)
  const resp = await sendWithEchoRetry(pkt)
  return {
    tapDance: resp[0],
    combo: resp[1],
    keyOverride: resp[2],
    altRepeatKey: resp[3],
    featureFlags: resp[resp.length - 1],
  }
}

/** Get a tap dance entry. Format: 5x u16 LE (10 bytes). */
export async function getTapDance(index: number): Promise<TapDanceEntry> {
  const resp = await sendReceive(
    cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_DYNAMIC_ENTRY_OP, DYNAMIC_VIAL_TAP_DANCE_GET, index),
  )
  if (resp[0] !== 0) throw new Error(`Failed to get tap dance entry ${index}`)
  return {
    onTap: readLE16(resp, 1),
    onHold: readLE16(resp, 3),
    onDoubleTap: readLE16(resp, 5),
    onTapHold: readLE16(resp, 7),
    tappingTerm: readLE16(resp, 9),
  }
}

/** Set a tap dance entry. */
export async function setTapDance(index: number, entry: TapDanceEntry): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_DYNAMIC_ENTRY_OP
  pkt[2] = DYNAMIC_VIAL_TAP_DANCE_SET
  pkt[3] = index
  writeLE16(pkt, 4, entry.onTap)
  writeLE16(pkt, 6, entry.onHold)
  writeLE16(pkt, 8, entry.onDoubleTap)
  writeLE16(pkt, 10, entry.onTapHold)
  writeLE16(pkt, 12, entry.tappingTerm)
  await sendReceive(pkt)
}

/** Get a combo entry. Format: 5x u16 LE (10 bytes). */
export async function getCombo(index: number): Promise<ComboEntry> {
  const resp = await sendReceive(
    cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_DYNAMIC_ENTRY_OP, DYNAMIC_VIAL_COMBO_GET, index),
  )
  if (resp[0] !== 0) throw new Error(`Failed to get combo entry ${index}`)
  return {
    key1: readLE16(resp, 1),
    key2: readLE16(resp, 3),
    key3: readLE16(resp, 5),
    key4: readLE16(resp, 7),
    output: readLE16(resp, 9),
  }
}

/** Set a combo entry. */
export async function setCombo(index: number, entry: ComboEntry): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_DYNAMIC_ENTRY_OP
  pkt[2] = DYNAMIC_VIAL_COMBO_SET
  pkt[3] = index
  writeLE16(pkt, 4, entry.key1)
  writeLE16(pkt, 6, entry.key2)
  writeLE16(pkt, 8, entry.key3)
  writeLE16(pkt, 10, entry.key4)
  writeLE16(pkt, 12, entry.output)
  await sendReceive(pkt)
}

/**
 * Get a key override entry.
 * Format after status byte: trigger(u16 LE) + replacement(u16 LE) + layers(u16 LE)
 *   + triggerMods(u8) + negativeMods(u8) + suppressedMods(u8) + options(u8)
 *   = 10 bytes total.
 */
export async function getKeyOverride(index: number): Promise<KeyOverrideEntry> {
  const resp = await sendReceive(
    cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_DYNAMIC_ENTRY_OP, DYNAMIC_VIAL_KEY_OVERRIDE_GET, index),
  )
  if (resp[0] !== 0) throw new Error(`Failed to get key override entry ${index}`)
  const optionsByte = resp[10]
  return {
    triggerKey: readLE16(resp, 1),
    replacementKey: readLE16(resp, 3),
    layers: readLE16(resp, 5),
    triggerMods: resp[7],
    negativeMods: resp[8],
    suppressedMods: resp[9],
    options: optionsByte & 0x7f,
    enabled: (optionsByte & 0x80) !== 0,
  }
}

/** Set a key override entry. */
export async function setKeyOverride(index: number, entry: KeyOverrideEntry): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_DYNAMIC_ENTRY_OP
  pkt[2] = DYNAMIC_VIAL_KEY_OVERRIDE_SET
  pkt[3] = index
  writeLE16(pkt, 4, entry.triggerKey)
  writeLE16(pkt, 6, entry.replacementKey)
  writeLE16(pkt, 8, entry.layers)
  pkt[10] = entry.triggerMods
  pkt[11] = entry.negativeMods
  pkt[12] = entry.suppressedMods
  pkt[13] = (entry.options & 0x7f) | (entry.enabled ? 0x80 : 0)
  await sendReceive(pkt)
}

/**
 * Get an alt repeat key entry.
 * Format: 2x u16 LE + 2x u8 (6 bytes total after status).
 */
export async function getAltRepeatKey(index: number): Promise<AltRepeatKeyEntry> {
  const resp = await sendReceive(
    cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_DYNAMIC_ENTRY_OP, DYNAMIC_VIAL_ALT_REPEAT_KEY_GET, index),
  )
  if (resp[0] !== 0) throw new Error(`Failed to get alt repeat key entry ${index}`)
  const options = resp[6]
  return {
    lastKey: readLE16(resp, 1),
    altKey: readLE16(resp, 3),
    allowedMods: resp[5],
    options: options & 0x07,
    enabled: (options & 0x08) !== 0,
  }
}

/** Set an alt repeat key entry. */
export async function setAltRepeatKey(index: number, entry: AltRepeatKeyEntry): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_DYNAMIC_ENTRY_OP
  pkt[2] = DYNAMIC_VIAL_ALT_REPEAT_KEY_SET
  pkt[3] = index
  writeLE16(pkt, 4, entry.lastKey)
  writeLE16(pkt, 6, entry.altKey)
  pkt[8] = entry.allowedMods
  pkt[9] = (entry.options & 0x07) | (entry.enabled ? 0x08 : 0)
  await sendReceive(pkt)
}

// --- QMK Settings ---

/**
 * Query supported QMK settings starting from a given QSID.
 * Returns raw response bytes (list of LE u16 QSIDs, 0xFFFF = terminator).
 * Throws ECHO_DETECTED if the device echoes the command after retries.
 */
export async function qmkSettingsQuery(startId: number): Promise<number[]> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_QMK_SETTINGS_QUERY
  writeLE16(pkt, 2, startId)
  const resp = await sendWithEchoRetry(pkt)
  return Array.from(resp)
}

/**
 * Get a QMK setting value.
 * Response byte 0: status (0 = ok), bytes 1+: value data.
 */
export async function qmkSettingsGet(qsid: number): Promise<number[]> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_QMK_SETTINGS_GET
  writeLE16(pkt, 2, qsid)
  const resp = await sendReceive(pkt)
  if (resp[0] !== 0) throw new Error(`Failed to get QMK setting ${qsid}`)
  return Array.from(resp.subarray(1))
}

/**
 * Set a QMK setting value.
 */
export async function qmkSettingsSet(qsid: number, data: number[]): Promise<void> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt[0] = CMD_VIA_VIAL_PREFIX
  pkt[1] = CMD_VIAL_QMK_SETTINGS_SET
  writeLE16(pkt, 2, qsid)
  for (let i = 0; i < data.length && 4 + i < MSG_LEN; i++) {
    pkt[4 + i] = data[i]
  }
  await sendReceive(pkt)
}

/** Reset all QMK settings to defaults. */
export async function qmkSettingsReset(): Promise<void> {
  await sendReceive(cmd(CMD_VIA_VIAL_PREFIX, CMD_VIAL_QMK_SETTINGS_RESET))
}
