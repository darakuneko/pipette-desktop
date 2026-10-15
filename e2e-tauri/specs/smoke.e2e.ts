// SPDX-License-Identifier: GPL-2.0-or-later
//
// Smoke tests of the Tauri build on the virtual keyboard (PIPETTE_VIRTUAL_DEVICE
// =only, so the device list does not depend on the hardware plugged in). The
// tests share one app session and run in order: each starts where the
// previous one left the window.

import { $, browser, expect } from '@wdio/globals'
import {
  closeKeyPopover,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  editorKey,
  HEX_INPUT_SELECTOR,
  openKeycodeHexInput,
  openToolsOverlay,
  UNLOCK_DIALOG_HEADING,
  virtualDevice,
} from '../helpers/app'

const UNLOCK_TIMEOUT_MS = 15_000
const KC_Z = '001D'
const KC_X = '001B'
/** The unlock combo of the virtual keyboard's definition. */
const UNLOCK_KEYS: [number, number][] = [[0, 0], [0, 1]]
/** A key the matrix tester shows pressed. */
const MATRIX_KEY = { row: 2, col: 3 }

describe('Tauri build smoke', () => {
  it('lists the virtual keyboard and opens its keymap editor, still locked', async () => {
    await connectVirtualKeyboard()

    // Powered on but locked, like a real Vial keyboard: no unlock prompt
    // until something needs it.
    await expect($(UNLOCK_DIALOG_HEADING)).not.toBeDisplayed()
    expect((await virtualDevice.getState()).unlocked).toBe(false)
  })

  it('writes a keycode from the key popover and reads it back from the keyboard after reconnecting', async () => {
    await openKeycodeHexInput(0, 0)
    const before = await $(HEX_INPUT_SELECTOR).getValue()
    const target = before.toUpperCase() === KC_Z ? KC_X : KC_Z

    await $(HEX_INPUT_SELECTOR).setValue(target)
    await $('[data-testid="popover-code-apply"]').click()
    await closeKeyPopover()

    // Reconnecting reloads the keymap from the device, which keeps it across
    // close and re-open like a powered keyboard.
    await $('[data-testid="disconnect-button"]').click()
    await $(EDITOR_SELECTOR).waitForDisplayed({ reverse: true })
    await connectVirtualKeyboard()

    await openKeycodeHexInput(0, 0)
    await expect($(HEX_INPUT_SELECTOR)).toHaveValue(target)
    await closeKeyPopover()
  })

  it('unlocks with the combo held on the virtual keyboard, then shows key presses in the matrix tester', async () => {
    await openToolsOverlay()
    // A short countdown, set before the dialog starts the unlock, so the
    // held combo unlocks within a few polls.
    await virtualDevice.setUnlockCounterMax(3)

    await $('[data-testid="overlay-matrix-toggle"]').click()
    await $(UNLOCK_DIALOG_HEADING).waitForDisplayed({ timeout: UNLOCK_TIMEOUT_MS })

    await virtualDevice.holdKeys(UNLOCK_KEYS)
    try {
      await $(UNLOCK_DIALOG_HEADING).waitForDisplayed({ reverse: true, timeout: UNLOCK_TIMEOUT_MS })
    } finally {
      await virtualDevice.releaseAll()
    }
    expect((await virtualDevice.getState()).unlocked).toBe(true)

    const key = editorKey(MATRIX_KEY.row, MATRIX_KEY.col)
    await virtualDevice.pressKey(MATRIX_KEY.row, MATRIX_KEY.col)
    await browser.waitUntil(async () => (await key.getAttribute('data-pressed')) === 'true', {
      timeoutMsg: 'the matrix tester did not show the pressed key',
    })
    await virtualDevice.releaseKey(MATRIX_KEY.row, MATRIX_KEY.col)
    await browser.waitUntil(async () => (await key.getAttribute('data-pressed')) === null, {
      timeoutMsg: 'the matrix tester did not show the key released',
    })
  })
})

// Checks of the app lifecycle, pending until the backend has what they need:
// the app config store (theme) and the single-instance and navigation guards.
describe('Tauri build lifecycle', () => {
  it('keeps the theme set in the settings across a restart')
  it('brings the first window forward when a second instance starts, and the second exits with 0')
  it('blocks navigation to an external page and window.open')
})
