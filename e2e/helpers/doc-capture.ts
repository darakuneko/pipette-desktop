// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Pipette operation guide documentation.
// Usage: pnpm build && pnpm doc:screenshots
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page, Locator } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { dismissNotificationModal, isAvailable } from './doc-capture-common'
import {
  DUMMY_SNAPSHOTS,
  DUMMY_TA_UID,
  seedDummySnapshots,
  restoreSnapshots,
  seedDummyTypingAnalytics,
  restoreTypingAnalytics,
  seedDummyFilterStore,
  restoreFilterStore,
} from './analyze-seed'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}

// Click a tree-nav branch button only when it reports aria-expanded=false, so
// repeat runs don't collapse an already-expanded branch via the toggle handler.
// When already expanded, skip the click and the settle delay.
async function expandBranchIfCollapsed(branch: Locator, settleMs = 300): Promise<void> {
  if ((await branch.getAttribute('aria-expanded')) === 'true') return
  await branch.click()
  await branch.page().waitForTimeout(settleMs)
}

// Restore the Editor view after a prior run left the device in Typing Test mode.
// useDevicePrefs persists `viewMode` per keyboard; since `~/.config/Electron`
// is not isolated between capture runs, this guard avoids landing in a state
// where TabbedKeycodes is not rendered (KeymapEditor hides it under
// `typingTestMode`). Uses the locale-stable `data-active` attribute instead of
// the i18n-dependent aria-label text.
async function ensureEditorMode(page: Page): Promise<void> {
  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  if (!(await isAvailable(typingTestBtn))) return
  if ((await typingTestBtn.getAttribute('data-active')) !== 'true') return
  console.log('  [reset] Exiting Typing Test mode from prior run')
  await typingTestBtn.click()
  await page.waitForTimeout(500)
}

// Uses fixed filenames that match OPERATION-GUIDE.md references.
// A global counter tracks sequential numbering.
let screenshotCounter = 0

async function takeScreenshot(
  page: Page,
  filename: string,
  label: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, filename)
  if (opts?.element) {
    await opts.element.screenshot({ path })
  } else {
    await page.screenshot({ path, fullPage: opts?.fullPage ?? false })
  }
  console.log(`  [${label}] ${filename}`)
}

async function capture(
  page: Page,
  name: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  screenshotCounter++
  const num = String(screenshotCounter).padStart(2, '0')
  await takeScreenshot(page, `${num}-${name}.png`, num, opts)
}

async function captureNamed(
  page: Page,
  name: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  await takeScreenshot(page, `${name}.png`, '--', opts)
}

async function waitForUnlockDialog(page: Page): Promise<void> {
  // The unlock dialog has no close button — it requires physical key presses.
  // Wait up to 60 seconds for the dialog to disappear (user unlocks).
  const unlockHeading = page.locator('h2', { hasText: /Unlock|unlock|アンロック/ })
  if (!(await isAvailable(unlockHeading))) return

  console.log('  Unlock dialog detected — waiting for physical unlock (up to 60s)...')
  try {
    await unlockHeading.waitFor({ state: 'detached', timeout: 60_000 })
    console.log('  Keyboard unlocked!')
    await page.waitForTimeout(500)
  } catch {
    console.log('  [warn] Unlock timed out')
  }
}

async function ensureOverlayOpen(page: Page): Promise<boolean> {
  const toggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  if (!(await isAvailable(toggle))) return false

  const isExpanded = await toggle.getAttribute('aria-expanded')
  if (isExpanded !== 'true') {
    await toggle.click()
    await page.waitForTimeout(500)
  }
  return true
}

async function closeOverlay(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  if (await isAvailable(toggle)) {
    const isExpanded = await toggle.getAttribute('aria-expanded')
    if (isExpanded === 'true') {
      await toggle.click()
      await page.waitForTimeout(300)
    }
  }
}

async function switchOverlayTab(page: Page, tabTestId: string): Promise<boolean> {
  const tab = page.locator(`[data-testid="${tabTestId}"]`)
  if (!(await isAvailable(tab))) {
    console.log(`  [skip] ${tabTestId} not found`)
    return false
  }
  await tab.click()
  await page.waitForTimeout(300)
  return true
}

async function connectDevice(page: Page): Promise<boolean> {
  const deviceList = page.locator('[data-testid="device-list"]')
  const noDeviceMsg = page.locator('[data-testid="no-device-message"]')

  try {
    await Promise.race([
      deviceList.waitFor({ state: 'visible', timeout: 10_000 }),
      noDeviceMsg.waitFor({ state: 'visible', timeout: 10_000 }),
    ])
  } catch {
    console.log('Timed out waiting for device list.')
    return false
  }

  if (!(await deviceList.isVisible())) {
    console.log('No devices found.')
    return false
  }

  const targetBtn = page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })

  if (!(await isAvailable(targetBtn))) {
    console.log(`Device "${DEVICE_NAME}" not found.`)
    return false
  }

  await targetBtn.click()
  await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(2000)
  console.log(`Connected to ${DEVICE_NAME}`)
  return true
}

// --- Phase 1: Device Selection ---

async function captureDeviceSelection(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Device Selection ---')
  await capture(page, 'device-selection', { fullPage: true })

  // File tab
  const fileTab = page.locator('[data-testid="tab-file"]')
  if (await isAvailable(fileTab)) {
    await fileTab.click()
    // Wait for keyboard list to load (async IPC fetch)
    const kbList = page.locator('[data-testid="pipette-keyboard-list"]')
    try {
      await kbList.waitFor({ state: 'visible', timeout: 5000 })
    } catch {
      console.log('  [warn] File tab keyboard list did not appear')
    }
    await page.waitForTimeout(500)
    await captureNamed(page, 'file-tab', { fullPage: true })
    // Switch back to keyboard tab
    const kbTab = page.locator('[data-testid="tab-keyboard"]')
    if (await isAvailable(kbTab)) {
      await kbTab.click()
      await page.waitForTimeout(300)
    }
  }
}

// --- Phase 1.5: Data Modal (from device selector) ---

