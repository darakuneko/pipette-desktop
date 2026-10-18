// SPDX-License-Identifier: GPL-2.0-or-later
//
// A retake of three Analyze views without the rest of the main capture:
//  - analyze-by-app: needs a 10s settle for the recharts donut animation
//  - analyze-ergonomics-learning: needs an older keymap snapshot selected
//    so the active range covers the seeded historical matrix-minute data
//  - analyze-footer: the docked footer bar with Split View on
// The typing analytics seed is the main capture's, so Analyze shows the
// same dummy keyboard.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/analyze-fix.ts

import { restartApp } from '../../helpers/app'
import { DUMMY_TA_UID, seedDummyTypingAnalytics } from '../../helpers/analyze-seed'
import { userDataPath } from '../../helpers/driver'
import {
  captureNamed,
  outputDirectory,
  prepareCapture,
  selectKeyboardViaFilterModal,
  selectSnapshotViaFilterModal,
  waitForMachineHash,
  waitForSeededAnalytics,
} from '../common'
import { Page, type Locator } from '../page'

async function isAvailable(locator: Locator, timeoutMs = 5000): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

async function openAnalyzePage(page: Page): Promise<boolean> {
  const analyzeTab = page.locator('[data-testid="tab-analyze"]')
  if (!(await isAvailable(analyzeTab))) {
    console.log('  [skip] tab-analyze not found')
    return false
  }
  await analyzeTab.click()
  await page.waitForTimeout(500)

  const analyzePage = page.locator('[data-testid="analyze-page"]')
  if (!(await isAvailable(analyzePage))) {
    console.log('  [skip] analyze-page did not open')
    return false
  }

  // Keyboard selection lives in the staged filter modal behind the
  // summary chip (chip -> keyboard select -> Apply). Select the seeded
  // dummy keyboard explicitly (not "whichever sorts first"). The helper
  // polls for the option since the cache rebuild from JSONL masters can
  // take a few seconds after launch.
  const selected = await selectKeyboardViaFilterModal(page, DUMMY_TA_UID)
  if (!selected) {
    console.log('  [warn] seeded keyboard not selectable in Analyze — abort')
    return false
  }
  return true
}

async function captureByApp(page: Page): Promise<void> {
  const byAppTab = page.locator('[data-testid="analyze-tab-byApp"]')
  if (!(await isAvailable(byAppTab))) {
    console.log('  [skip] analyze-tab-byApp not found')
    return
  }
  await byAppTab.click()
  // 10s settles the recharts donut animation; capturing earlier
  // freezes the slices mid-unfold.
  await page.waitForTimeout(10_000)
  await captureNamed(page, 'analyze-by-app')
}

async function captureErgonomicsLearning(page: Page): Promise<void> {
  const ergonomicsTab = page.locator('[data-testid="analyze-tab-ergonomics"]')
  if (!(await isAvailable(ergonomicsTab))) {
    console.log('  [skip] analyze-tab-ergonomics not found')
    return
  }
  await ergonomicsTab.click()
  await page.waitForTimeout(800)

  const viewModeSelect = page.locator('[data-testid="analyze-filter-ergonomics-view-mode"]')
  if (!(await isAvailable(viewModeSelect))) {
    console.log('  [skip] analyze-filter-ergonomics-view-mode not found')
    return
  }
  await viewModeSelect.selectOption('learning')
  await page.waitForTimeout(800)

  // Pivot to the older snapshot through the staged filter modal (chip ->
  // Keymap row -> Apply) so the range expands to cover the historical
  // matrix-minute rows seeded by analyze-seed.ts. Without this the chart
  // renders the empty state.
  const pivoted = await selectSnapshotViaFilterModal(page, 1, { settleMs: 1500 })
  if (!pivoted) {
    console.log('  [warn] only one snapshot present — learning curve may render empty')
  }

  await captureNamed(page, 'analyze-ergonomics-learning')

  if (pivoted) {
    await selectSnapshotViaFilterModal(page, 0, { settleMs: 400 })
  }
  await viewModeSelect.selectOption('snapshot').catch(() => { /* best effort */ })
}

/** Captures the docked footer bar with Split View turned on, so the shot
 *  shows both the footer's own visual treatment (full-bleed, distinct
 *  from the scrollable content above it) and what Split View actually
 *  does — a second, independent Analyze pane next to the first. The
 *  page (1440px) is above the 1280px width floor the toggle requires to be
 *  enabled at all. Toggled back off afterward. */
async function captureFooter(page: Page): Promise<void> {
  const splitToggle = page.locator('[data-testid="analyze-split-toggle"]')
  if (!(await isAvailable(splitToggle))) {
    console.log('  [skip] analyze-split-toggle not found')
    return
  }
  await splitToggle.click()
  await page.waitForTimeout(800)
  await captureNamed(page, 'analyze-footer')
  await splitToggle.click().catch(() => { /* best effort */ })
  await page.waitForTimeout(300)
}

describe('Analyze retake screenshots', () => {
  it('captures the By App, ergonomics learning and footer views', async () => {
    const page = new Page()

    // The seed reads this device's machine hash, which the first launch
    // wrote, and removes sync_state.json so the next launch rebuilds the
    // cache from the seeded days.
    await waitForMachineHash()
    await restartApp(async () => {
      const taBackup = await seedDummyTypingAnalytics(userDataPath(), Date.now())
      console.log(`Seeded dummy typing-analytics: uid=${DUMMY_TA_UID}, history=${taBackup.historicalJsonlPaths.length} days`)
    })
    await waitForSeededAnalytics()
    await prepareCapture(page)

    if (!(await openAnalyzePage(page))) return

    console.log('\n--- analyze-by-app ---')
    await captureByApp(page)

    console.log('\n--- analyze-ergonomics-learning ---')
    await captureErgonomicsLearning(page)

    console.log('\n--- analyze-footer ---')
    await captureFooter(page)

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
