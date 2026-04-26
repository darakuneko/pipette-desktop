// SPDX-License-Identifier: GPL-2.0-or-later

// Analyze page e2e tests. Runs without a physical keyboard: dummy
// typing-analytics data + keymap snapshot are seeded into the userData
// directory before the first window loads, so `ensureCacheIsFresh`
// rebuilds the SQLite cache from our JSONL master. See
// `.claude/docs/TESTING-POLICY.md` §7 for the strategy.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from './helpers/electron'
import {
  DUMMY_TA_UID,
  seedDummySnapshots,
  restoreSnapshots,
  seedDummyTypingAnalytics,
  restoreTypingAnalytics,
  type TypingAnalyticsSeedBackup,
} from './helpers/analyze-seed'

let app: ElectronApplication
let page: Page
let snapBackups = new Map<string, string | null>()
let taBackup: TypingAnalyticsSeedBackup | null = null

test.beforeAll(async () => {
  const launched = await launchApp({
    onMainReady: async ({ userDataPath }) => {
      // Wipe any pipette_settings.json that a previous run may have
      // persisted for the test keyboard — `useAnalyzeFilters` writes
      // every filter tweak (WPM viewMode, Layer viewMode, etc.) into
      // this file, so leftover state from a prior playwright run can
      // still be active when the suite starts.
      const settingsPath = join(userDataPath, 'sync', 'keyboards', DUMMY_TA_UID, 'pipette_settings.json')
      if (existsSync(settingsPath)) unlinkSync(settingsPath)
      const kbBase = join(userDataPath, 'sync', 'keyboards')
      snapBackups = seedDummySnapshots(kbBase)
      taBackup = await seedDummyTypingAnalytics(userDataPath, Date.now())
    },
  })
  app = launched.app
  page = launched.page

  // Open the Analyze tab + select the seeded keyboard once for the whole suite.
  // The page never navigates away during the tests, so per-test setup is only
  // a tab switch — cheaper and avoids the navigate-back problem.
  const analyzeTab = page.locator('[data-testid="tab-analyze"]')
  await expect(analyzeTab).toBeVisible({ timeout: 15_000 })
  await analyzeTab.click()

  const analyzePage = page.locator('[data-testid="analyze-page"]')
  await expect(analyzePage).toBeVisible({ timeout: 10_000 })

  const kbSelect = page.locator('[data-testid="analyze-filter-keyboard"]')
  await expect(kbSelect).toBeVisible({ timeout: 15_000 })
  await kbSelect.selectOption(DUMMY_TA_UID)
})

test.afterAll(async () => {
  try { await app?.close() } catch { /* ignore */ }
  restoreSnapshots(snapBackups)
  if (taBackup) restoreTypingAnalytics(taBackup)
})

async function switchTab(tabKey: string): Promise<void> {
  const tab = page.locator(`[data-testid="analyze-tab-${tabKey}"]`)
  await expect(tab).toBeVisible()
  await tab.click()
}

test.describe('Analyze keyboard list', () => {
  test('the keyboard select lists the seeded keyboard', async () => {
    const option = page.locator(`[data-testid="analyze-kb-${DUMMY_TA_UID}"]`)
    await expect(option).toBeAttached()
  })

  test('common filters (Period / Device) are rendered', async () => {
    await expect(page.locator('[data-testid="analyze-filter-range"]')).toBeVisible()
    await expect(page.locator('[data-testid="analyze-filter-device"]')).toBeVisible()
  })
})

test.describe('Heatmap tab', () => {
  test('renders the ranking table (snapshot present)', async () => {
    await switchTab('keyHeatmap')
    const ranking = page.locator('[data-testid="analyze-keyheatmap-ranking"]')
    await expect(ranking).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="analyze-keyheatmap-empty"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="analyze-keyheatmap-nolayout"]')).toHaveCount(0)
  })

  test('normalization select exposes all three modes', async () => {
    await switchTab('keyHeatmap')
    const sel = page.locator('[data-testid="analyze-keyheatmap-normalization"]')
    await expect(sel).toBeVisible()
    await sel.selectOption('perHour')
    await expect(sel).toHaveValue('perHour')
    await sel.selectOption('shareOfTotal')
    await expect(sel).toHaveValue('shareOfTotal')
    await sel.selectOption('absolute')
  })
})