const DUMMY_FAVORITES: Record<string, { type: string; entries: { id: string; label: string; filename: string; savedAt: string; updatedAt?: string }[] }> = {
  tapDance: {
    type: 'tapDance',
    entries: [
      { id: 'doc-td-1', label: 'Ctrl/Esc', filename: 'doc-td-1.json', savedAt: '2026-02-20T10:00:00.000Z', updatedAt: '2026-02-25T12:30:00.000Z' },
      { id: 'doc-td-2', label: 'Shift/CapsWord', filename: 'doc-td-2.json', savedAt: '2026-02-21T08:15:00.000Z', updatedAt: '2026-02-24T09:00:00.000Z' },
      { id: 'doc-td-3', label: 'Layer Toggle', filename: 'doc-td-3.json', savedAt: '2026-02-22T14:30:00.000Z' },
    ],
  },
  macro: {
    type: 'macro',
    entries: [
      { id: 'doc-mc-1', label: 'Email Signature', filename: 'doc-mc-1.json', savedAt: '2026-02-19T09:00:00.000Z', updatedAt: '2026-02-25T10:00:00.000Z' },
      { id: 'doc-mc-2', label: 'Git Commit', filename: 'doc-mc-2.json', savedAt: '2026-02-22T16:00:00.000Z' },
    ],
  },
}

// Playwright's electron.launch() uses a different userData path than the installed app.
// We resolve it dynamically via app.evaluate() before seeding.

function seedDummyFavorites(favBase: string): Map<string, string | null> {
  const backups = new Map<string, string | null>()
  for (const [type, index] of Object.entries(DUMMY_FAVORITES)) {
    const dir = join(favBase, type)
    mkdirSync(dir, { recursive: true })
    const indexPath = join(dir, 'index.json')
    backups.set(indexPath, existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null)
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    for (const entry of index.entries) {
      const fp = join(dir, entry.filename)
      if (!existsSync(fp)) writeFileSync(fp, '{}', 'utf-8')
    }
  }
  return backups
}

function restoreFavorites(backups: Map<string, string | null>, favBase: string): void {
  for (const [indexPath, original] of backups) {
    if (original != null) {
      writeFileSync(indexPath, original, 'utf-8')
    } else {
      try { unlinkSync(indexPath) } catch { /* ignore */ }
    }
  }
  for (const index of Object.values(DUMMY_FAVORITES)) {
    const dir = join(favBase, index.type)
    for (const entry of index.entries) {
      const fp = join(dir, entry.filename)
      try { unlinkSync(fp) } catch { /* ignore */ }
    }
  }
}

async function captureDataModal(page: Page): Promise<void> {
  console.log('\n--- Phase 1.5: Data Modal (Tree Sidebar) ---')

  const dataBtn = page.locator('[data-testid="data-button"]')
  if (!(await isAvailable(dataBtn))) {
    console.log('  [skip] data-button not found')
    return
  }

  await dataBtn.click()
  await page.waitForTimeout(1000)

  const backdrop = page.locator('[data-testid="data-modal-backdrop"]')
  try {
    await backdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Data modal did not open')
    return
  }

  // Expand Local branch and navigate to Favorites > Tap Dance
  const navLocal = page.locator('[data-testid="nav-local"]')
  if (await isAvailable(navLocal)) {
    await expandBranchIfCollapsed(navLocal)

    const navFavorites = page.locator('[data-testid="nav-local-favorites"]')
    if (await isAvailable(navFavorites)) {
      await expandBranchIfCollapsed(navFavorites)

      const navTd = page.locator('[data-testid="nav-fav-tapDance"]')
      if (await isAvailable(navTd)) {
        await navTd.click()
        await page.waitForTimeout(500)
      }
    }
  }
  await captureNamed(page, 'data-sidebar-favorites', { fullPage: true })

  // Navigate to Keyboards (first keyboard if available)
  const navKeyboards = page.locator('[data-testid="nav-local-keyboards"]')
  if (await isAvailable(navKeyboards)) {
    await expandBranchIfCollapsed(navKeyboards)

    // Click first keyboard leaf if available
    const kbLeaf = page.locator('[data-testid^="nav-kb-"]').first()
    if (await isAvailable(kbLeaf)) {
      await kbLeaf.click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'data-sidebar-keyboard-saves', { fullPage: true })
    }
  }

  // Navigate to Application
  const navApp = page.locator('[data-testid="nav-local-application"]')
  if (await isAvailable(navApp)) {
    await navApp.click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'data-sidebar-application', { fullPage: true })
  }

  // Navigate to Sync (Cloud Sync configured → remote-only keyboards listed by name;
  // otherwise an empty-state message appears, still a valid documentation state).
  // useDataNavTree caches expansion across modal opens, so branch clicks are guarded
  // by aria-expanded to avoid collapsing an already-open branch on repeat runs.
  const navSync = page.locator('[data-testid="nav-sync"]')
  if (await isAvailable(navSync)) {
    await expandBranchIfCollapsed(navSync, 500)

    const navSyncKeyboards = page.locator('[data-testid="nav-sync-keyboards"]')
    if (await isAvailable(navSyncKeyboards)) {
      await expandBranchIfCollapsed(navSyncKeyboards)
    }
    await captureNamed(page, 'data-sidebar-sync', { fullPage: true })
  }

  // Navigate to Hub (if available)
  const navHub = page.locator('[data-testid="nav-cloud-hub"]')
  if (await isAvailable(navHub)) {
    await expandBranchIfCollapsed(navHub)

    const hubKbs = page.locator('[data-testid="nav-hub-keyboards"]')
    if (await isAvailable(hubKbs)) {
      await expandBranchIfCollapsed(hubKbs)
    }
    await captureNamed(page, 'data-sidebar-hub', { fullPage: true })
  }

  await page.locator('[data-testid="data-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 1.7: Settings Modal (from device selector, named screenshots) ---

async function captureSettingsModal(page: Page): Promise<void> {
  console.log('\n--- Phase 1.7: Settings Modal ---')

  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] settings-button not found')
    return
  }

  await settingsBtn.click()
  await page.waitForTimeout(500)

  const settingsModal = page.locator('[data-testid="settings-modal"]')
  if (!(await isAvailable(settingsModal))) {
    console.log('  [skip] settings-modal not found')
    return
  }

  // Switch to Tools tab to capture defaults section
  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click()
    await page.waitForTimeout(300)

    // Scroll down to show defaults section
    const defaultsSection = page.locator('[data-testid="settings-default-layout-row"]')
    if (await isAvailable(defaultsSection)) {
      await defaultsSection.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
    }
    await captureNamed(page, 'settings-defaults', { fullPage: true })
  } else {
    console.log('  [skip] tools tab not found')
  }

  // Close settings modal
  const closeBtn = page.locator('[data-testid="settings-close"]')
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 1.8: Analyze Page (from device selector, Analyze tab) ---

