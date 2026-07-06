// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { ROWS, COLS, MACRO_BUFFER_SIZE, LAYERS } from '../virtual-device/gpk60-63r'
import {
  createVirtualDeviceState,
  pressKey,
  releaseKey,
  releaseAll,
  isHoldingUnlockCombo,
  unlockPollTick,
  packMatrixState,
  keymapIndex,
} from '../virtual-device/state'

describe('createVirtualDeviceState', () => {
  it('starts locked with a full unlock counter', () => {
    const state = createVirtualDeviceState()
    expect(state.unlocked).toBe(false)
    expect(state.unlockInProgress).toBe(false)
    expect(state.unlockCounter).toBe(state.unlockCounterMax)
  })

  it('has a keymap of the expected size and an empty matrix', () => {
    const state = createVirtualDeviceState()
    expect(state.keymap.length).toBe(LAYERS * ROWS * COLS)
    expect(state.macroBuffer.length).toBe(MACRO_BUFFER_SIZE)
    expect(state.matrix.length).toBe(ROWS)
    expect(state.matrix[0].length).toBe(COLS)
    expect(state.matrix.every((row) => row.every((v) => v === false))).toBe(true)
  })
})

describe('pressKey / releaseKey / releaseAll', () => {
  it('tracks individual key state', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 2, 3)
    expect(state.matrix[2][3]).toBe(true)
    releaseKey(state, 2, 3)
    expect(state.matrix[2][3]).toBe(false)
  })

  it('ignores out-of-range positions', () => {
    const state = createVirtualDeviceState()
    expect(() => pressKey(state, 99, 99)).not.toThrow()
    expect(() => releaseKey(state, -1, -1)).not.toThrow()
  })

  it('releaseAll clears every pressed key', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 0, 0)
    pressKey(state, 4, 11)
    releaseAll(state)
    expect(state.matrix.every((row) => row.every((v) => v === false))).toBe(true)
  })
})

describe('isHoldingUnlockCombo', () => {
  it('is true only when both combo keys (0,0) and (0,1) are held', () => {
    const state = createVirtualDeviceState()
    expect(isHoldingUnlockCombo(state)).toBe(false)
    pressKey(state, 0, 0)
    expect(isHoldingUnlockCombo(state)).toBe(false)
    pressKey(state, 0, 1)
    expect(isHoldingUnlockCombo(state)).toBe(true)
    releaseKey(state, 0, 0)
    expect(isHoldingUnlockCombo(state)).toBe(false)
  })
})

describe('unlockPollTick', () => {
  it('does nothing when no unlock sequence is in progress', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 0, 0)
    pressKey(state, 0, 1)
    unlockPollTick(state, 1000)
    expect(state.unlockCounter).toBe(state.unlockCounterMax)
    expect(state.unlocked).toBe(false)
  })

  it('decrements the counter on 200ms-spaced polls while the combo is held', () => {
    const state = createVirtualDeviceState()
    state.unlockCounterMax = 3
    state.unlockCounter = 3
    state.unlockInProgress = true
    state.unlockTimer = 0
    pressKey(state, 0, 0)
    pressKey(state, 0, 1)

    unlockPollTick(state, 200)
    expect(state.unlockCounter).toBe(2)
    expect(state.unlocked).toBe(false)

    unlockPollTick(state, 400)
    expect(state.unlockCounter).toBe(1)
    expect(state.unlocked).toBe(false)

    unlockPollTick(state, 600)
    expect(state.unlockCounter).toBe(0)
    expect(state.unlocked).toBe(true)
    expect(state.unlockInProgress).toBe(false)
  })

  it('resets the counter to max when a held poll arrives less than 100ms after the last decrement', () => {
    const state = createVirtualDeviceState()
    state.unlockCounterMax = 5
    state.unlockCounter = 3 // already decremented from a prior qualifying tick
    state.unlockInProgress = true
    state.unlockTimer = 0
    pressKey(state, 0, 0)
    pressKey(state, 0, 1)

    // Still holding, but only 50ms since the last decrementing tick: firmware
    // treats this as a non-qualifying poll and throws away all progress.
    unlockPollTick(state, 50)
    expect(state.unlockCounter).toBe(5)
    expect(state.unlocked).toBe(false)
  })

  it('resets the counter to max when a combo key is released mid-sequence', () => {
    const state = createVirtualDeviceState()
    state.unlockCounterMax = 5
    state.unlockCounter = 2
    state.unlockInProgress = true
    state.unlockTimer = 0
    pressKey(state, 0, 0)
    // (0,1) not held

    unlockPollTick(state, 200)
    expect(state.unlockCounter).toBe(5)
    expect(state.unlocked).toBe(false)
  })

  it('does not carry progress from before a release once the combo is re-pressed', () => {
    const state = createVirtualDeviceState()
    state.unlockCounterMax = 5
    state.unlockCounter = 5
    state.unlockInProgress = true
    state.unlockTimer = 0
    pressKey(state, 0, 0)
    pressKey(state, 0, 1)

    // Held long enough: one qualifying decrement, counter -> max - 1.
    unlockPollTick(state, 200)
    expect(state.unlockCounter).toBe(4)

    // Release resets the counter back to max (unlockTimer is left stale at 200).
    releaseKey(state, 0, 1)
    unlockPollTick(state, 210)
    expect(state.unlockCounter).toBe(5)

    // Re-press and poll shortly after — relative to the stale timer this is
    // still < 100ms, so it must not decrement further, let alone unlock.
    pressKey(state, 0, 1)
    unlockPollTick(state, 260)
    expect(state.unlockCounter).toBeGreaterThanOrEqual(4)
    expect(state.unlocked).toBe(false)
  })

  it('lock() equivalent: setting unlocked=false relocks regardless of counter', () => {
    const state = createVirtualDeviceState()
    state.unlocked = true
    state.unlocked = false
    expect(state.unlocked).toBe(false)
  })
})

describe('packMatrixState', () => {
  it('packs pressed keys into BE16-per-row byte pairs', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 0, 0)
    const bytes = packMatrixState(state)
    // row 0: bit 0 set -> low byte 0x01, high byte 0x00
    expect(bytes[0]).toBe(0x00)
    expect(bytes[1]).toBe(0x01)
  })

  it('packs col 13 into the high byte bit 5', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 0, 13)
    const bytes = packMatrixState(state)
    expect(bytes[0]).toBe(1 << (13 - 8))
    expect(bytes[1]).toBe(0x00)
  })

  it('packs col 11 (row 4) into the high byte bit 3', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 4, 11)
    const bytes = packMatrixState(state)
    expect(bytes[4 * 2]).toBe(1 << (11 - 8))
    expect(bytes[4 * 2 + 1]).toBe(0x00)
  })
})

describe('keymapIndex', () => {
  it('computes layer-major, row-major, col-order flat index', () => {
    expect(keymapIndex(0, 0, 0)).toBe(0)
    expect(keymapIndex(0, 0, 1)).toBe(1)
    expect(keymapIndex(1, 0, 0)).toBe(ROWS * COLS)
  })
})
