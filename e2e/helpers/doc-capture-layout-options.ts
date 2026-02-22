// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Layout Options documentation.
// Loads a dummy JSON definition (vial003.json) that has layout options
// and captures screenshots of the Layout Options panel.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-layout-options.ts

import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const FIXTURE_PATH = resolve(PROJECT_ROOT, 'e2e/fixtures/vial003.json')

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
}

async function interceptFileDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    async ({ dialog }, fixturePath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fixturePath],
      })
    },
    FIXTURE_PATH,
  )
}

async function dismissNotificationModal(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="notification-modal-backdrop"]')
  if (!(await backdrop.isVisible())) return

  const closeBtn = page.locator('[data-testid="notification-modal-close"]')
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click()
  } else {
    await backdrop.click({ position: { x: 10, y: 10 } })
  }
  await page.waitForTimeout(500)
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app...')
  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page)
    await interceptFileDialog(app)

    const dummyBtn = page.locator('[data-testid="dummy-button"]')
    await dummyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await dummyBtn.click()

    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(2000)

    console.log('\n--- Layout Options Screenshots ---')

    await dismissNotificationModal(page)

    const layoutBtn = page.locator('button[aria-controls="layout-options-panel"]')
    if ((await layoutBtn.count()) === 0) {
      throw new Error('Layout options button not found — keyboard definition may not have layout options')
    }

    await layoutBtn.click()
    await page.waitForTimeout(500)
    await capture(page, 'layout-options-open')

    const selects = page.locator('#layout-options-panel select:not([aria-hidden="true"])')
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 })
      await page.waitForTimeout(500)
      await capture(page, 'layout-options-changed')
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