// Captures the Analyze page from the device-selection screen. Real typing data
// is required for the charts to render; when no data exists on this machine,
// the sidebar is empty and we fall back to capturing only the overview so the
// guide still has a reference image. The per-tab sub-screenshots (Heatmap,
// WPM, Interval, Activity, Ergonomics, Layer) are skipped in that case.
async function captureAnalyzePage(page: Page): Promise<void> {
  console.log('\n--- Phase 1.8: Analyze Page ---')

  const analyzeTab = page.locator('[data-testid="tab-analyze"]')
  if (!(await isAvailable(analyzeTab))) {
    console.log('  [skip] tab-analyze not found')
    return
  }
  await analyzeTab.click()
  await page.waitForTimeout(500)

  const analyzePage = page.locator('[data-testid="analyze-page"]')
  if (!(await isAvailable(analyzePage))) {
    console.log('  [skip] analyze-page did not open')
    return
  }

  // Analyze only lists keyboards with recorded data — skip cleanly if none.
  const firstKbOption = page.locator('[data-testid^="analyze-kb-"]').first()
  const firstKbValue = (await isAvailable(firstKbOption))
    ? await firstKbOption.getAttribute('value')
    : null
  if (firstKbValue) {
    await page.locator('[data-testid="analyze-filter-keyboard"]').selectOption(firstKbValue)
    await page.waitForTimeout(500)
  } else {
    console.log('  [warn] no keyboards listed — capturing overview only')
  }

  // Summary: default landing tab. Capture the four-card overview, then
  // surface the Goal Achievements modal from the Streak / Goal card.
  const summaryTab = page.locator('[data-testid="analyze-tab-summary"]')
  if (await isAvailable(summaryTab)) {
    await summaryTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-summary', { fullPage: true })

    const goalHistoryBtn = page.locator('[data-testid="analyze-streak-goal-history-open"]')
    if ((await isAvailable(goalHistoryBtn)) && (await goalHistoryBtn.isEnabled())) {
      await goalHistoryBtn.click()
      await page.waitForTimeout(500)
      const goalModal = page.locator('[data-testid="analyze-goal-achievements-modal"]')
      if (await isAvailable(goalModal)) {
        await captureNamed(page, 'analyze-goal-achievements', { element: goalModal })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      } else {
        console.log('  [warn] analyze-goal-achievements-modal did not open')
      }
    } else {
      console.log('  [skip] analyze-streak-goal-history-open not available')
    }
  } else {
    console.log('  [skip] analyze-tab-summary not found')
  }

  // App filter popover — opens the multi-select dropdown for the App
  // chip in the common filter row. Captured as a full-page screenshot
  // so the open state and the row context land together.
  const appFilter = page.locator('[data-testid="analyze-filter-app"]')
  if (await isAvailable(appFilter)) {
    await appFilter.click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'analyze-app-filter', { fullPage: true })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  } else {
    console.log('  [skip] analyze-filter-app not found')
  }

  // Filter Store side panel — toggle open, capture the panel as an
  // element shot, then close so subsequent tabs render unobstructed.
  const filterStoreToggle = page.locator('[data-testid="analyze-filter-store-toggle"]')
  if (await isAvailable(filterStoreToggle)) {
    await filterStoreToggle.click()
    await page.waitForTimeout(400)
    const storePanel = page.locator('[data-testid="analyze-filter-store-panel"]')
    if (await isAvailable(storePanel)) {
      await captureNamed(page, 'analyze-filter-store', { element: storePanel })
    } else {
      console.log('  [warn] analyze-filter-store-panel did not open')
    }
    await filterStoreToggle.click()
    await page.waitForTimeout(200)
  } else {
    console.log('  [skip] analyze-filter-store-toggle not found')
  }

  // Snapshot timeline — focused element capture, no tab switch needed.
  // The element is a `<label>` wrapper that Playwright may report as not
  // visible when nothing is rendered inside; treat the failure as a skip
  // so the rest of the Analyze captures keep running.
  const snapTimeline = page.locator('[data-testid="analyze-snapshot-timeline"]')
  if (await isAvailable(snapTimeline)) {
    try {
      await captureNamed(page, 'analyze-snapshot-timeline', { element: snapTimeline })
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : 'unknown'
      console.log(`  [warn] analyze-snapshot-timeline capture failed — ${msg}`)
    }
  } else {
    console.log('  [skip] analyze-snapshot-timeline not found')
  }

  // Heatmap: requires a snapshot; empty state is captured if none exists.
  const heatmapTab = page.locator('[data-testid="analyze-tab-keyHeatmap"]')
  if (await isAvailable(heatmapTab)) {
    await heatmapTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-heatmap', { fullPage: true })
  } else {
    console.log('  [skip] analyze-tab-keyHeatmap not found')
  }

  const wpmTab = page.locator('[data-testid="analyze-tab-wpm"]')
  if (await isAvailable(wpmTab)) {
    await wpmTab.click()
    await page.waitForTimeout(800)
    const wpmViewMode = page.locator('[data-testid="analyze-filter-wpm-view-mode"]')
    if (await isAvailable(wpmViewMode)) {
      await wpmViewMode.selectOption('timeSeries')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-wpm-time-series', { fullPage: true })
      await wpmViewMode.selectOption('timeOfDay')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-wpm-time-of-day', { fullPage: true })
    } else {
      console.log('  [warn] wpm view-mode select not found — capturing default only')
      await captureNamed(page, 'analyze-wpm-time-series', { fullPage: true })
    }
  } else {
    console.log('  [skip] analyze-tab-wpm not found')
  }

  const intervalTab = page.locator('[data-testid="analyze-tab-interval"]')
  if (await isAvailable(intervalTab)) {
    await intervalTab.click()
    await page.waitForTimeout(800)
    const intervalViewMode = page.locator('[data-testid="analyze-filter-interval-view-mode"]')
    if (await isAvailable(intervalViewMode)) {
      await intervalViewMode.selectOption('timeSeries')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-interval-time-series', { fullPage: true })
      await intervalViewMode.selectOption('distribution')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-interval-distribution', { fullPage: true })
    } else {
      console.log('  [warn] interval view-mode select not found — capturing default only')
      await captureNamed(page, 'analyze-interval-time-series', { fullPage: true })
    }
  } else {
    console.log('  [skip] analyze-tab-interval not found')
  }

  // Activity: representative captures for the keystrokes grid and the
  // year-spanning calendar. Both run from the same metric select; the
  // calendar capture comes second so the metric ends in calendar mode
  // ready for the operation guide screenshot.
  const activityTab = page.locator('[data-testid="analyze-tab-activity"]')
  if (await isAvailable(activityTab)) {
    await activityTab.click()
    await page.waitForTimeout(800)
    const activityMetric = page.locator('[data-testid="analyze-filter-activity-metric"]')
    if (await isAvailable(activityMetric)) {
      await activityMetric.selectOption('keystrokes')
      await page.waitForTimeout(500)
    }
    await captureNamed(page, 'analyze-activity-keystrokes', { fullPage: true })

    // Calendar view — switch via the View select. The chart always
    // renders the selected year (current year by default), which
    // gives the guide a representative full-year shape without
    // touching the year picker.
    const activityView = page.locator('[data-testid="analyze-filter-activity-view"]')
    if (await isAvailable(activityView)) {
      await activityView.selectOption('calendar')
      await page.waitForTimeout(800)
      await captureNamed(page, 'analyze-activity-calendar', { fullPage: true })
    }
  } else {
    console.log('  [skip] analyze-tab-activity not found')
  }

  const ergonomicsTab = page.locator('[data-testid="analyze-tab-ergonomics"]')
  if (await isAvailable(ergonomicsTab)) {
    await ergonomicsTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-ergonomics', { fullPage: true })

    // Learning curve sub-view: switch the View filter to 'learning'
    // and capture the trend chart, then restore the snapshot view so
    // the rest of the run keeps the historical layout. We also pivot
    // to the older keymap snapshot beforehand so the active range
    // expands to cover the historical matrix-minute rows seeded by
    // analyze-seed.ts; the default "Current keymap" range is only
    // ~4 hours and would render the empty state.
    const viewModeSelect = page.locator('[data-testid="analyze-filter-ergonomics-view-mode"]')
    if (await isAvailable(viewModeSelect)) {
      await viewModeSelect.selectOption('learning')
      await page.waitForTimeout(800)
      const snapshotSelect = page.locator('[data-testid="analyze-snapshot-timeline-select"]')
      const optionCount = (await snapshotSelect.locator('option').count().catch(() => 0))
      if (optionCount >= 2) {
        const olderValue = await snapshotSelect.locator('option').nth(1).getAttribute('value')
        if (olderValue) {
          await snapshotSelect.selectOption(olderValue)
          // Wait for the range update + matrix-cells-by-day re-fetch to settle.
          await page.waitForTimeout(1500)
        }
      } else {
        console.log('  [warn] only one snapshot present — learning curve may render empty')
      }
      await captureNamed(page, 'analyze-ergonomics-learning', { fullPage: true })
      if (optionCount >= 2) {
        // Reset to "Current keymap" (option index 0) so the captures
        // that follow keep the latest snapshot's 4-hour active window.
        await snapshotSelect.selectOption({ index: 0 })
        await page.waitForTimeout(800)
      }
      await viewModeSelect.selectOption('snapshot')
      await page.waitForTimeout(400)
    } else {
      console.log('  [skip] analyze-filter-ergonomics-view-mode not found — learning capture skipped')
    }

    // Open button is disabled when no snapshot is available — gate on isEnabled.
    const fingerBtn = page.locator('[data-testid="analyze-finger-assignment-open"]')
    if ((await isAvailable(fingerBtn)) && (await fingerBtn.isEnabled())) {
      await fingerBtn.click()
      await page.waitForTimeout(500)
      const fingerModal = page.locator('[data-testid="finger-assignment-modal"]')
      if (await isAvailable(fingerModal)) {
        // Element screenshot so the modal fills the frame instead of the dimmed backdrop.
        await captureNamed(page, 'analyze-finger-assignment-modal', { element: fingerModal })
        const closeBtn = page.locator('[data-testid="finger-assignment-close"]')
        if (await isAvailable(closeBtn)) {
          await closeBtn.click()
          await page.waitForTimeout(500)
        }
      } else {
        console.log('  [warn] finger-assignment-modal did not open')
      }
    } else {
      console.log('  [warn] finger-assignment button not available — modal capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-ergonomics not found')
  }

  const bigramsTab = page.locator('[data-testid="analyze-tab-bigrams"]')
  if (await isAvailable(bigramsTab)) {
    await bigramsTab.click()
    await page.waitForTimeout(800)
    // Element screenshot of the 2x2 quadrant grid keeps the four sub-views
    // legible — `fullPage` would dilute each quadrant against sidebar/filters.
    const bigramsContent = page.locator('[data-testid="analyze-bigrams-content"]')
    if (await isAvailable(bigramsContent)) {
      await captureNamed(page, 'analyze-bigrams', { element: bigramsContent })
    } else {
      console.log('  [warn] analyze-bigrams-content not visible — capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-bigrams not found')
  }

  const layoutComparisonTab = page.locator('[data-testid="analyze-tab-layoutComparison"]')
  if (await isAvailable(layoutComparisonTab)) {
    await layoutComparisonTab.click()
    await page.waitForTimeout(500)
    // Pick Colemak so each diff panel actually has something to render.
    // All three panels render simultaneously, so we capture each one
    // via its data-testid root rather than flipping a sub-view toggle.
    const targetSelect = page.locator('[data-testid="analyze-layout-comparison-target-select"]')
    if (await isAvailable(targetSelect)) {
      const targetOptions = await targetSelect.locator('option:not([value="__none__"])').all()
      if (targetOptions.length === 0) {
        console.log('  [warn] layout-comparison no target options available — capture skipped')
      } else {
        const firstTarget = await targetOptions[0].getAttribute('value')
        await targetSelect.selectOption(firstTarget)
        await page.waitForTimeout(800)

        const heatmapPanel = page.locator('[data-testid="analyze-layout-comparison-heatmap-diff"]')
        if (await isAvailable(heatmapPanel)) {
          await captureNamed(page, 'analyze-layout-comparison-heatmap-diff', { element: heatmapPanel })
        } else {
          console.log('  [warn] layout-comparison heatmap panel not visible — capture skipped')
        }

        const fingerPanel = page.locator('[data-testid="analyze-layout-comparison-finger-diff"]')
        if (await isAvailable(fingerPanel)) {
          await captureNamed(page, 'analyze-layout-comparison-finger-diff', { element: fingerPanel })
        } else {
          console.log('  [warn] layout-comparison finger panel not visible — capture skipped')
        }

        const metricPanel = page.locator('[data-testid="analyze-layout-comparison-metric-table"]')
        if (await isAvailable(metricPanel)) {
          await captureNamed(page, 'analyze-layout-comparison-metric', { element: metricPanel })
        } else {
          console.log('  [warn] layout-comparison metric panel not visible — capture skipped')
        }
      }
    } else {
      console.log('  [warn] layout-comparison target select not found — capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-layoutComparison not found')
  }

  const layerTab = page.locator('[data-testid="analyze-tab-layer"]')
  if (await isAvailable(layerTab)) {
    await layerTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-layer-keystrokes', { fullPage: true })

    const viewModeSelect = page.locator('[data-testid="analyze-filter-layer-view-mode"]')
    if (await isAvailable(viewModeSelect)) {
      await viewModeSelect.selectOption('activations')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-layer-activations', { fullPage: true })
    } else {
      console.log('  [warn] view-mode select not found — activations capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-layer not found — Layer screenshots skipped')
  }

  // By App: per-application breakdown (App Usage donut + WPM by App).
  // Intentionally ignores the App filter so capturing the full chart
  // does not require seeding a filter selection.
  const byAppTab = page.locator('[data-testid="analyze-tab-byApp"]')
  if (await isAvailable(byAppTab)) {
    await byAppTab.click()
    // The donut animates in over several seconds; capturing too early
    // freezes it mid-unfold (slices clipped to a sliver). 10s gives the
    // recharts animation time to settle into its final geometry.
    await page.waitForTimeout(10_000)
    await captureNamed(page, 'analyze-by-app', { fullPage: true })
  } else {
    console.log('  [skip] analyze-tab-byApp not found')
  }

  // CSV export modal — opened via the Filter Store side panel's
  // "current CSV" button (the panel is the only entry point to the
  // export modal). Re-open the panel, click the export button, capture
  // the category-pick modal as an element shot, then close everything
  // so the run leaves no .csv files behind.
  const filterStoreToggleAgain = page.locator('[data-testid="analyze-filter-store-toggle"]')
  if (await isAvailable(filterStoreToggleAgain)) {
    await filterStoreToggleAgain.click()
    await page.waitForTimeout(400)
    const exportCurrentBtn = page.locator('[data-testid="analyze-filter-store-export-current-csv"]')
    if ((await isAvailable(exportCurrentBtn)) && (await exportCurrentBtn.isEnabled())) {
      await exportCurrentBtn.click()
      await page.waitForTimeout(400)
      const exportModal = page.locator('[data-testid="analyze-export-modal"]')
      if (await isAvailable(exportModal)) {
        await captureNamed(page, 'analyze-export-modal', { element: exportModal })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      } else {
        console.log('  [warn] analyze-export-modal did not open')
      }
    } else {
      console.log('  [skip] analyze-filter-store-export-current-csv not available')
    }
    await filterStoreToggleAgain.click()
    await page.waitForTimeout(200)
  } else {
    console.log('  [skip] analyze-filter-store-toggle not found for export modal')
  }

  // Return to the Keyboard tab so subsequent phases can connect as usual.
  const kbTab = page.locator('[data-testid="tab-keyboard"]')
  if (await isAvailable(kbTab)) {
    await kbTab.click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 2: Keymap Editor Overview ---

async function captureKeymapEditor(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Keymap Editor ---')
  await capture(page, 'keymap-editor-overview', { fullPage: true })
}

// --- Phase 3: Layer Navigation ---

async function captureLayerNavigation(page: Page): Promise<void> {
  console.log('\n--- Phase 3: Layer Navigation ---')

  await capture(page, 'layer-0', { fullPage: true })

  for (const layerNum of [1, 2]) {
    const btn = page.locator(`[data-testid="layer-panel-layer-num-${layerNum}"]`)
    if (await isAvailable(btn)) {
      await btn.click()
      await page.waitForTimeout(1000)
      await capture(page, `layer-${layerNum}`, { fullPage: true })
    }
  }

  const layer0Btn = page.locator('[data-testid="layer-panel-layer-num-0"]')
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.click()
    await page.waitForTimeout(500)
  }
}

// --- Phase 4: Keycode Category Tabs ---

const KEYCODE_TABS = [
  { id: 'basic', label: 'Basic' },
  { id: 'layers', label: 'Layers' },
  { id: 'modifiers', label: 'Modifiers' },
  { id: 'system', label: 'System' },
  { id: 'midi', label: 'MIDI' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'tapDance', label: 'Tap-Hold / Tap Dance' },
  { id: 'macro', label: 'Macro' },
  { id: 'combo', label: 'Combo' },
  { id: 'keyOverride', label: 'Key Override' },
  { id: 'altRepeatKey', label: 'Alt Repeat Key' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'user', label: 'User' },
]

async function captureKeycodeCategories(page: Page): Promise<void> {
  console.log('\n--- Phase 4: Keycode Categories ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  for (const tab of KEYCODE_TABS) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tab.label)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] Tab "${tab.label}" not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)
    await captureNamed(page, `tab-${tab.id}`, { fullPage: true })
  }

  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 4.5: Keyboard Tab (Device Picker) ---

async function captureKeyboardTab(page: Page): Promise<void> {
  console.log('\n--- Phase 4.5: Keyboard Tab (Device Picker) ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const keyboardTabBtn = editorContent.locator('button', { hasText: /^Keyboard$/ })
  if (!(await isAvailable(keyboardTabBtn))) {
    console.log('  [skip] Keyboard tab not found')
    return
  }
  await keyboardTabBtn.first().click()
  await page.waitForTimeout(500)

  // Capture device list view
  await captureNamed(page, 'keyboard-tab-device-list', { fullPage: true })

  // Click the connected device to show its keymap
  const deviceBtn = editorContent.locator('button', { hasText: new RegExp(escapeRegex(DEVICE_NAME)) })
  if (await isAvailable(deviceBtn)) {
    await deviceBtn.first().click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'keyboard-tab-keymap', { fullPage: true })
  }

  // Switch back to Basic tab
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 5: Toolbar / Sidebar ---

async function captureSidebarTools(page: Page): Promise<void> {
  console.log('\n--- Phase 5: Toolbar ---')

  await captureNamed(page, 'toolbar', { fullPage: true })

  const zoomInBtn = page.locator('[data-testid="zoom-in-button"]')
  if (await isAvailable(zoomInBtn)) {
    await zoomInBtn.click()
    await zoomInBtn.click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'zoom-in', { fullPage: true })
    const zoomOutBtn = page.locator('[data-testid="zoom-out-button"]')
    if (await isAvailable(zoomOutBtn)) {
      await zoomOutBtn.click()
      await zoomOutBtn.click()
    }
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] zoom-in-button not found')
  }

  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  if (await isAvailable(typingTestBtn)) {
    await typingTestBtn.click()
    await waitForUnlockDialog(page)
    await page.waitForTimeout(1000)
    await captureNamed(page, 'typing-test', { fullPage: true })
    await dismissNotificationModal(page)
    // Forcefully remove all fixed overlay/modal elements that block interaction
    await page.evaluate(() => {
      document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
    })
    await page.waitForTimeout(500)
    await typingTestBtn.click({ timeout: 5000 }).catch(() => {
      console.log('  [warn] Could not toggle typing test off')
    })
    await page.waitForTimeout(500)
    // Final cleanup: remove any remaining overlays
    await page.evaluate(() => {
      document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
    })
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] typing-test-button not found')
  }
}

// --- Phase 6: Modal Editors ---

// Tile-based editor captures (Combo, Key Override, Alt Repeat Key)
// Tab view: inline tile grid on the dedicated tab (no modal)
// Detail: clicking a tile opens the detail editor modal directly (no back button or internal tile grid)
interface TileEditorCapture {
  name: string
  keycodeTab: string
  tileTestId: string
  backdropTestId: string
  modalCloseTestId: string
}

const TILE_EDITOR_CAPTURES: TileEditorCapture[] = [
  {
    name: 'combo',
    keycodeTab: 'Combo',
    tileTestId: 'combo-tile-0',
    backdropTestId: 'combo-modal-backdrop',
    modalCloseTestId: 'combo-modal-close',
  },
  {
    name: 'key-override',
    keycodeTab: 'Key Override',
    tileTestId: 'ko-tile-0',
    backdropTestId: 'ko-modal-backdrop',
    modalCloseTestId: 'ko-modal-close',
  },
  {
    name: 'alt-repeat-key',
    keycodeTab: 'Alt Repeat Key',
    tileTestId: 'arep-tile-0',
    backdropTestId: 'ar-modal-backdrop',
    modalCloseTestId: 'ar-modal-close',
  },
]

async function openEditorModal(
  page: Page,
  keycodeTab: string,
  settingsTestId: string,
  backdropTestId: string,
): Promise<boolean> {
  // Dismiss any lingering modals/overlays before interacting with tabs
  await dismissNotificationModal(page)
  await page.evaluate(() => {
    document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
  })
  await page.waitForTimeout(300)

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(keycodeTab)}$`) })
  if (!(await isAvailable(tabBtn))) return false
  await tabBtn.first().click()
  await page.waitForTimeout(300)

  const settingsBtn = page.locator(`[data-testid="${settingsTestId}"]`)
  if (!(await isAvailable(settingsBtn))) return false
  await settingsBtn.click()

  try {
    await page.locator(`[data-testid="${backdropTestId}"]`).waitFor({ state: 'visible', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function captureModalEditors(page: Page): Promise<void> {
  console.log('\n--- Phase 6: Modal Editors ---')

  // Lighting modal: still uses settings button
  const lightingBackdropTestId = 'lighting-modal-backdrop'
  if (await openEditorModal(page, 'Lighting', 'lighting-settings-btn', lightingBackdropTestId)) {
    await captureNamed(page, 'lighting-modal', { fullPage: true })
    await page.locator('[data-testid="lighting-modal-close"]').click()
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] lighting modal not available')
  }

  // Tile-based editors: Combo, Key Override, Alt Repeat Key
  // Tab view = inline tile grid on the dedicated tab
  // Detail = clicking a tile opens the detail editor modal directly
  const editorContent = page.locator('[data-testid="editor-content"]')
  for (const editor of TILE_EDITOR_CAPTURES) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(editor.keycodeTab)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] ${editor.name} tab not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)

    // Capture the tab view (inline tile grid)
    await captureNamed(page, `${editor.name}-modal`, { fullPage: true })

    // Click tile to open detail editor modal
    const tile = page.locator(`[data-testid="${editor.tileTestId}"]`)
    if (!(await isAvailable(tile))) {
      console.log(`  [skip] ${editor.name} tile not found, detail skipped`)
      continue
    }
    await tile.click()
    try {
      await page.locator(`[data-testid="${editor.backdropTestId}"]`).waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForTimeout(300)
      await captureNamed(page, `${editor.name}-detail`, { fullPage: true })
    } catch {
      console.log(`  [skip] ${editor.name} modal did not open, detail skipped`)
      continue
    }

    // Close the modal
    const closeBtn = page.locator(`[data-testid="${editor.modalCloseTestId}"]`)
    if (await isAvailable(closeBtn)) {
      await closeBtn.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(300)
  }
}

// --- Phase 6.5: JSON Editor Modals ---

async function captureJsonEditors(page: Page): Promise<void> {
  console.log('\n--- Phase 6.5: JSON Editor Modals ---')

  // Dismiss any lingering modals/overlays
  await dismissNotificationModal(page)
  await page.evaluate(() => {
    document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
  })
  await page.waitForTimeout(300)

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Tap Dance JSON editor
  const tdTab = editorContent.locator('button', { hasText: /^Tap-Hold \/ Tap Dance$/ })
  if (await isAvailable(tdTab)) {
    await tdTab.first().click()
    await page.waitForTimeout(300)

    const jsonBtn = page.locator('[data-testid="tap-dance-json-editor-btn"]')
    if (await isAvailable(jsonBtn)) {
      await jsonBtn.click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'json-editor-tap-dance', { fullPage: true })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else {
      console.log('  [skip] tap-dance-json-editor-btn not found')
    }
  }

  // Macro JSON editor (shows unlock warning)
  const macroTab = editorContent.locator('button', { hasText: /^Macro$/ })
  if (await isAvailable(macroTab)) {
    await macroTab.first().click()
    await page.waitForTimeout(300)

    const jsonBtn = page.locator('[data-testid="macro-json-editor-btn"]')
    if (await isAvailable(jsonBtn)) {
      await jsonBtn.click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'json-editor-macro', { fullPage: true })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else {
      console.log('  [skip] macro-json-editor-btn not found')
    }
  }
}

// --- Phase 7: Editor Settings Panel (Save only) ---

async function captureEditorSettings(page: Page): Promise<void> {
  console.log('\n--- Phase 7: Editor Settings (Save Panel) ---')

  if (!(await ensureOverlayOpen(page))) {
    console.log('  [skip] overlay toggle not found')
    return
  }

  if (await switchOverlayTab(page, 'overlay-tab-data')) {
    await captureNamed(page, 'editor-settings-save', { fullPage: true })
  }
}

// --- Phase 7.5: Overlay Panel ---

async function captureOverlayPanel(page: Page): Promise<void> {
  console.log('\n--- Phase 7.5: Overlay Panel ---')

  if (!(await ensureOverlayOpen(page))) {
    console.log('  [skip] overlay toggle not found')
    return
  }

  if (await switchOverlayTab(page, 'overlay-tab-tools')) {
    await captureNamed(page, 'overlay-tools', { fullPage: true })
  }

  if (await switchOverlayTab(page, 'overlay-tab-data')) {
    await captureNamed(page, 'overlay-save', { fullPage: true })
  }

  await closeOverlay(page)
}

// --- Phase 8: Status Bar ---

async function captureStatusBar(page: Page): Promise<void> {
  console.log('\n--- Phase 8: Status Bar ---')

  const statusBar = page.locator('[data-testid="status-bar"]')
  if (await isAvailable(statusBar)) {
    await captureNamed(page, 'status-bar', { element: statusBar })
  } else {
    console.log('  [skip] status-bar not found')
  }
}

// --- Phase 9: Inline Favorites ---

async function captureFavorites(page: Page): Promise<void> {
  console.log('\n--- Phase 9: Inline Favorites ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tdTabLabel = 'Tap-Hold / Tap Dance'

  const tdTabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tdTabLabel)}$`) })
  if (!(await isAvailable(tdTabBtn))) {
    console.log(`  [skip] ${tdTabLabel} tab not found`)
    return
  }
  await tdTabBtn.first().click()
  await page.waitForTimeout(300)

  // TD tab now shows a tile grid — click tile 0 to open the modal
  const tdTile = page.locator('[data-testid="td-tile-0"]')
  if (!(await isAvailable(tdTile))) {
    console.log('  [skip] td-tile-0 not found')
    return
  }
  await tdTile.click()
  await page.waitForTimeout(500)

  const tdBackdrop = page.locator('[data-testid="td-modal-backdrop"]')
  try {
    await tdBackdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] TD modal did not open')
    return
  }

  // TapDance modal now shows editor on the left and inline favorites panel on the right
  await captureNamed(page, 'inline-favorites', { fullPage: true })

  await page.locator('[data-testid="td-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 10: Key Popover ---

async function captureKeyPopover(page: Page): Promise<void> {
  console.log('\n--- Phase 10: Key Popover ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Switch to layer 0 using the layer panel testid
  const layer0Btn = page.locator('[data-testid="layer-panel-layer-num-0"]')
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.click()
    await page.waitForTimeout(300)
  }
  // Switch to Basic tab using a visible button in the keycode tab bar
  const basicBtn = editorContent.locator('button:visible', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }

  // Double-click a key to open the popover. Target the first SVG <text>
  // element (key label) inside the layout, which is more stable than
  // matching inline style strings that may vary across environments.
  const keyLabel = editorContent.locator('svg text').first()
  if (!(await isAvailable(keyLabel))) {
    console.log('  [skip] No key label found in layout')
    return
  }

  // Scroll window to top and ensure keyboard layout is visible
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  // Use dispatchEvent to bypass viewport checks on SVG elements
  await keyLabel.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(500)

  const popover = page.locator('[data-testid="key-popover"]')
  if (!(await isAvailable(popover))) {
    console.log('  [skip] Key popover did not open')
    return
  }

  // Capture Key tab (default view with search results)
  await captureNamed(page, 'key-popover-key', { fullPage: true })

  // Switch to Code tab and capture
  await page.locator('[data-testid="popover-tab-code"]').click()
  await page.waitForTimeout(300)
  await captureNamed(page, 'key-popover-code', { fullPage: true })

  // Switch back to Key tab and enable Mod Mask mode
  await page.locator('[data-testid="popover-tab-key"]').click()
  await page.waitForTimeout(200)

  await page.locator('[data-testid="popover-mode-mod-mask"]').click()
  await page.waitForTimeout(300)

  // Check a modifier to show the strip in action
  const lSftBtn = page.locator('[data-testid="mod-LSft"]')
  if (await isAvailable(lSftBtn)) {
    await lSftBtn.click()
    await page.waitForTimeout(200)
  }

  await captureNamed(page, 'key-popover-modifier', { fullPage: true })

  // Switch to LT mode to show layer selector
  await page.locator('[data-testid="popover-mode-mod-mask"]').click()
  await page.waitForTimeout(200)
  await page.locator('[data-testid="popover-mode-lt"]').click()
  await page.waitForTimeout(300)
  await captureNamed(page, 'key-popover-lt', { fullPage: true })

  // Close the popover
  const closeBtn = page.locator('[data-testid="popover-close"]')
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 11: Basic View Variants ---

async function captureBasicViewVariants(page: Page): Promise<void> {
  console.log('\n--- Phase 11: Basic View Variants ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Switch to Basic tab first
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }

  if (!(await ensureOverlayOpen(page))) {
    console.log('  [skip] overlay toggle not found')
    return
  }

  await switchOverlayTab(page, 'overlay-tab-tools')

  const viewTypeSelector = page.locator('[data-testid="overlay-basic-view-type-selector"]')
  if (!(await isAvailable(viewTypeSelector))) {
    console.log('  [skip] view type selector not found')
    await closeOverlay(page)
    return
  }

  // Capture each view type: select option in overlay, close for clean screenshot, capture
  const viewTypes = [
    { value: 'ansi', name: 'basic-ansi-view' },
    { value: 'iso', name: 'basic-iso-view' },
    { value: 'jis', name: 'basic-jis-view' },
    { value: 'list', name: 'basic-list-view' },
  ]

  for (const view of viewTypes) {
    await ensureOverlayOpen(page)
    await switchOverlayTab(page, 'overlay-tab-tools')
    await viewTypeSelector.selectOption(view.value)
    await page.waitForTimeout(500)
    await closeOverlay(page)
    await captureNamed(page, view.name, { fullPage: true })
  }

  // Restore ANSI view
  await ensureOverlayOpen(page)
  await switchOverlayTab(page, 'overlay-tab-tools')
  await viewTypeSelector.selectOption('ansi')
  await page.waitForTimeout(300)
  await closeOverlay(page)
}

// --- Phase 12: Layer Panel States ---

async function captureLayerPanelStates(page: Page): Promise<void> {
  console.log('\n--- Phase 12: Layer Panel States ---')

  // First try to find the collapse button (panel is expanded)
  const collapseBtn = page.locator('[data-testid="layer-panel-collapse-btn"]')
  const expandBtn = page.locator('[data-testid="layer-panel-expand-btn"]')

  if (await isAvailable(collapseBtn)) {
    // Panel is expanded — capture collapsed first, then expanded
    await collapseBtn.click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'layer-panel-collapsed', { fullPage: true })

    // Re-expand
    const expandBtnAfter = page.locator('[data-testid="layer-panel-expand-btn"]')
    if (await isAvailable(expandBtnAfter)) {
      await expandBtnAfter.click()
      await page.waitForTimeout(500)
    }
    await captureNamed(page, 'layer-panel-expanded', { fullPage: true })
  } else if (await isAvailable(expandBtn)) {
    // Panel is collapsed — capture collapsed first
    await captureNamed(page, 'layer-panel-collapsed', { fullPage: true })

    await expandBtn.click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'layer-panel-expanded', { fullPage: true })
  } else {
    console.log('  [skip] layer panel collapse/expand buttons not found')
  }
}

