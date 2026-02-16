// SPDX-License-Identifier: GPL-2.0-or-later

import type {
  VilFile,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
} from './types/protocol'
import { serialize as serializeKeycode, deserialize as deserializeKeycode } from './keycodes/keycodes'

// --- Helpers ---

/** Deserialize a keycode value that may be a QMK string or numeric */
function toKeycode(val: string | number): number {
  return typeof val === 'string' ? deserializeKeycode(val) : val
}

// --- Types ---

export interface VilExportContext {
  rows: number
  cols: number
  layers: number
  encoderCount: number
  vialProtocol: number
  viaProtocol: number
  macroActions: unknown[][]
}

// --- UID conversion ---

export function uidHexToBigInt(hex: string): bigint {
  return BigInt(hex)
}

export function uidBigIntToHex(n: bigint): string {
  return '0x' + n.toString(16).toUpperCase()
}

export function extractUidFromJson(rawJson: string): string {
  const match = /"uid"\s*:\s*(\d+)/.exec(rawJson)
  if (!match) return '0x0'
  return '0x' + BigInt(match[1]).toString(16).toUpperCase()
}

// --- BigInt-safe JSON stringify ---

const BIGINT_UID_PLACEHOLDER = '__BIGINT_UID__'

export function stringifyWithBigIntUid(obj: Record<string, unknown>, uid: bigint): string {
  const withPlaceholder = { ...obj, uid: BIGINT_UID_PLACEHOLDER }
  const json = JSON.stringify(withPlaceholder, null, 2)
  return json.replace(`"${BIGINT_UID_PLACEHOLDER}"`, uid.toString())
}

// --- Keymap conversion ---

function keymapToLayout(
  keymap: Record<string, number>,
  layers: number,
  rows: number,
  cols: number,
): (string | number)[][][] {
  const layout: (string | number)[][][] = []
  for (let l = 0; l < layers; l++) {
    const layerArr: (string | number)[][] = []
    for (let r = 0; r < rows; r++) {
      const rowArr: (string | number)[] = []
      for (let c = 0; c < cols; c++) {
        const key = `${l},${r},${c}`
        rowArr.push(key in keymap ? serializeKeycode(keymap[key]) : -1)
      }
      layerArr.push(rowArr)
    }
    layout.push(layerArr)
  }
  return layout
}

function layoutToKeymap(
  layout: (string | number)[][][],
): Record<string, number> {
  const keymap: Record<string, number> = {}
  for (let l = 0; l < layout.length; l++) {
    for (let r = 0; r < layout[l].length; r++) {
      for (let c = 0; c < layout[l][r].length; c++) {
        const val = layout[l][r][c]
        if (val === -1) continue
        keymap[`${l},${r},${c}`] = toKeycode(val)
      }
    }
  }
  return keymap
}

// --- Encoder layout conversion ---

function encoderToVialGui(
  encoderLayout: Record<string, number>,
  layers: number,
  encoderCount: number,
): string[][][] {
  const result: string[][][] = []
  for (let l = 0; l < layers; l++) {
    const layerArr: string[][] = []
    for (let e = 0; e < encoderCount; e++) {
      const cw = encoderLayout[`${l},${e},0`]
      const ccw = encoderLayout[`${l},${e},1`]
      layerArr.push([
        cw !== undefined ? serializeKeycode(cw) : 'KC_NO',
        ccw !== undefined ? serializeKeycode(ccw) : 'KC_NO',
      ])
    }
    result.push(layerArr)
  }
  return result
}

function vialGuiToEncoder(
  encoderLayout: (string | number)[][][],
): Record<string, number> {
  const result: Record<string, number> = {}
  for (let l = 0; l < encoderLayout.length; l++) {
    for (let e = 0; e < encoderLayout[l].length; e++) {
      const pair = encoderLayout[l][e]
      if (pair.length >= 2) {
        result[`${l},${e},0`] = toKeycode(pair[0])
        result[`${l},${e},1`] = toKeycode(pair[1])
      }
    }
  }
  return result
}

// --- Tap dance conversion ---

function tapDanceToVialGui(entries: TapDanceEntry[]): (string | number)[][] {
  return entries.map((e) => [
    serializeKeycode(e.onTap),
    serializeKeycode(e.onHold),
    serializeKeycode(e.onDoubleTap),
    serializeKeycode(e.onTapHold),
    e.tappingTerm,
  ])
}

function vialGuiToTapDance(entries: (string | number)[][]): TapDanceEntry[] {
  return entries.map((e) => ({
    onTap: toKeycode(e[0]),
    onHold: toKeycode(e[1]),
    onDoubleTap: toKeycode(e[2]),
    onTapHold: toKeycode(e[3]),
    tappingTerm: e[4] as number,
  }))
}

// --- Combo conversion ---

function comboToVialGui(entries: ComboEntry[]): (string | number)[][] {
  return entries.map((e) => [
    serializeKeycode(e.key1),
    serializeKeycode(e.key2),
    serializeKeycode(e.key3),
    serializeKeycode(e.key4),
    serializeKeycode(e.output),
  ])
}

function vialGuiToCombo(entries: (string | number)[][]): ComboEntry[] {
  return entries.map((e) => ({
    key1: toKeycode(e[0]),
    key2: toKeycode(e[1]),
    key3: toKeycode(e[2]),
    key4: toKeycode(e[3]),
    output: toKeycode(e[4]),
  }))
}

// --- Key override conversion ---

const KEY_OVERRIDE_ENABLED_BIT = 0x80

