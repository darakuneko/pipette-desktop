// SPDX-License-Identifier: GPL-2.0-or-later
//
// The View-Only mode screenshots: the virtual keyboard's compact view-only
// window, with its controls panel closed and open.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/view-only.ts

import { VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import {
  captureNamed,
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  outputDirectory,
  prepareCapture,
  resetToEditorMode,
  waitForUnlockDialog,
} from '../common'
import { Page } from '../page'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME

describe('view-only screenshots', () => {
  it('captures the compact view-only window and its controls', async () => {
    const page = new Page()
    await prepareCapture(page)

    // Connect to device
    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    // The virtual keyboard is locked on every launch; a view mode restored
    // on connect can bring the Unlock dialog up before view-only-button is
    // clicked.
    await waitForUnlockDialog(page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- View-Only Mode Screenshots ---')

    // Enter view-only mode via status bar button. Once unlocked, the app's
    // own pending-view-only effect completes the transition automatically.
    const viewOnlyBtn = page.locator('[data-testid="view-only-button"]')
    await viewOnlyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(page, viewOnlyBtn)
    await page.waitForTimeout(2000)

    // Wait for compact mode transition
    await dismissNotificationModal(page)

    // Resize to ~400px width for documentation screenshots. The window is
    // resized (its page is the screenshot); the compact window's own size
    // stays when the app does not allow this one.
    await page.setViewportSize({ width: 400, height: 300 })
    await page.waitForTimeout(1000)

    // 1. View-only compact window — keyboard only, panel closed (default)
    await captureNamed(page, 'view-only-compact')

    // 2. Open the controls panel by clicking the keyboard area
    const keyboardArea = page.locator('[data-testid="editor-content"]')
    await keyboardArea.click()
    await page.waitForTimeout(500)

    // 3. Controls panel open — shows Exit, Always on Top, Default/Fit Size, Opacity, Base Layer
    await captureNamed(page, 'view-only-controls')

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