// --- Phase 13: Tile Grids ---

async function captureTileGrids(page: Page): Promise<void> {
  console.log('\n--- Phase 13: Tile Grids ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  const tileGrids = [
    { tabLabel: 'Tap-Hold / Tap Dance', tileTestId: 'td-tile-0', name: 'td-tile-grid' },
    { tabLabel: 'Macro', tileTestId: 'macro-tile-0', name: 'macro-tile-grid' },
    { tabLabel: 'Combo', tileTestId: 'combo-tile-0', name: 'combo-tile-grid' },
    { tabLabel: 'Key Override', tileTestId: 'ko-tile-0', name: 'ko-tile-grid' },
    { tabLabel: 'Alt Repeat Key', tileTestId: 'arep-tile-0', name: 'ar-tile-grid' },
  ]

  for (const grid of tileGrids) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(grid.tabLabel)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] ${grid.tabLabel} tab not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)

    const tile = page.locator(`[data-testid="${grid.tileTestId}"]`)
    if (await isAvailable(tile)) {
      await captureNamed(page, grid.name, { fullPage: true })
    } else {
      console.log(`  [skip] ${grid.tileTestId} not found`)
    }
  }

  // Return to Basic tab
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 14: Macro Edit Modal (list mode + edit mode) ---

async function captureMacroEditModal(page: Page): Promise<void> {
  console.log('\n--- Phase 14: Macro Edit Modal ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const macroTab = editorContent.locator('button', { hasText: /^Macro$/ })
  if (!(await isAvailable(macroTab))) {
    console.log('  [skip] Macro tab not found')
    return
  }
  await macroTab.first().click()
  await page.waitForTimeout(300)

  // Prefer an already-configured macro so the screenshot reflects a real list/edit UI
  // without mutating device state. If none are configured we skip.
  const configuredTile = page.locator('[data-testid^="macro-tile-"][data-configured]').first()
  if (!(await isAvailable(configuredTile))) {
    console.log('  [skip] No configured macro tile found — configure a macro on the device first')
    return
  }

  // Deselect any keymap key left selected by earlier phases; otherwise clicking a
  // macro tile assigns its keycode to the selected key instead of opening the modal.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tabbed-keycodes-root"]') as HTMLElement | null
    el?.click()
  })
  await page.waitForTimeout(200)

  await configuredTile.click()
  const modal = page.locator('[data-testid="macro-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 2000 })
  } catch {
    console.log('  [skip] Macro modal did not open')
    return
  }

  try {
    await captureNamed(page, 'macro-list-mode', { element: modal })

    const firstKey = modal.locator('[data-testid="keycode-field"]').first()
    if (!(await isAvailable(firstKey))) {
      console.log('  [warn] No keycode-field found — edit-mode capture skipped')
      return
    }
    await firstKey.click()
    const closeEditBtn = modal.locator('[data-testid="macro-close-edit"]')
    try {
      await closeEditBtn.waitFor({ state: 'visible', timeout: 1500 })
    } catch {
      console.log('  [warn] edit mode did not activate — edit-mode capture skipped')
      return
    }
    await captureNamed(page, 'macro-edit-mode', { element: modal })
    await closeEditBtn.click()
    await page.waitForTimeout(300)
  } finally {
    const closeBtn = modal.locator('[data-testid="macro-modal-close"]')
    if (await isAvailable(closeBtn)) {
      await closeBtn.click().catch(() => { /* modal may already be gone */ })
      await page.waitForTimeout(300)
    }
  }
}

