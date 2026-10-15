// SPDX-License-Identifier: GPL-2.0-or-later
//
// Smoke tests of the Tauri build on the virtual keyboard (PIPETTE_VIRTUAL_DEVICE
// =only, so the device list does not depend on the hardware plugged in). The
// tests share one app session and run in order: each starts where the
// previous one left the window.

import { existsSync, readFileSync } from 'node:fs'
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
  waitForGone,
} from '../helpers/app'
import { appLogPath } from '../helpers/driver'

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
    await waitForGone(EDITOR_SELECTOR, 'the keymap editor stayed open after disconnecting')
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

/** Waits until the app's log has a line containing `text`. */
async function waitForLogLine(text: string): Promise<void> {
  const path = appLogPath()
  await browser.waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').includes(text), {
    timeoutMsg: `the app log has no line with "${text}"`,
  })
}

describe('Tauri build window guard', () => {
  it('keeps the window on the app when a page navigates away or opens a window', async () => {
    const appUrl = await browser.getUrl()
    const windows = await browser.getWindowHandles()

    await browser.execute(() => {
      window.location.href = 'https://example.com/e2e-navigation'
    })
    await waitForLogLine('blocked navigation to https://example.com/e2e-navigation')
    expect(await browser.getUrl()).toBe(appUrl)

    // window.open from a script stops at WebKit's popup blocker; a link with
    // a target clicked by the user reaches the window's new-window handler.
    await browser.execute(() => {
      const link = document.createElement('a')
      link.id = 'e2e-blank-link'
      link.href = 'https://example.com/e2e-new-window'
      link.target = '_blank'
      link.textContent = 'e2e link'
      Object.assign(link.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', fontSize: '32px' })
      document.body.append(link)
    })
    try {
      await $('#e2e-blank-link').click()
      await waitForLogLine('blocked a new window for https://example.com/e2e-new-window')
    } finally {
      await browser.execute(() => document.getElementById('e2e-blank-link')?.remove())
    }
    expect(await browser.getWindowHandles()).toEqual(windows)
    expect(await browser.getUrl()).toBe(appUrl)
  })
})

// Checks of the app lifecycle, pending until the backend has what they need:
// the app config store (theme) and the single-instance guard.
describe('Tauri build lifecycle', () => {
  it('keeps the theme set in the settings across a restart')
  it('brings the first window forward when a second instance starts, and the second exits with 0')
})
