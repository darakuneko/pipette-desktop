// SPDX-License-Identifier: GPL-2.0-or-later

// Targeted screenshot capture for two Analyze tab views:
//  - analyze-by-app: needs a 10s settle for the recharts donut animation
//  - analyze-ergonomics-learning: needs an older keymap snapshot selected
//    so the active range covers the seeded historical matrix-minute data
//
// Run when the full doc-capture is overkill and only these two need a
// retake. Seeding/restoring matches doc-capture.ts so the Analyze page
// has the same dummy keyboard / snapshots / typing-analytics dataset.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-analyze-fix.ts

import { _electron as electron } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dismissNotificationModal, selectKeyboardViaFilterModal, selectSnapshotViaFilterModal } from './doc-capture-common'
import {
  DUMMY_TA_UID,
  restoreTypingAnalytics,
  seedDummyTypingAnalytics,
} from './analyze-seed'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')

async function isAvailable(locator: Locator, timeoutMs = 5000): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
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
  // dummy keyboard explicitly (not "whichever sorts first") — a real,
  // thin "GPK60-63R" dataset on this machine would otherwise outrank the
  // seeded "GPK60-63R (docs)" one alphabetically. The helper polls for
  // the option since the cache rebuild from JSONL masters can take a
  // few seconds after launch.
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
  await capture(page, 'analyze-by-app')
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

  await capture(page, 'analyze-ergonomics-learning')

  if (pivoted) {
    await selectSnapshotViaFilterModal(page, 0, { settleMs: 400 })
  }
  await viewModeSelect.selectOption('snapshot').catch(() => { /* best effort */ })
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

  const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'))
  console.log(`userData: ${userDataPath}`)

  const taBackup = await seedDummyTypingAnalytics(userDataPath, Date.now())
  console.log(`Seeded dummy typing-analytics: uid=${DUMMY_TA_UID}, history=${taBackup.historicalJsonlPaths.length} days`)

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    if (!(await openAnalyzePage(page))) return

    console.log('\n--- analyze-by-app ---')
    await captureByApp(page)

    console.log('\n--- analyze-ergonomics-learning ---')
    await captureErgonomicsLearning(page)

    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
    restoreTypingAnalytics(taBackup)
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