function keyOverrideToVialGui(
  entries: KeyOverrideEntry[],
): Record<string, unknown>[] {
  return entries.map((e) => ({
    trigger: serializeKeycode(e.triggerKey),
    replacement: serializeKeycode(e.replacementKey),
    layers: e.layers,
    trigger_mods: e.triggerMods,
    negative_mod_mask: e.negativeMods,
    suppressed_mods: e.suppressedMods,
    options: e.enabled ? (e.options | KEY_OVERRIDE_ENABLED_BIT) : (e.options & ~KEY_OVERRIDE_ENABLED_BIT),
  }))
}

function vialGuiToKeyOverride(
  entries: Record<string, unknown>[],
): KeyOverrideEntry[] {
  return entries.map((e) => {
    const rawOptions = (e.options as number) ?? 0
    return {
      triggerKey: toKeycode(e.trigger as string | number),
      replacementKey: toKeycode(e.replacement as string | number),
      layers: (e.layers as number) ?? 0xffff,
      triggerMods: (e.trigger_mods as number) ?? 0,
      negativeMods: (e.negative_mod_mask as number) ?? 0,
      suppressedMods: (e.suppressed_mods as number) ?? 0,
      options: rawOptions & ~KEY_OVERRIDE_ENABLED_BIT,
      enabled: (rawOptions & KEY_OVERRIDE_ENABLED_BIT) !== 0,
    }
  })
}

// --- Alt repeat key conversion ---

const ALT_REPEAT_KEY_ENABLED_BIT = 0x08

function altRepeatKeyToVialGui(
  entries: AltRepeatKeyEntry[],
): Record<string, unknown>[] {
  return entries.map((e) => ({
    keycode: serializeKeycode(e.lastKey),
    alt_keycode: serializeKeycode(e.altKey),
    allowed_mods: e.allowedMods,
    options: e.enabled ? (e.options | ALT_REPEAT_KEY_ENABLED_BIT) : (e.options & ~ALT_REPEAT_KEY_ENABLED_BIT),
  }))
}

function vialGuiToAltRepeatKey(
  entries: Record<string, unknown>[],
): AltRepeatKeyEntry[] {
  return entries.map((e) => {
    const rawOptions = (e.options as number) ?? 0
    return {
      lastKey: toKeycode(e.keycode as string | number),
      altKey: toKeycode(e.alt_keycode as string | number),
      allowedMods: (e.allowed_mods as number) ?? 0,
      options: rawOptions & ~ALT_REPEAT_KEY_ENABLED_BIT,
      enabled: (rawOptions & ALT_REPEAT_KEY_ENABLED_BIT) !== 0,
    }
  })
}

// --- QMK settings conversion ---

function qmkSettingsToVialGui(settings: Record<string, number[]>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, bytes] of Object.entries(settings)) {
    let value = 0
    for (let i = 0; i < bytes.length; i++) {
      value |= (bytes[i] & 0xff) << (i * 8)
    }
    result[key] = value
  }
  return result
}

function vialGuiToQmkSettings(settings: Record<string, number>): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (value === 0) {
      result[key] = [0]
    } else {
      const bytes: number[] = []
      let v = value
      while (v > 0) {
        bytes.push(v & 0xff)
        v = v >>> 8
      }
      result[key] = bytes
    }
  }
  return result
}

// --- Format detection ---

export function isVialGuiFile(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return Array.isArray(obj.layout) && 'version' in obj
}

// --- Export: VilFile → vial-gui JSON ---

export function vilToVialGuiJson(vil: VilFile, ctx: VilExportContext): string {
  const uid = uidHexToBigInt(vil.uid)

  const obj: Record<string, unknown> = {
    version: 1,
    uid: BIGINT_UID_PLACEHOLDER,
    layout: keymapToLayout(vil.keymap, ctx.layers, ctx.rows, ctx.cols),
    encoder_layout: encoderToVialGui(vil.encoderLayout, ctx.layers, ctx.encoderCount),
    layout_options: vil.layoutOptions,
    macro: ctx.macroActions,
    vial_protocol: ctx.vialProtocol,
    via_protocol: ctx.viaProtocol,
    tap_dance: tapDanceToVialGui(vil.tapDance),
    combo: comboToVialGui(vil.combo),
    key_override: keyOverrideToVialGui(vil.keyOverride),
    alt_repeat_key: altRepeatKeyToVialGui(vil.altRepeatKey),
    settings: qmkSettingsToVialGui(vil.qmkSettings),
  }

  return stringifyWithBigIntUid(obj, uid)
}

// --- Import: vial-gui JSON → VilFile ---

export function vialGuiToVil(
  data: Record<string, unknown>,
  rawJson: string,
  macroBuffer: number[],
): VilFile {
  const uid = extractUidFromJson(rawJson)
  const layout = data.layout as (string | number)[][][]
  const encoderLayout = data.encoder_layout as (string | number)[][][] | undefined
  const tapDance = data.tap_dance as (string | number)[][] | undefined
  const combo = data.combo as (string | number)[][] | undefined
  const keyOverride = data.key_override as Record<string, unknown>[] | undefined
  const altRepeatKey = data.alt_repeat_key as Record<string, unknown>[] | undefined
  const settings = data.settings as Record<string, number> | undefined

  return {
    uid,
    keymap: layoutToKeymap(layout),
    encoderLayout: encoderLayout ? vialGuiToEncoder(encoderLayout) : {},
    macros: macroBuffer,
    layoutOptions: (data.layout_options as number) ?? 0,
    tapDance: tapDance ? vialGuiToTapDance(tapDance) : [],
    combo: combo ? vialGuiToCombo(combo) : [],
    keyOverride: keyOverride ? vialGuiToKeyOverride(keyOverride) : [],
    altRepeatKey: altRepeatKey ? vialGuiToAltRepeatKey(altRepeatKey) : [],
    qmkSettings: settings ? vialGuiToQmkSettings(settings) : {},
  }
}
