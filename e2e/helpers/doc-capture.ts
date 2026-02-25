// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Pipette operation guide documentation.
// Usage: pnpm build && pnpm doc:screenshots
import { _electron as electron } from '@playwright/test'
import type { Page, Locator } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}

async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
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

async function dismissNotificationModal(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="notification-modal-backdrop"]')
  if (await backdrop.isVisible()) {
    console.log('Dismissing notification modal...')
    const closeBtn = page.locator('[data-testid="notification-modal-close"]')
    if (await isAvailable(closeBtn)) {
      await closeBtn.click()
    } else {
      await backdrop.click({ position: { x: 10, y: 10 } })
    }
    await page.waitForTimeout(500)
  }
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
}

// --- Phase 1.5: Data Modal (from device selector) ---

async function captureDataModal(page: Page): Promise<void> {
  console.log('\n--- Phase 1.5: Data Modal ---')

  const dataBtn = page.locator('[data-testid="data-button"]')
  if (!(await isAvailable(dataBtn))) {
    console.log('  [skip] data-button not found')
    return
  }

  await dataBtn.click()
  await page.waitForTimeout(500)

  const backdrop = page.locator('[data-testid="data-modal-backdrop"]')
  try {
    await backdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Data modal did not open')
    return
  }

  await capture(page, 'data-modal', { fullPage: true })

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

  // Switch to Troubleshooting tab
  const troubleshootingTab = page.locator('[data-testid="settings-tab-troubleshooting"]')
  if (await isAvailable(troubleshootingTab)) {
    await troubleshootingTab.click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'settings-troubleshooting', { fullPage: true })
  } else {
    console.log('  [skip] troubleshooting tab not found')
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

  const editorContent = page.locator('[data-testid="editor-content"]')

  for (const layerNum of [1, 2]) {
    const btn = editorContent.locator('button', { hasText: new RegExp(`^${layerNum}$`) })
    if (await isAvailable(btn)) {
      await btn.first().click()
      await page.waitForTimeout(500)
      await capture(page, `layer-${layerNum}`, { fullPage: true })
    }
  }

  const layer0Btn = editorContent.locator('button', { hasText: /^0$/ })
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.first().click()
    await page.waitForTimeout(500)
  }
}

// --- Phase 4: Keycode Category Tabs ---

const KEYCODE_TABS = [
  { id: 'basic', label: 'Basic' },
  { id: 'layers', label: 'Layers' },
  { id: 'modifiers', label: 'Modifiers' },
  { id: 'tapDance', label: 'Tap-Hold / Tap Dance' },
  { id: 'macro', label: 'Macro' },
  { id: 'quantum', label: 'Quantum' },
  { id: 'media', label: 'Media' },
  { id: 'midi', label: 'MIDI' },
  { id: 'backlight', label: 'Lighting' },
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
    await capture(page, `tab-${tab.id}`, { fullPage: true })
  }

  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 5: Toolbar / Sidebar ---

