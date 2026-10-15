// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI device and protocol members for the Tauri build: the same
// wrappers as the Electron preload (src/preload/index.ts) around the same
// src/preload/protocol.ts, whose transport is the Tauri one
// (./hid-transport, see vite.tauri.config.ts). getDefinition decompresses in
// the WebView instead of over IPC.

import * as protocol from '../preload/protocol'
import type { KeyboardDefinition } from '../shared/types/protocol'
import type { VialAPI } from '../shared/types/vial-api'
import { decompressDefinition } from './definition-decompress'
import { closeHidDevice, isDeviceOpen, listDevices, openHidDevice } from './hid-transport'

async function getDefinition(): Promise<KeyboardDefinition | null> {
  try {
    const size = await protocol.getDefinitionSize()
    const raw = await protocol.getDefinitionRaw(size)
    const text = await decompressDefinition(raw)
    if (text === null) {
      console.warn('LZMA decompression failed')
      return null
    }
    try {
      return JSON.parse(text) as KeyboardDefinition
    } catch {
      console.warn('Failed to parse definition JSON')
      return null
    }
  } catch (err) {
    console.warn('Failed to fetch definition:', err)
    return null
  }
}

export const deviceApi = {
  // --- Device Management ---
  listDevices: () => listDevices(),
  openDevice: (vendorId, productId) => openHidDevice(vendorId, productId),
  closeDevice: () => closeHidDevice(),
  isDeviceOpen: () => isDeviceOpen(),

  // --- VIA Protocol ---
  getProtocolVersion: () => protocol.getProtocolVersion(),
  getLayerCount: () => protocol.getLayerCount(),
  getKeymapBuffer: (offset, size) => protocol.getKeymapBuffer(offset, size),
  setKeycode: (layer, row, col, keycode) => protocol.setKeycode(layer, row, col, keycode),
  getLayoutOptions: () => protocol.getLayoutOptions(),
  setLayoutOptions: (options) => protocol.setLayoutOptions(options),

  // --- Vial Protocol ---
  getKeyboardId: () => protocol.getKeyboardId(),
  getDefinitionSize: () => protocol.getDefinitionSize(),
  getDefinitionRaw: (size) => protocol.getDefinitionRaw(size).then((buf) => Array.from(buf)),
  getDefinition,
  getEncoder: (layer, index) => protocol.getEncoder(layer, index),
  setEncoder: (layer, index, direction, keycode) => protocol.setEncoder(layer, index, direction, keycode),

  // --- Macro ---
  getMacroCount: () => protocol.getMacroCount(),
  getMacroBufferSize: () => protocol.getMacroBufferSize(),
  getMacroBuffer: (totalSize) => protocol.getMacroBuffer(totalSize),
  setMacroBuffer: (data) => protocol.setMacroBuffer(data),

  // --- Lighting ---
  getLightingValue: (id) => protocol.getLightingValue(id),
  setLightingValue: (id, ...args) => protocol.setLightingValue(id, ...args),
  saveLighting: () => protocol.saveLighting(),

  // --- VialRGB ---
  getVialRGBInfo: () => protocol.getVialRGBInfo(),
  getVialRGBMode: () => protocol.getVialRGBMode(),
  getVialRGBSupported: () => protocol.getVialRGBSupported().then((s) => Array.from(s)),
  setVialRGBMode: (mode, speed, hue, sat, val) => protocol.setVialRGBMode(mode, speed, hue, sat, val),

  // --- Lock/Unlock ---
  getUnlockStatus: () => protocol.getUnlockStatus(),
  unlockStart: () => protocol.unlockStart(),
  unlockPoll: () => protocol.unlockPoll(),
  lock: () => protocol.lock(),

  // --- Dynamic Entries ---
  getDynamicEntryCount: () => protocol.getDynamicEntryCount(),
  getTapDance: (index) => protocol.getTapDance(index),
  setTapDance: (index, entry) =>
    protocol.setTapDance(index, entry as Parameters<typeof protocol.setTapDance>[1]),
  getCombo: (index) => protocol.getCombo(index),
  setCombo: (index, entry) => protocol.setCombo(index, entry as Parameters<typeof protocol.setCombo>[1]),
  getKeyOverride: (index) => protocol.getKeyOverride(index),
  setKeyOverride: (index, entry) =>
    protocol.setKeyOverride(index, entry as Parameters<typeof protocol.setKeyOverride>[1]),
  getAltRepeatKey: (index) => protocol.getAltRepeatKey(index),
  setAltRepeatKey: (index, entry) =>
    protocol.setAltRepeatKey(index, entry as Parameters<typeof protocol.setAltRepeatKey>[1]),

  // --- QMK Settings ---
  qmkSettingsQuery: (startId) => protocol.qmkSettingsQuery(startId),
  qmkSettingsGet: (qsid) => protocol.qmkSettingsGet(qsid),
  qmkSettingsSet: (qsid, data) => protocol.qmkSettingsSet(qsid, data),
  qmkSettingsReset: () => protocol.qmkSettingsReset(),

  // --- Matrix Tester ---
  getMatrixState: () => protocol.getMatrixState(),
} satisfies Partial<VialAPI>
