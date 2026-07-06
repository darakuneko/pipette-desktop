// SPDX-License-Identifier: GPL-2.0-or-later
// Matrix / unlock state machine for the virtual GPK60-63R.
// The unlock sequence mirrors vial-qmk's vial.c vial_unlock_poll(): the
// keyboard only unlocks after the combo has been held continuously for
// unlockCounterMax poll ticks spaced >= 100ms apart.

import {
  LAYERS,
  ROWS,
  COLS,
  VIRTUAL_DEVICE_UNLOCK_COMBO,
  VIALRGB_SUPPORTED_EFFECTS,
  buildDefaultKeymap,
  buildDefaultMacroBuffer,
} from './gpk60-63r'

export interface VialRGBState {
  mode: number
  speed: number
  hue: number
  sat: number
  val: number
}

export interface VirtualDeviceState {
  keymap: Uint16Array
  macroBuffer: Uint8Array
  layoutOptions: number
  /** matrix[row][col] — true while the switch is held down. */
  matrix: boolean[][]
  unlocked: boolean
  unlockInProgress: boolean
  unlockCounter: number
  unlockCounterMax: number
  /** Timestamp (ms) of the last unlock poll tick that made progress. */
  unlockTimer: number
  rgb: VialRGBState
}

const UNLOCK_COUNTER_MAX_DEFAULT = 50
const UNLOCK_POLL_MIN_INTERVAL_MS = 100

function createMatrix(): boolean[][] {
  return Array.from({ length: ROWS }, () => new Array<boolean>(COLS).fill(false))
}

export function createVirtualDeviceState(): VirtualDeviceState {
  return {
    keymap: buildDefaultKeymap(),
    macroBuffer: buildDefaultMacroBuffer(),
    layoutOptions: 0,
    matrix: createMatrix(),
    unlocked: false,
    unlockInProgress: false,
    unlockCounter: UNLOCK_COUNTER_MAX_DEFAULT,
    unlockCounterMax: UNLOCK_COUNTER_MAX_DEFAULT,
    unlockTimer: 0,
    rgb: {
      mode: VIALRGB_SUPPORTED_EFFECTS[1] ?? 0,
      speed: 128,
      hue: 128,
      sat: 255,
      val: 128,
    },
  }
}

export function pressKey(state: VirtualDeviceState, row: number, col: number): void {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return
  state.matrix[row][col] = true
}

export function releaseKey(state: VirtualDeviceState, row: number, col: number): void {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return
  state.matrix[row][col] = false
}

export function releaseAll(state: VirtualDeviceState): void {
  for (const row of state.matrix) row.fill(false)
}

/** Returns true only while every key of the unlock combo is currently held. */
export function isHoldingUnlockCombo(state: VirtualDeviceState): boolean {
  return VIRTUAL_DEVICE_UNLOCK_COMBO.every(([row, col]) => state.matrix[row]?.[col] === true)
}

/**
 * Advance the unlock state machine by one poll tick, given the current
 * clock time (injected for testability — no Date.now() inside).
 * Ported from vial-qmk's vial_unlock_poll(), which uses a single if/else:
 * the counter only decrements when the combo is held AND >= 100ms elapsed
 * since the last decrementing tick; every other case — combo not held, or
 * held but polled too soon — resets the counter back to its max. This
 * enforces a *continuous* hold: any qualifying poll that doesn't land on a
 * held+elapsed tick throws away all prior progress, so a stale unlockTimer
 * left over from before a release can never grant free progress once the
 * combo is re-pressed (the release's own poll already reset the counter).
 * Reaching 0 unlocks the keyboard.
 */
export function unlockPollTick(state: VirtualDeviceState, now: number): void {
  if (!state.unlockInProgress) return

  if (isHoldingUnlockCombo(state) && now - state.unlockTimer >= UNLOCK_POLL_MIN_INTERVAL_MS) {
    state.unlockTimer = now
    state.unlockCounter--
    if (state.unlockCounter <= 0) {
      state.unlockCounter = 0
      state.unlocked = true
      state.unlockInProgress = false
    }
  } else {
    state.unlockCounter = state.unlockCounterMax
  }
}

/** Pack the matrix into the VIA switch-matrix-state byte layout (2 bytes per row, big-endian). */
export function packMatrixState(state: VirtualDeviceState): Uint8Array {
  const bytes = new Uint8Array(ROWS * 2)
  for (let row = 0; row < ROWS; row++) {
    let bits = 0
    for (let col = 0; col < COLS; col++) {
      if (state.matrix[row][col]) bits |= 1 << col
    }
    bytes[row * 2] = (bits >> 8) & 0xff
    bytes[row * 2 + 1] = bits & 0xff
  }
  return bytes
}

export function keymapIndex(layer: number, row: number, col: number): number {
  return (layer * ROWS + row) * COLS + col
}

/** Every unused/out-of-range keymap position resolves to KC_NO (0). */
export function isValidKeymapPosition(layer: number, row: number, col: number): boolean {
  return layer >= 0 && layer < LAYERS && row >= 0 && row < ROWS && col >= 0 && col < COLS
}
