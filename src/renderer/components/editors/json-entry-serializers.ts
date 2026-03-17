// SPDX-License-Identifier: GPL-2.0-or-later

import type { ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import { serialize, deserialize } from '../../../shared/keycodes/keycodes'
import { macroActionsToJson, jsonToMacroActions, type MacroAction } from '../../../preload/macro'

type TFunction = (key: string, opts?: Record<string, unknown>) => string

// --- Keycode validation ---

function isValidKeycode(kc: string): boolean {
  const code = deserialize(kc)
  return serialize(code) === kc || code !== 0 || kc === 'KC_NO'
}

// --- Combo ---

type ComboArray = [string, string, string, string, string]

export function comboToJson(entries: ComboEntry[]): string {
  const arr: ComboArray[] = entries.map((e) => [
    serialize(e.key1),
    serialize(e.key2),
    serialize(e.key3),
    serialize(e.key4),
    serialize(e.output),
  ])
  return JSON.stringify(arr, null, 2)
}

export function parseCombo(
  json: string,
  expectedLength: number,
  t: TFunction,
): { error: string | null; value?: ComboEntry[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: t('editor.combo.invalidJson') }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return { error: t('editor.combo.invalidJson') }
  }
  const entries: ComboEntry[] = []
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx]
    if (!Array.isArray(item) || item.length !== 5) {
      return { error: t('editor.combo.invalidEntry', { index: idx }) }
    }
    const fields = item as unknown[]
    for (const kc of fields) {
      if (typeof kc !== 'string') {
        return { error: t('editor.combo.invalidEntry', { index: idx }) }
      }
      if (!isValidKeycode(kc)) {
        return { error: t('editor.combo.unknownKeycode', { keycode: kc }) }
      }
    }
    entries.push({
      key1: deserialize(fields[0] as string),
      key2: deserialize(fields[1] as string),
      key3: deserialize(fields[2] as string),
      key4: deserialize(fields[3] as string),
      output: deserialize(fields[4] as string),
    })
  }
  return { error: null, value: entries }
}

// --- Key Override ---

export function keyOverrideToJson(entries: KeyOverrideEntry[]): string {
  const arr = entries.map((e) => ({
    triggerKey: serialize(e.triggerKey),
    replacementKey: serialize(e.replacementKey),
    layers: e.layers,
    triggerMods: e.triggerMods,
    negativeMods: e.negativeMods,
    suppressedMods: e.suppressedMods,
    options: e.options,
    enabled: e.enabled,
  }))
  return JSON.stringify(arr, null, 2)
}

