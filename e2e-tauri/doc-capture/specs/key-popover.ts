// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Key Popover screenshots of the virtual keyboard, under the plain names
// the operation guide refers to: the layer sidebar, the Key and Code tabs,
// the Mod Mask and LT modes, and the Undo and Redo buttons.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/key-popover.ts

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

describe('key popover screenshots', () => {
  it('captures the key popover tabs, modes and undo / redo', async () => {
    const page = new Page()
    await prepareCapture(page)

    // Connect to device
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    // The virtual keyboard is locked on every launch; a view mode restored
    // on connect can bring the Unlock dialog up before anything is clicked.
    await waitForUnlockDialog(page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    // Ensure layer 0 and Basic tab
    const editorContent = page.locator('[data-testid="editor-content"]')
    const layer0Btn = editorContent.locator('button', { hasText: /^0$/ })
    if (await isAvailable(layer0Btn)) {
      await layer0Btn.first().click()
      await page.waitForTimeout(300)
    }
    const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
    if (await isAvailable(basicBtn)) {
      await basicBtn.first().click()
      await page.waitForTimeout(300)
    }

    // Double-click a key to open the popover. Resolve the key's own `<g
    // data-key-pos="row,col">` group by its literal row/col rather than by
    // DOM position (`.first()`) — selecting a key re-parents its group to
    // the end of the SVG for z-index stacking, so a position-based locator
    // silently starts pointing at a different physical key the moment the
    // popover opens. Pin down the row/col up front and keep addressing the
    // same key by that value for the rest of the run (needed below to
    // re-open the same key after Undo).
    const firstKey = editorContent.locator('[data-key-pos]').first()
    if (!(await isAvailable(firstKey))) {
      throw new Error('No key found in layout')
    }
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(300)
    const targetKeyPos = await firstKey.getAttribute('data-key-pos')
    const targetKey = editorContent.locator(`[data-key-pos="${targetKeyPos}"]`)

    await targetKey.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(500)

    const popover = page.locator('[data-testid="key-popover"]')
    if (!(await isAvailable(popover))) {
      throw new Error('Key popover did not open')
    }

    console.log('\n--- Key Popover Screenshots ---')

    // Layer sidebar (popover with layer buttons on the left)
    await captureNamed(page, 'key-popover-layer-sidebar')

    // Key tab (default, shows all mode buttons)
    await captureNamed(page, 'key-popover-key')

    // Code tab
    await page.locator('[data-testid="popover-tab-code"]').click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'key-popover-code')

    // Mod Mask mode with modifier selected
    await page.locator('[data-testid="popover-tab-key"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="popover-mode-mod-mask"]').click()
    await page.waitForTimeout(300)
    const lSftBtn = page.locator('[data-testid="mod-LSft"]')
    if (await isAvailable(lSftBtn)) {
      await lSftBtn.click()
      await page.waitForTimeout(200)
    }
    await captureNamed(page, 'key-popover-modifier')

    // LT mode with layer selector
    await page.locator('[data-testid="popover-mode-mod-mask"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="popover-mode-lt"]').click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'key-popover-lt')

    // Undo button visible after keycode change
    // Switch back to Key tab default mode, select a different keycode to trigger undo recording
    await page.locator('[data-testid="popover-mode-lt"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="popover-tab-key"]').click()
    await page.waitForTimeout(300)
    // Click the first keycode result to trigger handlePopoverKeycodeSelect → recordUndo
    const firstResult = page.locator('[data-testid^="popover-result-"]').first()
    if (await isAvailable(firstResult)) {
      await firstResult.click()
      await page.waitForTimeout(500)
    }
    // Undo button should now be visible at the bottom of the popover
    const undoBtn = page.locator('[data-testid="popover-undo"]')
    if (await isAvailable(undoBtn)) {
      await captureNamed(page, 'key-popover-undo')
    } else {
      console.warn('  [skip] undo button not visible — could not capture')
    }

    // Redo button visible after undo + re-open
    // Close the popover, undo via Ctrl+Z, then re-open the same key to show redo
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)
    if (await isAvailable(targetKey)) {
      await targetKey.dblclick({ force: true })
      await page.waitForTimeout(1000)
    }
    const redoBtn = page.locator('[data-testid="popover-redo"]')
    if (await isAvailable(redoBtn)) {
      await captureNamed(page, 'key-popover-redo')
    } else {
      console.warn('  [skip] redo button not visible — could not capture')
    }

    // Close popover
    const closeBtn = page.locator('[data-testid="popover-close"]')
    if (await isAvailable(closeBtn)) {
      await closeBtn.click()
      await page.waitForTimeout(300)
    }

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
