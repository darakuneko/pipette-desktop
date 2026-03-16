// SPDX-License-Identifier: GPL-2.0-or-later

import type React from 'react'
import type {
  KeyboardDefinition,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
  DynamicEntryCounts,
  UnlockStatus,
} from '../../shared/types/protocol'
import type { MacroAction } from '../../preload/macro'
import type { KeyboardLayout } from '../../shared/kle/types'
import { EMPTY_UID, ECHO_DETECTED_MSG } from '../../shared/constants/protocol'

export interface BulkKeyEntry {
  layer: number
  row: number
  col: number
  keycode: number
}

export interface KeyboardState {
  loading: boolean
  loadingProgress: string
  connectionWarning: string | null
  isDummy: boolean
  viaProtocol: number
  vialProtocol: number
  uid: string
  definition: KeyboardDefinition | null
  layout: KeyboardLayout | null
  layers: number
  rows: number
  cols: number
  keymap: Map<string, number> // "layer,row,col" -> keycode
  encoderLayout: Map<string, number> // "layer,idx,dir" -> keycode
  encoderCount: number
  layoutOptions: number
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  parsedMacros: MacroAction[][] | null
  dynamicCounts: DynamicEntryCounts
  tapDanceEntries: TapDanceEntry[]
  comboEntries: ComboEntry[]
  keyOverrideEntries: KeyOverrideEntry[]
  altRepeatKeyEntries: AltRepeatKeyEntry[]
  unlockStatus: UnlockStatus
  // QMK Backlight
  backlightBrightness: number
  backlightEffect: number
  // QMK RGBlight
  rgblightBrightness: number
  rgblightEffect: number
  rgblightEffectSpeed: number
  rgblightHue: number
  rgblightSat: number
  // VialRGB
  vialRGBVersion: number
  vialRGBMaxBrightness: number
  vialRGBSupported: number[]
  vialRGBMode: number
  vialRGBSpeed: number
  vialRGBHue: number
  vialRGBSat: number
  vialRGBVal: number
  // QMK Settings
  supportedQsids: Set<number>
  // QMK Settings snapshot for .vil serialization
  qmkSettingsValues: Record<string, number[]>
  // Layer names (persisted per-UID, synced)
  layerNames: string[]
}

export function emptyState(): KeyboardState {
  return {
    loading: false,
    loadingProgress: '',
    connectionWarning: null,
    isDummy: false,
    viaProtocol: -1,
    vialProtocol: -1,
    uid: EMPTY_UID,
    definition: null,
    layout: null,
    layers: 0,
    rows: 0,
    cols: 0,
    keymap: new Map(),
    encoderLayout: new Map(),
    encoderCount: 0,
    layoutOptions: -1,
    macroCount: 0,
    macroBufferSize: 0,
    macroBuffer: [],
    parsedMacros: null,
    dynamicCounts: { tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 },
    tapDanceEntries: [],
    comboEntries: [],
    keyOverrideEntries: [],
    altRepeatKeyEntries: [],
    unlockStatus: { unlocked: false, inProgress: false, keys: [] },
    backlightBrightness: 0,
    backlightEffect: 0,
    rgblightBrightness: 0,
    rgblightEffect: 0,
    rgblightEffectSpeed: 0,
    rgblightHue: 0,
    rgblightSat: 0,
    vialRGBVersion: -1,
    vialRGBMaxBrightness: 255,
    vialRGBSupported: [],
    vialRGBMode: 0,
    vialRGBSpeed: 0,
    vialRGBHue: 0,
    vialRGBSat: 0,
    vialRGBVal: 0,
    supportedQsids: new Set(),
    qmkSettingsValues: {},
    layerNames: [],
  }
}

export function isEchoDetected(err: unknown): boolean {
  return err instanceof Error && err.message.includes(ECHO_DETECTED_MSG)
}

export type SetState = React.Dispatch<React.SetStateAction<KeyboardState>>

export interface KeyboardRefs {
  stateRef: React.MutableRefObject<KeyboardState>
  qmkSettingsBaselineRef: React.MutableRefObject<Record<string, number[]>>
  saveLayerNamesRef: React.MutableRefObject<((names: string[]) => void) | null>
}
