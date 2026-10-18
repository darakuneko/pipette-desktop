// SPDX-License-Identifier: GPL-2.0-or-later
//
// The keycode palette's tab reorder mode: `keycode-tab-reorder.png`.
// Long-presses the Macro tab on the virtual keyboard and captures the
// palette in reorder mode — Macro selected, its tiles shown — in the
// default tab order (the session's userData directory is new, so no saved
// tab order or Key Label pack is in it).
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/keycode-tab-reorder.ts

import { VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import { captureNamed, connectToDevice, dismissNotificationModal, outputDirectory, prepareCapture } from '../common'
import { Page } from '../page'

/** Longer than the 500 ms long-press threshold (`use-keycode-tab-reorder.ts`). */
const LONG_PRESS_HOLD_MS = 800

describe('keycode tab reorder screenshot', () => {
  it('captures the keycode palette in reorder mode', async () => {
    const page = new Page()
    await prepareCapture(page)

    if (!(await connectToDevice(page, VIRTUAL_DEVICE_NAME))) {
      throw new Error(`Device "${VIRTUAL_DEVICE_NAME}" not found`)
    }
    await dismissNotificationModal(page)

    const tab = page.locator('[data-testid="tabbed-keycodes-root"] [data-keycode-tab="macro"]').first()
    const box = await tab.boundingBox()
    if (!box) {
      console.log('  [skip] Macro tab not found')
      return
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(LONG_PRESS_HOLD_MS)
    await page.mouse.up()
    // Park the pointer in the empty top-left corner so no hover style or
    // tooltip shows in the capture.
    await page.mouse.move(2, 2)

    const done = page.locator('[data-testid="keycode-tab-reorder-done"]')
    await done.waitFor({ state: 'visible', timeout: 5000 })
    await captureNamed(page, 'keycode-tab-reorder')
    await done.click()

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
