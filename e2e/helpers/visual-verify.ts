// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Visual verification script for post-implementation app checks.
 *
 * Launches the Electron app in dev mode (requires a running Vite dev server),
 * connects to the designated TEST_DEVICE, captures a screenshot of the keymap
 * editor, enumerates keycode category tabs, and collects console
 * errors/warnings. Exits with code 1 if:
 *   - The test device is not connected
 *   - Console errors or unallowlisted warnings are detected
 *
 * Usage:
 *   Terminal 1: pnpm dev:linux   (or pnpm dev on macOS/Windows)
 *   Terminal 2: npx tsx e2e/helpers/visual-verify.ts
 *
 * Screenshots are saved to /tmp/vial-verify/
 */

import { _electron as electron } from '@playwright/test'
import type { ConsoleMessage, Page } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync } from 'node:fs'
import { TEST_DEVICE } from '../test-device.config'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCREENSHOT_DIR = '/tmp/vial-verify'

// Console warning patterns that are known-safe and should not cause failure.
// Add patterns here when a warning is investigated and deemed harmless.
const WARNING_ALLOWLIST: string[] = [
  // Example: 'React does not recognize the `someProp` prop'
]

interface VerifyOptions {
  /** Directory to save screenshots. Default: /tmp/vial-verify */
  screenshotDir?: string
  /** Timeout in ms to wait for elements. Default: 10000 */
  timeout?: number
}

interface TabResult {
  id: string
  label: string
  visible: boolean
  screenshotPath?: string
}

interface VerifyResult {
  connected: boolean
  tabs: TabResult[]
  keycodeCategories: string[]
  consoleErrors: string[]
  consoleWarnings: string[]
}

async function waitForVisible(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Find and click the TEST_DEVICE button with retry logic for HID release delay.
 * Mirrors the logic in test-device.ts but without Playwright test framework deps.
 */
async function connectTestDeviceForVerify(page: Page): Promise<boolean> {
  const escaped = TEST_DEVICE.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceList = page.locator('[data-testid="device-list"]')
    const noDeviceMsg = page.locator('[data-testid="no-device-message"]')

    await Promise.race([
      deviceList.waitFor({ state: 'visible', timeout: 15_000 }),
      noDeviceMsg.waitFor({ state: 'visible', timeout: 15_000 }),
    ])

    // Find the designated test device by exact product name match
    const deviceBtn = page
      .locator('[data-testid="device-button"]')
      .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) })

    const count = await deviceBtn.count()
    if (count > 0) {
      await deviceBtn.first().click()
      return await waitForVisible(page, '[data-testid="status-bar"]', 15_000)
    }

    // Device not found — wait for auto-detect polling to re-scan
    if (attempt < 2) {
      console.log(`[visual-verify] Device "${TEST_DEVICE.productName}" not found (attempt ${attempt + 1}/3), retrying...`)
      await page.waitForTimeout(3_000)
    }
  }

  return false
}

function isAllowlistedWarning(text: string): boolean {
  return WARNING_ALLOWLIST.some((pattern) => text.includes(pattern))
}