export function parseKeyOverride(
  json: string,
  expectedLength: number,
  t: TFunction,
): { error: string | null; value?: KeyOverrideEntry[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: t('editor.keyOverride.invalidJson') }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return { error: t('editor.keyOverride.invalidJson') }
  }
  const entries: KeyOverrideEntry[] = []
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx] as Record<string, unknown>
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }

    const { triggerKey, replacementKey, layers, triggerMods, negativeMods, suppressedMods, options, enabled } = item

    // Validate keycodes
    if (typeof triggerKey !== 'string') {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (!isValidKeycode(triggerKey)) {
      return { error: t('editor.keyOverride.unknownKeycode', { keycode: triggerKey }) }
    }
    if (typeof replacementKey !== 'string') {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (!isValidKeycode(replacementKey)) {
      return { error: t('editor.keyOverride.unknownKeycode', { keycode: replacementKey }) }
    }

    // Validate numeric fields
    if (typeof layers !== 'number' || !Number.isInteger(layers) || layers < 0 || layers > 65535) {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (typeof triggerMods !== 'number' || !Number.isInteger(triggerMods) || triggerMods < 0 || triggerMods > 255) {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (typeof negativeMods !== 'number' || !Number.isInteger(negativeMods) || negativeMods < 0 || negativeMods > 255) {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (
      typeof suppressedMods !== 'number' ||
      !Number.isInteger(suppressedMods) ||
      suppressedMods < 0 ||
      suppressedMods > 255
    ) {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (typeof options !== 'number' || !Number.isInteger(options) || options < 0 || options > 127) {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }
    if (typeof enabled !== 'boolean') {
      return { error: t('editor.keyOverride.invalidEntry', { index: idx }) }
    }

    entries.push({
      triggerKey: deserialize(triggerKey),
      replacementKey: deserialize(replacementKey),
      layers: layers as number,
      triggerMods: triggerMods as number,
      negativeMods: negativeMods as number,
      suppressedMods: suppressedMods as number,
      options: options as number,
      enabled: enabled as boolean,
    })
  }
  return { error: null, value: entries }
}

// --- Alt Repeat Key ---

export function altRepeatKeyToJson(entries: AltRepeatKeyEntry[]): string {
  const arr = entries.map((e) => ({
    lastKey: serialize(e.lastKey),
    altKey: serialize(e.altKey),
    allowedMods: e.allowedMods,
    options: e.options,
    enabled: e.enabled,
  }))
  return JSON.stringify(arr, null, 2)
}

export function parseAltRepeatKey(
  json: string,
  expectedLength: number,
  t: TFunction,
): { error: string | null; value?: AltRepeatKeyEntry[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: t('editor.altRepeatKey.invalidJson') }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return { error: t('editor.altRepeatKey.invalidJson') }
  }
  const entries: AltRepeatKeyEntry[] = []
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx] as Record<string, unknown>
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { error: t('editor.altRepeatKey.invalidEntry', { index: idx }) }
    }

    const { lastKey, altKey, allowedMods, options, enabled } = item

    // Validate keycodes
    if (typeof lastKey !== 'string') {
      return { error: t('editor.altRepeatKey.invalidEntry', { index: idx }) }
    }
    if (!isValidKeycode(lastKey)) {
      return { error: t('editor.altRepeatKey.unknownKeycode', { keycode: lastKey }) }
    }
    if (typeof altKey !== 'string') {
      return { error: t('editor.altRepeatKey.invalidEntry', { index: idx }) }
    }
    if (!isValidKeycode(altKey)) {
      return { error: t('editor.altRepeatKey.unknownKeycode', { keycode: altKey }) }
    }

    // Validate numeric fields
    if (typeof allowedMods !== 'number' || !Number.isInteger(allowedMods) || allowedMods < 0 || allowedMods > 255) {
      return { error: t('editor.altRepeatKey.invalidEntry', { index: idx }) }
    }
    if (typeof options !== 'number' || !Number.isInteger(options) || options < 0 || options > 7) {
      return { error: t('editor.altRepeatKey.invalidEntry', { index: idx }) }
    }
    if (typeof enabled !== 'boolean') {
      return { error: t('editor.altRepeatKey.invalidEntry', { index: idx }) }
    }

    entries.push({
      lastKey: deserialize(lastKey),
      altKey: deserialize(altKey),
      allowedMods: allowedMods as number,
      options: options as number,
      enabled: enabled as boolean,
    })
  }
  return { error: null, value: entries }
}

// --- Macro ---

export function macroToJson(macros: MacroAction[][]): string {
  const arr = macros.map((actions) => JSON.parse(macroActionsToJson(actions)))
  return JSON.stringify(arr, null, 2)
}

export function parseMacro(
  json: string,
  expectedLength: number,
  t: TFunction,
): { error: string | null; value?: MacroAction[][] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: t('editor.macro.invalidJson') }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return { error: t('editor.macro.invalidJson') }
  }
  const macros: MacroAction[][] = []
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx]
    if (!Array.isArray(item)) {
      return { error: t('editor.macro.invalidMacroEntry', { index: idx }) }
    }
    const actions = jsonToMacroActions(JSON.stringify(item))
    if (actions === null) {
      return { error: t('editor.macro.invalidMacroEntry', { index: idx }) }
    }
    macros.push(actions)
  }
  return { error: null, value: macros }
}
