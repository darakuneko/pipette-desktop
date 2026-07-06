// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for View-Only mode documentation.
// Connects to the virtual "GPK60-63R Virtual" device (PIPETTE_VIRTUAL_DEVICE=only),
// enters view-only mode, and captures screenshots of each UI state. No real
// hardware required.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-view-only.ts

import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  launchCaptureApp,
  resetToEditorMode,
  waitForUnlockDialog,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R Virtual'

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const app = await launchCaptureApp()

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    // Connect to device
    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    // The virtual device resets to locked on every launch, so a viewMode
    // persisted from a prior helper run can surface the Unlock dialog via
    // the auto-restore effect before we click view-only-button ourselves.
    await waitForUnlockDialog(app, page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- View-Only Mode Screenshots ---')

    // Enter view-only mode via status bar button. Once unlocked, the app's
    // own pending-view-only effect completes the transition automatically.
    const viewOnlyBtn = page.locator('[data-testid="view-only-button"]')
    await viewOnlyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(app, page, viewOnlyBtn)
    await page.waitForTimeout(2000)

    // Wait for compact mode transition
    await dismissNotificationModal(page)

    // Resize to ~400px width for documentation screenshots
    await page.setViewportSize({ width: 400, height: 300 })
    await page.waitForTimeout(1000)

    // 1. View-only compact window — keyboard only, panel closed (default)
    await capture(page, 'view-only-compact')

    // 2. Open the controls panel by clicking the keyboard area
    const keyboardArea = page.locator('[data-testid="editor-content"]')
    await keyboardArea.click()
    await page.waitForTimeout(500)

    // 3. Controls panel open — shows Exit, Always on Top, Default/Fit Size, Base Layer
    await capture(page, 'view-only-controls')

    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