test.describe('WPM tab', () => {
  test('renders the time-series chart and summary by default', async () => {
    await switchTab('wpm')
    await expect(page.locator('[data-testid="analyze-wpm-chart"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="analyze-wpm-summary"]')).toBeVisible()
    await expect(page.locator('[data-testid="analyze-wpm-empty"]')).toHaveCount(0)
  })

  test('switches to time-of-day view', async () => {
    await switchTab('wpm')
    const viewMode = page.locator('[data-testid="analyze-filter-wpm-view-mode"]')
    await viewMode.selectOption('timeOfDay')
    await expect(page.locator('[data-testid="analyze-wpm-time-of-day"]')).toBeVisible({ timeout: 10_000 })
  })

})

test.describe('Interval tab', () => {
  test('renders the time-series chart by default', async () => {
    await switchTab('interval')
    await expect(page.locator('[data-testid="analyze-interval-chart"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="analyze-interval-empty"]')).toHaveCount(0)
  })

  test('switching to distribution hides the device filter', async () => {
    await switchTab('interval')
    await expect(page.locator('[data-testid="analyze-filter-device"]')).toBeVisible()
    const viewMode = page.locator('[data-testid="analyze-filter-interval-view-mode"]')
    await viewMode.selectOption('distribution')
    await expect(page.locator('[data-testid="analyze-interval-distribution"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="analyze-filter-device"]')).toBeHidden()
  })
})

test.describe('Activity tab', () => {
  test('renders the keystrokes grid by default', async () => {
    await switchTab('activity')
    await expect(page.locator('[data-testid="analyze-activity-chart"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="analyze-activity-empty"]')).toHaveCount(0)
  })

  test('sessions metric switches to histogram', async () => {
    await switchTab('activity')
    const metric = page.locator('[data-testid="analyze-filter-activity-metric"]')
    await metric.selectOption('sessions')
    await expect(page.locator('[data-testid="analyze-activity-sessions"]')).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('Ergonomics tab', () => {
  test('renders Finger / Hand / Row sections when snapshot is available', async () => {
    await switchTab('ergonomics')
    await expect(page.locator('[data-testid="analyze-ergonomics-finger"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="analyze-ergonomics-hand"]')).toBeVisible()
    await expect(page.locator('[data-testid="analyze-ergonomics-row"]')).toBeVisible()
    await expect(page.locator('[data-testid="analyze-ergonomics-no-snapshot"]')).toHaveCount(0)
  })

  test('finger-assignment modal opens and closes', async () => {
    await switchTab('ergonomics')
    const openBtn = page.locator('[data-testid="analyze-finger-assignment-open"]')
    await expect(openBtn).toBeEnabled({ timeout: 10_000 })
    await openBtn.click()
    const modal = page.locator('[data-testid="finger-assignment-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    await page.locator('[data-testid="finger-assignment-close"]').click()
    await expect(modal).toBeHidden()
  })
})

test.describe('Layer tab', () => {
  test('renders keystrokes view by default', async () => {
    await switchTab('layer')
    const viewMode = page.locator('[data-testid="analyze-filter-layer-view-mode"]')
    await expect(viewMode).toBeVisible({ timeout: 10_000 })
    await expect(viewMode).toHaveValue('keystrokes')
  })

  test('activations view works when a snapshot is present', async () => {
    await switchTab('layer')
    const viewMode = page.locator('[data-testid="analyze-filter-layer-view-mode"]')
    await viewMode.selectOption('activations')
    await expect(viewMode).toHaveValue('activations')
    // Base layer picker appears only in activations view, and only when the
    // snapshot reports 2+ layers (DUMMY_TA_LAYERS = 3 so it is visible here).
    await expect(page.locator('[data-testid="analyze-filter-layer-base-layer"]')).toBeVisible({ timeout: 5_000 })
  })
})

