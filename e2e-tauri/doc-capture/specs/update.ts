// SPDX-License-Identifier: GPL-2.0-or-later
//
// The in-app update screenshots: the update modal of the startup check, and
// the About tab of Settings after Check for updates found the same release.
// The release comes from the fake update server (update-capture.ts); the
// capture closes the modal with Not now and installs nothing.
//
// Settings is only reachable from the device-selector screen, where the app
// starts, so the whole capture happens there. The screenshots are cropped
// to the modal.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/update.ts

import { captureNamed, outputDirectory, prepareCapture } from '../common'
import { Page } from '../page'
import { offeredRelease } from '../update-capture'

/** The startup check waits 3 s after the window shows and the startup
 *  notices are done; with the startup of a slow runner on top. */
const UPDATE_MODAL_TIMEOUT_MS = 30_000

describe('In-app update screenshots', () => {
  it('captures the startup update modal and the About tab check', async () => {
    const page = new Page()
    await prepareCapture(page)
    const release = offeredRelease()

    console.log('\n--- Update modal ---')
    const modal = page.locator('[data-testid="update-modal"]')
    await modal.waitFor({ state: 'visible', timeout: UPDATE_MODAL_TIMEOUT_MS })
    const message = await page.locator('[data-testid="update-modal-message"]').textContent()
    if (!message?.includes(release)) throw new Error(`the update modal does not offer ${release}: ${message}`)
    await captureNamed(page, 'update-modal', { element: modal })

    await page.locator('[data-testid="update-modal-later"]').click()
    await modal.waitFor({ state: 'hidden', timeout: 10_000 })

    console.log('\n--- About tab: Check for updates ---')
    await page.locator('[data-testid="settings-button"]').click()
    const settings = page.locator('[data-testid="settings-modal"]')
    await settings.waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('[data-testid="settings-tab-about"]').click()
    await page.locator('[data-testid="about-update-check"]').click()
    const open = page.locator('[data-testid="about-update-open"]')
    await open.waitFor({ state: 'visible', timeout: UPDATE_MODAL_TIMEOUT_MS })
    const result = await page.locator('[data-testid="about-update-result"]').textContent()
    if (!result?.includes(release)) throw new Error(`the About tab does not offer ${release}: ${result}`)
    await captureNamed(page, 'about-update-check', { element: settings })

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
