// SPDX-License-Identifier: GPL-2.0-or-later
// The vialAPI members that run the Vial protocol (./protocol), used by
// ./api/device.ts. This module imports nothing at run time; the caller
// passes the protocol module and its way of decompressing the keyboard
// definition.

import type * as Protocol from './protocol'
import type { KeyboardDefinition } from '../shared/types/protocol'
import type { VialAPI } from '../shared/types/vial-api'

/** The compressed definition bytes to its JSON text, or null when they do
 *  not decompress. Each host runs it outside the renderer's page. */
export type DecompressDefinition = (compressed: number[]) => Promise<string | null>

export type ProtocolMembers = Pick<
  VialAPI,
  | 'getProtocolVersion'
  | 'getLayerCount'
  | 'getKeymapBuffer'
  | 'setKeycode'
  | 'getLayoutOptions'
  | 'setLayoutOptions'
  | 'getKeyboardId'
  | 'getDefinitionSize'
  | 'getDefinitionRaw'
  | 'getDefinition'
  | 'getEncoder'
  | 'setEncoder'
  | 'getMacroCount'
  | 'getMacroBufferSize'
  | 'getMacroBuffer'
  | 'setMacroBuffer'
  | 'getLightingValue'
  | 'setLightingValue'
  | 'saveLighting'
  | 'getVialRGBInfo'
  | 'getVialRGBMode'
  | 'getVialRGBSupported'
  | 'setVialRGBMode'
  | 'getUnlockStatus'
  | 'unlockStart'
  | 'unlockPoll'
  | 'lock'
  | 'getDynamicEntryCount'
  | 'getTapDance'
  | 'setTapDance'
  | 'getCombo'
  | 'setCombo'
  | 'getKeyOverride'
  | 'setKeyOverride'
  | 'getAltRepeatKey'
  | 'setAltRepeatKey'
  | 'qmkSettingsQuery'
  | 'qmkSettingsGet'
  | 'qmkSettingsSet'
  | 'qmkSettingsReset'
  | 'getMatrixState'
>

export function createProtocolMembers(
  protocol: typeof Protocol,
  decompressDefinition: DecompressDefinition,
): ProtocolMembers {
  return {
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
    getDefinition: async (): Promise<KeyboardDefinition | null> => {
      try {
        const size = await protocol.getDefinitionSize()
        const raw = await protocol.getDefinitionRaw(size)
        const result = await decompressDefinition(Array.from(raw))
        if (result === null) {
          console.warn('LZMA decompression failed')
          return null
        }
        try {
          return JSON.parse(result) as KeyboardDefinition
        } catch {
          console.warn('Failed to parse definition JSON')
          return null
        }
      } catch (err) {
        console.warn('Failed to fetch definition:', err)
        return null
      }
    },
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
    setTapDance: (index, entry) => protocol.setTapDance(index, entry),
    getCombo: (index) => protocol.getCombo(index),
    setCombo: (index, entry) => protocol.setCombo(index, entry),
    getKeyOverride: (index) => protocol.getKeyOverride(index),
    setKeyOverride: (index, entry) => protocol.setKeyOverride(index, entry),
    getAltRepeatKey: (index) => protocol.getAltRepeatKey(index),
    setAltRepeatKey: (index, entry) => protocol.setAltRepeatKey(index, entry),

    // --- QMK Settings ---
    qmkSettingsQuery: (startId) => protocol.qmkSettingsQuery(startId),
    qmkSettingsGet: (qsid) => protocol.qmkSettingsGet(qsid),
    qmkSettingsSet: (qsid, data) => protocol.qmkSettingsSet(qsid, data),
    qmkSettingsReset: () => protocol.qmkSettingsReset(),

    // --- Matrix Tester ---
    getMatrixState: () => protocol.getMatrixState(),
  }
}
