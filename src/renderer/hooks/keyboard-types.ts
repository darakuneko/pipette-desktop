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
  // True once unlockStatus reflects a real device answer (or a forced
  // VIA-only/dummy/pipette-file unlocked state) rather than the initial
  // placeholder. A failed getUnlockStatus() leaves this false, so callers
  // must never treat "not known" as "confirmed locked".
  unlockStatusKnown: boolean
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
  // Bumped by `applyVilFile` on every successful restore (snapshot / layout
  // store / .vil import all converge there — Plan-qwerty-select-no-rewrite
  // §snapshot/.vil 復元時のクリーンアップ). App.tsx watches this counter to
  // clear the keymap undo/redo history and close a stray Keyboard Layout
  // apply-confirm modal — both things that KeymapEditor's own uid/keymap-size
  // clear effect misses because a restore keeps the same uid and never
  // empties the keymap.
  // Monotonic for the whole app session: `reset()` (disconnect) carries
  // the current value forward instead of zeroing it via `emptyState()`,
  // so consumers can watch for a plain change rather than an increase.
  keymapRestoreSeq: number
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
    unlockStatusKnown: false,
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
    keymapRestoreSeq: 0,
  }
}

export function isEchoDetected(err: unknown): boolean {
  return err instanceof Error && err.message.includes(ECHO_DETECTED_MSG)
}

export interface BootGuardRef {
  onUnlock: (() => void) | null
}

export type SetState = React.Dispatch<React.SetStateAction<KeyboardState>>

export type ReloadResult =
  | { ok: true; uid: string }
  | { ok: false; reason: 'notVial' | 'loadFailed' }

/** Outcome of `applyVilFile`. `rolledBack` is only meaningful when
 *  `ok: false`: `true` means the pre-apply backup was written back to the
 *  device without a further HID error — not a guaranteed byte-exact
 *  restore. The rollback only rewrites the positions/entries the backup
 *  itself held, so it assumes the applied file and the device share the
 *  same shape (the same keyboard); `false` means the restore write itself
 *  also failed — the device and the screen may now disagree, and the
 *  caller must tell the user rather than silently treating it as a normal
 *  load failure. */
export type ApplyVilResult =
  | { ok: true }
  | { ok: false; rolledBack: boolean }

/** Maps a failed `applyVilFile` result to the i18n key describing whether
 *  the device was restored. Every call site that surfaces an
 *  `ApplyVilResult` failure to the user (useFileIO, useLayoutStore) shares
 *  this instead of re-deriving the same ternary, so the two keys can't
 *  drift out of sync between call sites. */
export function applyVilErrorKey(r: Extract<ApplyVilResult, { ok: false }>): 'error.applyRolledBack' | 'error.applyNotRolledBack' {
  return r.rolledBack ? 'error.applyRolledBack' : 'error.applyNotRolledBack'
}

export interface KeyboardRefs {
  stateRef: React.MutableRefObject<KeyboardState>
  qmkSettingsBaselineRef: React.MutableRefObject<Record<string, number[]>>
  saveLayerNamesRef: React.MutableRefObject<((names: string[]) => void) | null>
}
