// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Typing Test documentation.
// Connects to the virtual "GPK60-63R Virtual" device (PIPETTE_VIRTUAL_DEVICE=only)
// and captures screenshots of each typing test mode and state. No real hardware
// required.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-typing-test.ts

import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  launchCaptureApp,
  resetToEditorMode,
  waitForTypingTestCountdown,
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

/** Applies the shared dataset-update banner on whichever Mode-modal tab is
 *  currently open, if it is showing. A no-op when no update is available. */
async function applyDatasetUpdateIfShown(page: Page): Promise<void> {
  const banner = page.locator('[data-testid="typing-dataset-update-banner"]')
  if (!(await banner.isVisible().catch(() => false))) return
  await page.locator('[data-testid="typing-dataset-update-button"]').click()
  await banner.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {
    console.log('  [warn] dataset update banner did not clear in time')
  })
  await page.waitForTimeout(500)
}

/** Opens the typing-test Mode modal (MonkeyType / Tatoeba / Aozora Bunko /
 *  File Import) and captures one screenshot per tab, plus a running-state
 *  shot of a Tatoeba pack's per-sentence lines. Downloads the Tatoeba
 *  `japanese` pack on demand for the shots and removes it again afterward if
 *  this run was the one that downloaded it, leaving the app as it found it.
 *  Requires the typing-test editor (not Typing View) to already be active. */
async function captureModeModalScreenshots(page: Page): Promise<void> {
  const languageSelector = page.locator('[data-testid="language-selector"]:not([disabled])')

  // The Settings panel (containing the Mode row) can be collapsed from a
  // prior session; expand it so the language-selector button is reachable.
  const collapsedPanel = page.locator('[data-testid="typing-settings-panel-collapsed"]')
  if (await collapsedPanel.isVisible().catch(() => false)) {
    await page.locator('[data-testid="typing-settings-panel-toggle"]').click()
    await page.waitForTimeout(300)
  }

  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)

  // MonkeyType tab (the modal may already open here if words/time/quote mode
  // was active, but select it explicitly for a deterministic starting point).
  await page.locator('[data-testid="language-tab-existing"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-mode-monkeytype')

  // Tatoeba tab — apply the update banner (populates the pack list on a
  // fresh profile, since Tatoeba ships no bundled languages) and make sure
  // the `japanese` pack is downloaded for the running-state shot below.
  await page.locator('[data-testid="language-tab-tatoeba"]').click()
  await page.waitForTimeout(500)
  await applyDatasetUpdateIfShown(page)

  let downloadedTatoebaJapaneseForShot = false
  const tatoebaJapaneseDownload = page.locator('[data-testid="language-download-japanese"]')
  if (await tatoebaJapaneseDownload.isVisible().catch(() => false)) {
    await tatoebaJapaneseDownload.click()
    await page.locator('[data-testid="language-delete-japanese"]').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
      console.log('  [warn] tatoeba japanese pack did not finish downloading in time')
    })
    downloadedTatoebaJapaneseForShot = true
    await page.waitForTimeout(300)
  } else {
    console.log('  [info] tatoeba japanese pack already downloaded (or not offered)')
  }
  // Clicking a mid-list download button auto-scrolls the pack list; snap it
  // back to the top so the Downloaded section leads the shot.
  await page.evaluate(() => {
    const list = document.querySelector('[role="dialog"] .overflow-y-auto')
    if (list) list.scrollTop = 0
  })
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-mode-tatoeba')

  // Aozora Bunko tab — apply its own update banner (populates the ~10.5k
  // work catalog), then search so the kana filter row and results both
  // render in frame.
  await page.locator('[data-testid="language-tab-aozora"]').click()
  await page.waitForTimeout(500)
  await applyDatasetUpdateIfShown(page)
  await page.locator('[data-testid="aozora-search"]').fill('太宰')
  await page.waitForTimeout(800)
  await capture(page, 'typing-test-mode-aozora')

  // Select the (now-downloaded) Tatoeba japanese pack so the reading window
  // renders its per-sentence lines and ⏎ end-of-line markers. Picking a row
  // switches mode and closes the modal — no explicit close needed. Keeping
  // this to a plain pack selection (rather than importing an Aozora work)
  // per the capture plan.
  await page.locator('[data-testid="language-tab-tatoeba"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="language-row-japanese"]').click()
  await page.waitForTimeout(800)
  await capture(page, 'typing-test-tatoeba-running')

  // Reopen the modal for the File Import tab shot.
  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)
  await page.locator('[data-testid="language-tab-import"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-mode-import')

  // Cleanup: restore MonkeyType / english (the pre-capture default mode).
  await page.locator('[data-testid="language-tab-existing"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="language-row-english"]').click()
  await page.waitForTimeout(500)

  // Remove the tatoeba japanese pack again if this run was the one that
  // downloaded it, so the machine is left as it was found. The dataset
  // manifest updates applied above are left in place — they are a cache.
  if (downloadedTatoebaJapaneseForShot) {
    await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
    await languageSelector.click()
    await page.waitForTimeout(400)
    await page.locator('[data-testid="language-tab-tatoeba"]').click()
    await page.waitForTimeout(300)
    const deleteBtn = page.locator('[data-testid="language-delete-japanese"]')
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click()
      await page.waitForTimeout(300)
    }
    await page.locator('[data-testid="language-modal-close"]').click()
    await page.waitForTimeout(300)
  }
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
    // persisted from a prior helper run (e.g. this script's own Typing View
    // ending state) can surface the Unlock dialog via the auto-restore
    // effect before we ever click anything ourselves.
    await waitForUnlockDialog(app, page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- Typing Test Screenshots ---')

    // resetToEditorMode above guarantees we start from the editor, so enter
    // Typing Test unconditionally.
    const typingTestView = page.locator('[data-testid="typing-test-view"]')
    const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
    await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(app, page, typingTestBtn)
    await page.waitForTimeout(1000)
    await dismissNotificationModal(page)

    // 1. Words mode — waiting state (explicitly select to avoid persisted config)
    await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
    // Entering Typing Test starts with a 3s countdown placeholder before the
    // word list renders; wait it out so mode clicks below land on real controls.
    await waitForTypingTestCountdown(page)
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

    // 6. Mode modal — MonkeyType / Tatoeba / Aozora Bunko / File Import tabs
    console.log('\n--- Typing Test Mode Modal ---')
    await captureModeModalScreenshots(page)

    // 7. Typing View — REC tab + Recording Consent modal
    console.log('\n--- Typing View REC Tab ---')

    // Exit typing test back to the editor so we can swap into Typing View
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