export async function verifyApp(options?: VerifyOptions): Promise<VerifyResult> {
  const screenshotDir = options?.screenshotDir ?? SCREENSHOT_DIR
  const timeout = options?.timeout ?? 10_000

  // Ensure screenshot directory exists
  if (!existsSync(screenshotDir)) {
    mkdirSync(screenshotDir, { recursive: true })
  }

  const consoleErrors: string[] = []
  const consoleWarnings: string[] = []

  // Launch Electron app — always uses dev renderer (ELECTRON_RENDERER_URL)
  // This script is designed to run alongside `pnpm dev:linux` / `pnpm dev`.
  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.cjs'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173',
    },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Collect console messages (filter allowlisted warnings)
  const onConsole = (msg: ConsoleMessage): void => {
    const text = msg.text()
    if (msg.type() === 'error') {
      consoleErrors.push(text)
    } else if (msg.type() === 'warning') {
      if (!isAllowlistedWarning(text)) {
        consoleWarnings.push(text)
      }
    }
  }
  page.on('console', onConsole)

  let connected = false
  const tabs: TabResult[] = []
  const keycodeCategories: string[] = []

  try {
    // Connect to the designated TEST_DEVICE with retry logic
    connected = await connectTestDeviceForVerify(page)

    if (!connected) {
      console.log(`[visual-verify] TEST_DEVICE "${TEST_DEVICE.productName}" not connected`)
      await page.screenshot({
        path: resolve(screenshotDir, 'no-device.png'),
        fullPage: true,
      })
      // Return early — caller (main) will handle the failure
    } else {
      // Wait for the editor content to render
      await waitForVisible(page, '[data-testid="editor-content"]', timeout)

      await page.waitForTimeout(500)

      const screenshotPath = resolve(screenshotDir, 'keymap.png')
      await page.screenshot({ path: screenshotPath, fullPage: true })
      tabs.push({ id: 'keymap', label: 'Keymap', visible: true, screenshotPath })

      // Enumerate keycode category tabs
      const categoryTabs = page.locator('[data-testid^="keycode-category-"]')
      const categoryCount = await categoryTabs.count()
      for (let i = 0; i < categoryCount; i++) {
        const text = await categoryTabs.nth(i).textContent()
        if (text) keycodeCategories.push(text.trim())
      }
    }
  } finally {
    page.off('console', onConsole)
    await app.close()
  }

  return {
    connected,
    tabs,
    keycodeCategories,
    consoleErrors,
    consoleWarnings,
  }
}

// --- CLI entry point ---

async function main(): Promise<void> {
  console.log('=== Pipette Visual Verification ===\n')

  const result = await verifyApp()

  // Report: connection status
  console.log(`Device: ${TEST_DEVICE.productName}`)
  console.log(`Connected: ${result.connected ? 'Yes' : 'No'}`)
  console.log('')

  if (!result.connected) {
    console.log(`*** VERIFICATION FAILED — test device "${TEST_DEVICE.productName}" not connected ***`)
    console.log(`Screenshots: ${SCREENSHOT_DIR}`)
    process.exit(1)
  }

  // Report: tab navigation
  console.log('Editor tabs:')
  for (const tab of result.tabs) {
    const status = tab.visible ? 'OK' : 'NOT VISIBLE'
    const screenshot = tab.screenshotPath ? ` -> ${tab.screenshotPath}` : ''
    console.log(`  [${status}] ${tab.label}${screenshot}`)
  }
  console.log('')

  // Report: keycode categories
  if (result.keycodeCategories.length > 0) {
    console.log(`Keycode categories (${result.keycodeCategories.length}):`)
    for (const cat of result.keycodeCategories) {
      console.log(`  - ${cat}`)
    }
    console.log('')
  }

  // Report: console errors
  if (result.consoleErrors.length > 0) {
    console.log(`Console ERRORS (${result.consoleErrors.length}):`)
    for (const err of result.consoleErrors) {
      console.log(`  [ERROR] ${err}`)
    }
    console.log('')
  }

  if (result.consoleWarnings.length > 0) {
    console.log(`Console WARNINGS (${result.consoleWarnings.length}):`)
    for (const w of result.consoleWarnings) {
      console.log(`  [WARN] ${w}`)
    }
    console.log('')
  }

  // Summary
  const errorCount = result.consoleErrors.length
  const warnCount = result.consoleWarnings.length
  const visibleTabs = result.tabs.filter((t) => t.visible).length
  const totalTabs = result.tabs.length

  console.log('--- Summary ---')
  console.log(`  Tabs: ${visibleTabs}/${totalTabs} visible`)
  console.log(`  Categories: ${result.keycodeCategories.length}`)
  console.log(`  Errors: ${errorCount}, Warnings: ${warnCount}`)
  console.log(`  Screenshots: ${SCREENSHOT_DIR}`)

  if (errorCount > 0 || warnCount > 0) {
    console.log('\n*** VERIFICATION FAILED — console errors/warnings detected ***')
    if (warnCount > 0) {
      console.log('  To allowlist a warning, add it to WARNING_ALLOWLIST in visual-verify.ts')
    }
    process.exit(1)
  }

  console.log('\n=== Verification complete ===')
}

main().catch((err: unknown) => {
  console.error('Visual verification failed:', err)
  process.exit(1)
})
