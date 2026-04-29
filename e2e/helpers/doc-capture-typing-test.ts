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

    console.log('\n--- Typing Test Screenshots ---')

    // View-mode auto-restore may have launched directly into Typing View
    // from a prior screenshot run. The status bar's typing-test-button
    // is hidden in that mode, so detect and exit back to the editor
    // before the typing-test-button waitFor below.
    const typingTestBtnEarly = page.locator('[data-testid="typing-test-button"]')
    if (!(await typingTestBtnEarly.isVisible().catch(() => false))) {
      console.log('  [reset] Typing View detected on startup, exiting back to editor...')
      // Open the menu pane (popup is closed by default after launch) so
      // the view-only-toggle becomes interactive.
      await page.locator('body').click({ position: { x: 400, y: 300 } })
      await page.waitForTimeout(400)
      const viewOnlyExit = page.locator('[data-testid="view-only-toggle"]')
      if (await viewOnlyExit.isVisible().catch(() => false)) {
        await viewOnlyExit.click({ force: true })
        await page.waitForTimeout(800)
      } else {
        console.log('  [warn] view-only-toggle not found; aborting')
      }
    }

    // Per-keyboard view mode auto-restore may have entered typing test already.
    // Only click the button when we are still in the editor.
    const typingTestView = page.locator('[data-testid="typing-test-view"]')
    const alreadyInTypingTest = await typingTestView.isVisible().catch(() => false)
    if (!alreadyInTypingTest) {
      const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
      await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
      await typingTestBtn.click()
      await page.waitForTimeout(1000)
      await dismissNotificationModal(page)
    }

    // 1. Words mode — waiting state (explicitly select to avoid persisted config)
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

    // 6. Typing View — REC tab + Recording Consent modal
    console.log('\n--- Typing View REC Tab ---')

    // Exit typing test back to the editor so we can swap into Typing View
    const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
    if (await typingTestBtn.isVisible().catch(() => false)) {
      await typingTestBtn.click()
      await page.waitForTimeout(500)
    }

    const typingViewBtn = page.locator('[data-testid="view-only-button"]')
    if (await typingViewBtn.isVisible().catch(() => false)) {
      await typingViewBtn.click()
      await page.waitForTimeout(900)

      // Typing View shrinks the window to compact size; force it back
      // to a doc-friendly viewport so the menu pane fits on screen.
      await page.setViewportSize({ width: 1320, height: 960 })
      await page.waitForTimeout(500)

      // Open the menu pane by clicking anywhere on the keyboard area
      const viewPanel = page.locator('#view-only-panel')
      if (!(await viewPanel.isVisible().catch(() => false))) {
        await page.locator('body').click({ position: { x: 400, y: 300 } })
        await page.waitForTimeout(400)
      }

      const recTab = page.locator('[data-testid="menu-tab-rec"]')
      if (await recTab.isVisible().catch(() => false)) {
        // Typing View opens in a compact window that may push the menu
        // pane outside Playwright's viewport. Bypass the actionability
        // check entirely by dispatching a synthetic click via the DOM.
        await page.evaluate(() => {
          document.querySelector<HTMLButtonElement>('[data-testid="menu-tab-rec"]')?.click()
        })
        await page.waitForTimeout(400)
        await capture(page, 'typing-test-rec-tab')

        // Toggle Start to surface the consent modal. Cancel it after
        // the screenshot so REC stays off and no analytics are written.
        const recordToggle = page.locator('[data-testid="typing-record-toggle"]')
        if (await recordToggle.isVisible().catch(() => false)) {
          await page.evaluate(() => {
            document.querySelector<HTMLButtonElement>('[data-testid="typing-record-toggle"]')?.click()
          })
          const consentModal = page.locator('[data-testid="typing-consent-modal"]')
          if (await consentModal.isVisible().catch(() => false)) {
            const consentPath = resolve(SCREENSHOT_DIR, 'typing-test-rec-consent.png')
            await consentModal.screenshot({ path: consentPath })
            console.log('  [ok] typing-test-rec-consent.png')

            const cancelBtn = page.locator('[data-testid="typing-consent-cancel"]')
            if (await cancelBtn.isVisible().catch(() => false)) {
              await page.evaluate(() => {
                document.querySelector<HTMLButtonElement>('[data-testid="typing-consent-cancel"]')?.click()
              })
              await page.waitForTimeout(300)
            }
          } else {
            console.log('  [warn] typing-consent-modal did not appear (consent may already be accepted)')
          }
        } else {
          console.log('  [warn] typing-record-toggle not found')
        }
      } else {
        console.log('  [warn] menu-tab-rec not found')
      }
    } else {
      console.log('  [skip] typing-view-button not found — REC tab capture skipped')
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
