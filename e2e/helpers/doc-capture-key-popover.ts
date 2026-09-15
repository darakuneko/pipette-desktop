// SPDX-License-Identifier: GPL-2.0-or-later

// Re-capture Key Popover screenshots for the operation guide.
// Connects to the virtual "Virtual Keyboard" device (PIPETTE_VIRTUAL_DEVICE=only)
// and captures popover screenshots under the plain names referenced by the
// guide. No real hardware required.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-key-popover.ts

import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connectToDevice,
  dismissNotificationModal,
  isAvailable,
  launchCaptureApp,
  resetToEditorMode,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  waitForUnlockDialog,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}`)
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const app = await launchCaptureApp()

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    // Connect to device
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    // The virtual device resets to locked on every launch, so a viewMode
    // persisted from a prior helper run can surface the Unlock dialog via
    // the auto-restore effect before we interact with anything ourselves.
    await waitForUnlockDialog(app, page)
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
    await capture(page, 'key-popover-layer-sidebar')

    // Key tab (default, shows all mode buttons)
    await capture(page, 'key-popover-key')

    // Code tab
    await page.locator('[data-testid="popover-tab-code"]').click()
    await page.waitForTimeout(300)
    await capture(page, 'key-popover-code')

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
    await capture(page, 'key-popover-modifier')

    // LT mode with layer selector
    await page.locator('[data-testid="popover-mode-mod-mask"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="popover-mode-lt"]').click()
    await page.waitForTimeout(300)
    await capture(page, 'key-popover-lt')

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
      await capture(page, 'key-popover-undo')
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
      await capture(page, 'key-popover-redo')
    } else {
      console.warn('  [skip] redo button not visible — could not capture')
    }

    // Close popover
    const closeBtn = page.locator('[data-testid="popover-close"]')
    if (await isAvailable(closeBtn)) {
      await closeBtn.click()
      await page.waitForTimeout(300)
    }

    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
