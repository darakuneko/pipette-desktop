// SPDX-License-Identifier: GPL-2.0-or-later
//
// The QMK settings modal screenshot: the virtual keyboard's Tap-Hold
// Settings modal, with an edited field saved, while its "Saved"
// confirmation shows. The virtual keyboard keeps its QMK settings in memory
// only, so the saved edit is gone with the session.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/qmk-settings.ts

import { VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import {
  captureNamed,
  connectToDevice,
  dismissNotificationModal,
  isAvailable,
  outputDirectory,
  prepareCapture,
  resetToEditorMode,
  waitForUnlockDialog,
} from '../common'
import { Page } from '../page'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME

describe('QMK settings screenshots', () => {
  it('captures the Tap-Hold Settings modal after a save', async () => {
    const page = new Page()
    await prepareCapture(page)

    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    await waitForUnlockDialog(page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- QMK Settings Screenshots ---')

    const editorContent = page.locator('[data-testid="editor-content"]')

    // Switch to the Tap-Hold / Tap Dance keycode tab, where the Tap-Hold
    // Settings shortcut button lives next to Edit JSON.
    const tdTabBtn = editorContent.locator('button', { hasText: /^Tap-Hold \/ Tap Dance$/ })
    await tdTabBtn.first().waitFor({ state: 'visible', timeout: 10_000 })
    await tdTabBtn.first().click()
    await page.waitForTimeout(300)

    const tapHoldBtn = page.locator('[data-testid="tap-hold-settings-btn"]')
    if (!(await isAvailable(tapHoldBtn))) {
      throw new Error('tap-hold-settings-btn not found — the virtual device may not report a supported Tap-Hold qsid')
    }
    await tapHoldBtn.click()

    const modal = page.locator('[data-testid="tap-hold-settings-backdrop"]')
    await modal.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(500)

    // Edit the first number field (Tapping Term, qsid 7 — within the
    // virtual device's supported qsid range of 1-7,9-27) so Save has
    // something to write.
    const numberInput = modal.locator('input[type="number"]').first()
    await numberInput.waitFor({ state: 'visible', timeout: 10_000 })
    const currentValue = await numberInput.inputValue()
    const nextValue = String((parseInt(currentValue, 10) || 0) + 10)
    await numberInput.fill(nextValue)
    await page.waitForTimeout(200)

    const saveBtn = page.locator('[data-testid="qmk-save"]')
    await saveBtn.click()

    const saveStatus = page.locator('[data-testid="qmk-save-status"]')
    await saveStatus.waitFor({ state: 'visible', timeout: 10_000 })
    // "Saved" flashes for ~2s before fading back to idle — poll for the
    // text instead of a fixed wait so a slow HID round trip doesn't miss
    // the window entirely.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if ((await saveStatus.textContent())?.includes('Saved')) break
      await page.waitForTimeout(100)
    }

    await captureNamed(page, 'tap-hold-settings')

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