async function captureSidebarTools(page: Page): Promise<void> {
  console.log('\n--- Phase 5: Toolbar ---')

  await capture(page, 'toolbar', { fullPage: true })

  const dualModeBtn = page.locator('[data-testid="dual-mode-button"]')
  if (await isAvailable(dualModeBtn)) {
    await dualModeBtn.click()
    await page.waitForTimeout(500)
    await capture(page, 'dual-mode', { fullPage: true })
    await dualModeBtn.click()
    await page.waitForTimeout(500)
  } else {
    console.log('  [skip] dual-mode-button not found')
  }

  const zoomInBtn = page.locator('[data-testid="zoom-in-button"]')
  if (await isAvailable(zoomInBtn)) {
    await zoomInBtn.click()
    await zoomInBtn.click()
    await page.waitForTimeout(300)
    await capture(page, 'zoom-in', { fullPage: true })
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
    await capture(page, 'typing-test', { fullPage: true })
    await dismissNotificationModal(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await dismissNotificationModal(page)
    await typingTestBtn.click({ timeout: 5000 }).catch(() => {
      console.log('  [warn] Could not toggle typing test off')
    })
    await page.waitForTimeout(500)
  } else {
    console.log('  [skip] typing-test-button not found')
  }
}

// --- Phase 6: Modal Editors ---

interface ModalCapture {
  name: string
  keycodeTab: string
  settingsTestId: string
  backdropPrefix: string
  detailTileTestId?: string
}

const MODAL_CAPTURES: ModalCapture[] = [
  {
    name: 'lighting',
    keycodeTab: 'Lighting',
    settingsTestId: 'lighting-settings-btn',
    backdropPrefix: 'lighting-modal',
  },
  {
    name: 'combo',
    keycodeTab: 'Quantum',
    settingsTestId: 'combo-settings-btn',
    backdropPrefix: 'combo-modal',
    detailTileTestId: 'combo-tile-0',
  },
  {
    name: 'key-override',
    keycodeTab: 'Quantum',
    settingsTestId: 'key-override-settings-btn',
    backdropPrefix: 'ko-modal',
    detailTileTestId: 'ko-tile-0',
  },
  {
    name: 'alt-repeat-key',
    keycodeTab: 'Quantum',
    settingsTestId: 'alt-repeat-key-settings-btn',
    backdropPrefix: 'ar-modal',
    detailTileTestId: 'ar-tile-0',
  },
]

async function openEditorModal(
  page: Page,
  keycodeTab: string,
  settingsTestId: string,
  backdropTestId: string,
): Promise<boolean> {
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

  for (const modal of MODAL_CAPTURES) {
    const backdropTestId = `${modal.backdropPrefix}-backdrop`
    if (!(await openEditorModal(page, modal.keycodeTab, modal.settingsTestId, backdropTestId))) {
      console.log(`  [skip] ${modal.name} modal not available`)
      continue
    }

    await capture(page, `${modal.name}-modal`, { fullPage: true })

    if (modal.detailTileTestId) {
      const tile = page.locator(`[data-testid="${modal.detailTileTestId}"]`)
      if (await isAvailable(tile)) {
        await tile.click()
        await page.waitForTimeout(300)
        await capture(page, `${modal.name}-detail`, { fullPage: true })
      }
    }

    await page.locator(`[data-testid="${modal.backdropPrefix}-close"]`).click()
    await page.waitForTimeout(300)
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
    await capture(page, 'editor-settings-save', { fullPage: true })
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
    await capture(page, 'overlay-tools', { fullPage: true })
  }

  if (await switchOverlayTab(page, 'overlay-tab-data')) {
    await capture(page, 'overlay-save', { fullPage: true })
  }

  await closeOverlay(page)
}

// --- Phase 8: Status Bar ---

async function captureStatusBar(page: Page): Promise<void> {
  console.log('\n--- Phase 8: Status Bar ---')

  const statusBar = page.locator('[data-testid="status-bar"]')
  if (await isAvailable(statusBar)) {
    await capture(page, 'status-bar', { element: statusBar })
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
  await capture(page, 'inline-favorites', { fullPage: true })

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

  await keyLabel.dblclick({ force: true })
  await page.waitForTimeout(500)

  const popover = page.locator('[data-testid="key-popover"]')
  if (!(await isAvailable(popover))) {
    console.log('  [skip] Key popover did not open')
    return
  }

  // Capture Key tab (default view with search results)
  await capture(page, 'key-popover-key', { fullPage: true })

  // Switch to Code tab and capture
  await page.locator('[data-testid="popover-tab-code"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'key-popover-code', { fullPage: true })

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

  await capture(page, 'key-popover-modifier', { fullPage: true })

  // Switch to LT mode to show layer selector
  await page.locator('[data-testid="popover-mode-mod-mask"]').click()
  await page.waitForTimeout(200)
  await page.locator('[data-testid="popover-mode-lt"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'key-popover-lt', { fullPage: true })

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
    { value: 'list', name: 'basic-list-view' },
  ]

  for (const view of viewTypes) {
    await ensureOverlayOpen(page)
    await switchOverlayTab(page, 'overlay-tab-tools')
    await viewTypeSelector.selectOption(view.value)
    await page.waitForTimeout(500)
    await closeOverlay(page)
    await capture(page, view.name, { fullPage: true })
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
    await capture(page, 'layer-panel-collapsed', { fullPage: true })

    // Re-expand
    const expandBtnAfter = page.locator('[data-testid="layer-panel-expand-btn"]')
    if (await isAvailable(expandBtnAfter)) {
      await expandBtnAfter.click()
      await page.waitForTimeout(500)
    }
    await capture(page, 'layer-panel-expanded', { fullPage: true })
  } else if (await isAvailable(expandBtn)) {
    // Panel is collapsed — capture collapsed first
    await capture(page, 'layer-panel-collapsed', { fullPage: true })

    await expandBtn.click()
    await page.waitForTimeout(500)
    await capture(page, 'layer-panel-expanded', { fullPage: true })
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
      await capture(page, grid.name, { fullPage: true })
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

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 900 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page)
    await captureDeviceSelection(page)       // 01
    await captureDataModal(page)             // 02
    await captureSettingsModal(page)         // named: settings-troubleshooting, settings-defaults

    const connected = await connectDevice(page)
    if (!connected) {
      console.log('Failed to connect. Only device selection screenshots captured.')
      return
    }

    await captureKeymapEditor(page)          // 03
    await captureLayerNavigation(page)       // 04-06
    await captureKeycodeCategories(page)     // 07-15 (MIDI skipped for GPK60)
    await captureSidebarTools(page)          // 16-19
    await captureModalEditors(page)          // 20-26
    await captureEditorSettings(page)        // 27 (editor-settings-save)
    await captureOverlayPanel(page)          // 28-29 (overlay-tools, overlay-save)
    await captureStatusBar(page)             // 30
    await captureFavorites(page)             // 31
    await captureKeyPopover(page)            // 32-35
    await captureBasicViewVariants(page)     // 36-38
    await captureLayerPanelStates(page)      // 39-40
    await captureTileGrids(page)             // 41-42

    console.log(`\nAll screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
