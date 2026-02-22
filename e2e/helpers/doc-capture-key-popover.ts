// SPDX-License-Identifier: GPL-2.0-or-later

// Re-capture Key Popover screenshots for the operation guide.
// Connects to a real device and captures popover screenshots
// with sequential numbering matching the existing guide.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-key-popover.ts

import { _electron as electron } from '@playwright/test'
import type { Page, Locator } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}

async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
}

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}`)
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

    // Connect to device
    const deviceList = page.locator('[data-testid="device-list"]')
    try {
      await deviceList.waitFor({ state: 'visible', timeout: 10_000 })
    } catch {
      throw new Error('Device list not found')
    }

    const targetBtn = page
      .locator('[data-testid="device-button"]')
      .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })

    if (!(await isAvailable(targetBtn))) {
      throw new Error(`Device "${DEVICE_NAME}" not found`)
    }

    await targetBtn.click()
    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(2000)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)

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

    // Double-click a key to open the popover
    const keyLabel = editorContent.locator('svg text').first()
    if (!(await isAvailable(keyLabel))) {
      throw new Error('No key label found in layout')
    }

    await keyLabel.dblclick({ force: true })
    await page.waitForTimeout(500)

    const popover = page.locator('[data-testid="key-popover"]')
    if (!(await isAvailable(popover))) {
      throw new Error('Key popover did not open')
    }

    console.log('\n--- Key Popover Screenshots ---')

    // 32: Key tab (default, shows all mode buttons)
    await capture(page, '32-key-popover-key')

    // 33: Code tab
    await page.locator('[data-testid="popover-tab-code"]').click()
    await page.waitForTimeout(300)
    await capture(page, '33-key-popover-code')

    // 34: Mod Mask mode with modifier selected
    await page.locator('[data-testid="popover-tab-key"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="popover-mode-mod-mask"]').click()
    await page.waitForTimeout(300)
    const lSftBtn = page.locator('[data-testid="mod-LSft"]')
    if (await isAvailable(lSftBtn)) {
      await lSftBtn.click()
      await page.waitForTimeout(200)
    }
    await capture(page, '34-key-popover-modifier')

    // 35: LT mode with layer selector
    await page.locator('[data-testid="popover-mode-mod-mask"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="popover-mode-lt"]').click()
    await page.waitForTimeout(300)
    await capture(page, '35-key-popover-lt')

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
