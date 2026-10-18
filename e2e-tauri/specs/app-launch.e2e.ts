// SPDX-License-Identifier: GPL-2.0-or-later
//
// The device selector at launch: one window with a title, the app's name,
// the Select Device list with the virtual keyboard found without any
// permission prompt, and its vendor:product ID on its button. Connecting
// to it is in smoke.e2e.ts.

import { $, $$, browser, expect } from '@wdio/globals'
import { tid, VIRTUAL_DEVICE_NAME } from '../helpers/app'

/** The vendor and product IDs of the virtual keyboard
 *  (crates/pipette-virtual-device), as the device button shows them. */
const VIRTUAL_DEVICE_ID = '7a79:f063'
const LIST_TIMEOUT_MS = 20_000

describe('Tauri build launch', () => {
  it('opens one window with a title', async () => {
    expect(await browser.getWindowHandles()).toHaveLength(1)
    expect(await browser.getTitle()).toBeTruthy()
  })

  it('shows the device selector with the Select Device list', async () => {
    await $('h1=Pipette').waitForDisplayed({ timeout: LIST_TIMEOUT_MS })
    // The heading is drawn upper-case by CSS; the XPath matches its text.
    await $('//p[normalize-space()="Select Device"]').waitForDisplayed()
  })

  it('lists the virtual keyboard with its vendor:product ID', async () => {
    await $(tid('device-list')).waitForDisplayed({ timeout: LIST_TIMEOUT_MS })
    let ids: Record<string, string> = {}
    await browser.waitUntil(
      async () => {
        ids = await browser.execute(
          (button: string, name: string, id: string) =>
            Object.fromEntries(
              [...document.querySelectorAll(button)].map((el) => [
                el.querySelector(name)?.textContent ?? '',
                el.querySelector(id)?.textContent ?? '',
              ]),
            ),
          tid('device-button'),
          '.font-semibold',
          tid('device-id'),
        )
        return VIRTUAL_DEVICE_NAME in ids
      },
      { timeout: LIST_TIMEOUT_MS, timeoutMsg: `"${VIRTUAL_DEVICE_NAME}" did not appear in the device list` },
    )
    expect(await $$(tid('device-button')).length).toBe(1)
    expect(await $(tid('no-device-message')).isExisting()).toBe(false)
    expect(ids[VIRTUAL_DEVICE_NAME]).toBe(VIRTUAL_DEVICE_ID)
  })
})
