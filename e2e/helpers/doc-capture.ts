// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Pipette operation guide documentation.
// Usage: pnpm build && pnpm doc:screenshots
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page, Locator } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { dismissNotificationModal, isAvailable } from './doc-capture-common'

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

// --- Dummy snapshot data for File tab ---

const DUMMY_SNAPSHOTS = [
  {
    uid: 'doc-dummy-uid-1',
    name: 'Corne',
    entries: [
      { id: 'doc-snap-1', label: 'Default', filename: 'Corne_2026-03-10T12-00-00.pipette', savedAt: '2026-03-10T12:00:00.000Z', updatedAt: '2026-03-15T09:30:00.000Z', vilVersion: 2 },
      { id: 'doc-snap-2', label: 'Gaming', filename: 'Corne_2026-03-12T14-30-00.pipette', savedAt: '2026-03-12T14:30:00.000Z', vilVersion: 2 },
    ],
  },
  {
    uid: 'doc-dummy-uid-2',
    name: 'Sofle',
    entries: [
      { id: 'doc-snap-3', label: 'Work', filename: 'Sofle_2026-03-08T09-00-00.pipette', savedAt: '2026-03-08T09:00:00.000Z', vilVersion: 2 },
    ],
  },
]

function seedDummySnapshots(snapshotBase: string): Map<string, string | null> {
  const backups = new Map<string, string | null>()
  for (const kb of DUMMY_SNAPSHOTS) {
    const dir = join(snapshotBase, kb.uid, 'snapshots')
    mkdirSync(dir, { recursive: true })
    const indexPath = join(dir, 'index.json')
    backups.set(indexPath, existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null)
    writeFileSync(indexPath, JSON.stringify({ uid: kb.uid, entries: kb.entries }, null, 2), 'utf-8')
  }
  return backups
}

function restoreSnapshots(backups: Map<string, string | null>): void {
  for (const [path, original] of backups) {
    if (original != null) {
      writeFileSync(path, original, 'utf-8')
    } else {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }
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
  console.log(`Seeded dummy data: fav=${favBackups.size} entries, snap=${DUMMY_SNAPSHOTS.length} keyboards`)

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
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
