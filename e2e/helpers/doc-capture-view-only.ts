// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for View-Only mode documentation.
// Connects to a real device, enters view-only mode, and captures
// screenshots of each UI state. Requires a GPK60-63R to be connected.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-view-only.ts

import { _electron as electron } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dismissNotificationModal } from './doc-capture-common'

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
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

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

    console.log('\n--- View-Only Mode Screenshots ---')

    // Enter view-only mode via status bar button
    const viewOnlyBtn = page.locator('[data-testid="view-only-button"]')
    await viewOnlyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await viewOnlyBtn.click()
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
