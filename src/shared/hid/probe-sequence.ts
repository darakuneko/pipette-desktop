// SPDX-License-Identifier: GPL-2.0-or-later
// The Vial requests that read a secondary keyboard's definition, keymap,
// layout options and encoders for the layout picker, without touching the
// main connection. The caller supplies the raw exchange over its temporary
// handle and the definition decompression (src/tauri-shim/api/device.ts).

import {
  MSG_LEN,
  BUFFER_FETCH_CHUNK,
  CMD_VIA_GET_KEYBOARD_VALUE,
  CMD_VIA_GET_LAYER_COUNT,
  CMD_VIA_KEYMAP_GET_BUFFER,
  CMD_VIA_VIAL_PREFIX,
  VIA_LAYOUT_OPTIONS,
  CMD_VIAL_GET_KEYBOARD_ID,
  CMD_VIAL_GET_SIZE,
  CMD_VIAL_GET_DEFINITION,
  CMD_VIAL_GET_ENCODER,
} from '../constants/protocol'
import type { KeyboardDefinition, ProbeResult } from '../types/protocol'
import { parseDefinitionLayout } from '../kle/definition-layout'

/** One request (zero-padded to MSG_LEN by the host) and its MSG_LEN-byte
 *  response. Rejects when the device does not answer; the sequence never
 *  retries. */
export type ProbeSendReceive = (data: number[]) => Promise<number[]>

/** The compressed definition bytes to its JSON text, or null when they do
 *  not decompress. */
export type ProbeDecompress = (compressed: number[]) => Promise<string | null>

function readBE16(buf: number[], offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1]
}
function readLE32(buf: number[], offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | ((buf[offset + 3] << 24) >>> 0)
}
function readLE64Hex(buf: number[], offset: number): string {
  let hex = '0x'
  for (let i = 7; i >= 0; i--) {
    hex += buf[offset + i].toString(16).padStart(2, '0')
  }
  return hex
}
function readBE32(buf: number[], offset: number): number {
  return ((buf[offset] << 24) >>> 0) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
}
function writeBE16(arr: number[], offset: number, value: number): void {
  arr[offset] = (value >> 8) & 0xff
  arr[offset + 1] = value & 0xff
}
function writeLE32(arr: number[], offset: number, value: number): void {
  arr[offset] = value & 0xff
  arr[offset + 1] = (value >> 8) & 0xff
  arr[offset + 2] = (value >> 16) & 0xff
  arr[offset + 3] = (value >> 24) & 0xff
}

/** Runs the probe requests one after another and builds the result. */
export async function runProbeSequence(
  sendReceive: ProbeSendReceive,
  decompress: ProbeDecompress,
): Promise<ProbeResult> {
  // 1. Keyboard ID
  const idResp = await sendReceive([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_KEYBOARD_ID])
  const vialProtocol = readLE32(idResp, 0)
  const uid = readLE64Hex(idResp, 4)

  // 2. Definition
  const sizeResp = await sendReceive([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_SIZE])
  const defSize = readLE32(sizeResp, 0)

  const blocks = Math.ceil(defSize / MSG_LEN)
  const compressedBuf = new Uint8Array(defSize)
  for (let block = 0; block < blocks; block++) {
    const pkt = new Array<number>(MSG_LEN).fill(0)
    pkt[0] = CMD_VIA_VIAL_PREFIX
    pkt[1] = CMD_VIAL_GET_DEFINITION
    writeLE32(pkt, 2, block)
    const resp = await sendReceive(pkt)
    const copyLen = Math.min(MSG_LEN, defSize - block * MSG_LEN)
    for (let i = 0; i < copyLen; i++) {
      compressedBuf[block * MSG_LEN + i] = resp[i]
    }
  }

  // 3. LZMA/XZ decompression
  const jsonStr = await decompress(Array.from(compressedBuf))
  if (!jsonStr) {
    throw new Error('Failed to decompress keyboard definition')
  }
  const definition = JSON.parse(jsonStr) as KeyboardDefinition
  const name = definition.name ?? 'Unknown'
  const rows = definition.matrix.rows
  const cols = definition.matrix.cols

  // 4. Layer count
  const layerResp = await sendReceive([CMD_VIA_GET_LAYER_COUNT])
  const layers = layerResp[1]

  // 5. Keymap buffer, in chunks
  const keymapSize = layers * rows * cols * 2 // 2 bytes per keycode (BE16)
  const keymapBuf: number[] = []
  for (let offset = 0; offset < keymapSize; offset += BUFFER_FETCH_CHUNK) {
    const chunkSize = Math.min(BUFFER_FETCH_CHUNK, keymapSize - offset)
    const pkt = new Array<number>(MSG_LEN).fill(0)
    pkt[0] = CMD_VIA_KEYMAP_GET_BUFFER
    writeBE16(pkt, 1, offset)
    pkt[3] = chunkSize
    const resp = await sendReceive(pkt)
    for (let i = 0; i < chunkSize; i++) {
      keymapBuf.push(resp[4 + i])
    }
  }

  const keymap: Record<string, number> = {}
  let bufIdx = 0
  for (let layer = 0; layer < layers; layer++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const keycode = (keymapBuf[bufIdx] << 8) | keymapBuf[bufIdx + 1]
        keymap[`${layer},${row},${col}`] = keycode
        bufIdx += 2
      }
    }
  }

  // 6. Layout options
  const layoutResp = await sendReceive([CMD_VIA_GET_KEYBOARD_VALUE, VIA_LAYOUT_OPTIONS])
  const layoutOptions = readBE32(layoutResp, 2)

  // 7. Encoders — indices come from the canonical KLE layout parser
  const encoderLayout: Record<string, number> = {}
  const { encoderIdx } = parseDefinitionLayout(definition)
  const encoderCount = encoderIdx.size
  for (const idx of encoderIdx) {
    for (let layer = 0; layer < layers; layer++) {
      const resp = await sendReceive([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_ENCODER, layer, idx])
      encoderLayout[`${layer},${idx},0`] = readBE16(resp, 0)
      encoderLayout[`${layer},${idx},1`] = readBE16(resp, 2)
    }
  }

  return {
    uid,
    name,
    vialProtocol,
    definition,
    layers,
    rows,
    cols,
    keymap,
    encoderLayout,
    encoderCount,
    layoutOptions,
  }
}
