// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Typing Test documentation.
// Connects to a real device and captures screenshots of each typing test
// mode and state. Requires a GPK60-63R to be connected.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-typing-test.ts

import { _electron as electron } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
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

async function waitForUnlockDialog(page: Page): Promise<void> {
  const unlockHeading = page.locator('h2', { hasText: /Unlock|unlock|アンロック/ })
  if ((await unlockHeading.count()) === 0) return

  console.log('  Unlock dialog detected — waiting for physical unlock (up to 60s)...')
  try {
    await unlockHeading.waitFor({ state: 'detached', timeout: 60_000 })
    console.log('  Keyboard unlocked!')
    await page.waitForTimeout(500)
  } catch {
    console.log('  [warn] Unlock timed out')
  }
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
  await page.setViewportSize({ width: 1320, height: 900 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page)

    // Connect to device
    console.log(`Looking for ${DEVICE_NAME}...`)
    const deviceBtn = page
      .locator('[data-testid="device-button"]')
      .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })
    await deviceBtn.waitFor({ state: 'visible', timeout: 30_000 })
    await deviceBtn.click()

    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(2000)

    await dismissNotificationModal(page)
    await waitForUnlockDialog(page)
    await dismissNotificationModal(page)

    console.log('\n--- Typing Test Screenshots ---')

    // Enter typing test mode via status bar button
    const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
    await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await typingTestBtn.click()
    await page.waitForTimeout(1000)
    await dismissNotificationModal(page)

    // 1. Words mode — waiting state (explicitly select to avoid persisted config)
    const typingTestView = page.locator('[data-testid="typing-test-view"]')
    await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('[data-testid="mode-words"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-words-waiting')

    // 2. Time mode
    await page.locator('[data-testid="mode-time"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-time-mode')

    // 3. Quote mode
    await page.locator('[data-testid="mode-quote"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-quote-mode')

    // 4. Words mode with options (punctuation + numbers enabled)
    await page.locator('[data-testid="mode-words"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="toggle-punctuation"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="toggle-numbers"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-words-options')

    // Reset options back
    await page.locator('[data-testid="toggle-punctuation"]').click()
    await page.locator('[data-testid="toggle-numbers"]').click()
    await page.waitForTimeout(300)

    // 5. Running state — type a few characters to start the test
    // Focus is managed by the component via hidden textarea
    await page.keyboard.type('the ', { delay: 80 })
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-running')

    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