// --- Main ---

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

  // Resolve actual userData path from the running Electron process
  const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'))
  const favBase = join(userDataPath, 'sync', 'favorites')
  console.log(`userData: ${userDataPath}`)

  // Seed dummy data into the correct directories
  const favBackups = seedDummyFavorites(favBase)
  const kbBase = join(userDataPath, 'sync', 'keyboards')
  const snapBackups = seedDummySnapshots(kbBase)
  const taBackup = await seedDummyTypingAnalytics(userDataPath, Date.now())
  const filterStoreBackups = seedDummyFilterStore(kbBase)
  console.log(
    `Seeded dummy data: fav=${favBackups.size} entries, snap=${DUMMY_SNAPSHOTS.length} keyboards, typing-analytics=${DUMMY_TA_UID}, filter-store=${filterStoreBackups.size} files`,
  )

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    // First post-launch call: wait a bit for the async startup-notification
    // fetch to land so we don't race past it and capture a later screen with
    // the modal still up.
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })
    await captureDeviceSelection(page)       // 01
    await captureDataModal(page)             // 02
    await captureSettingsModal(page)         // named: settings-troubleshooting, settings-defaults
    await captureAnalyzePage(page)           // named: analyze-heatmap, analyze-wpm-time-series, analyze-wpm-time-of-day, analyze-interval-time-series, analyze-interval-distribution, analyze-activity-keystrokes, analyze-activity-calendar, analyze-ergonomics, analyze-ergonomics-learning, analyze-finger-assignment-modal, analyze-layer-keystrokes, analyze-layer-activations

    const connected = await connectDevice(page)
    if (!connected) {
      console.log('Failed to connect. Only device selection screenshots captured.')
      return
    }
    await ensureEditorMode(page)             // exit Typing Test if persisted from prior run

    await captureKeymapEditor(page)          // 03
    await captureLayerNavigation(page)       // 04-06
    await captureKeycodeCategories(page)     // 07+ (count varies by keyboard features)
    await captureKeyboardTab(page)           // keyboard-tab-device-list, keyboard-tab-keymap
    await captureSidebarTools(page)          // toolbar, zoom, typing-test
    await captureModalEditors(page)          // lighting, combo, ko, ar (when available)
    await captureJsonEditors(page)           // json-editor-tap-dance, json-editor-macro
    await captureEditorSettings(page)        // editor-settings-save
    await captureOverlayPanel(page)          // overlay-tools, overlay-save
    await captureStatusBar(page)             // status-bar
    await captureFavorites(page)             // inline-favorites
    await captureKeyPopover(page)            // key-popover-key/code/modifier/lt
    await captureBasicViewVariants(page)     // named: basic-{ansi,iso,jis,list}-view
    await captureLayerPanelStates(page)      // layer-panel-collapsed/expanded
    await captureTileGrids(page)             // td-tile-grid, macro-tile-grid
    await captureMacroEditModal(page)        // macro-list-mode, macro-edit-mode

    console.log(`\nAll screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
    restoreFavorites(favBackups, favBase)
    restoreSnapshots(snapBackups)
    restoreTypingAnalytics(taBackup)
    restoreFilterStore(filterStoreBackups)
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
