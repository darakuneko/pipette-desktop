// SPDX-License-Identifier: GPL-2.0-or-later
//
// The captures of the keymap editor's main parts: the overview, the layers,
// the keycode tabs, the Keyboard tab, the toolbar and Typing Test, the
// editor modals, the JSON editors, the keycodes overlay and the status bar.

import {
  capture,
  captureNamed,
  clickThroughUnlock,
  closeKeycodesOverlay,
  dismissNotificationModal,
  escapeRegex,
  isAvailable,
  openOverlayTab,
  overlayTabNotFoundMessage,
  waitForTypingTestCountdown,
} from './common'
import type { Page } from './page'
import { VIRTUAL_DEVICE_NAME } from '../helpers/app'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME

// --- Phase 2: Keymap Editor Overview ---

export async function captureKeymapEditor(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Keymap Editor ---')
  await capture(page, 'keymap-editor-overview', { fullPage: true })
}

// --- Phase 3: Layer Navigation ---

export async function captureLayerNavigation(page: Page): Promise<void> {
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

// Basic is captured separately as basic-ansi-view.png (and the ISO / JIS /
// list variants), so it is not part of this generic tab-${id} pass.
const KEYCODE_TABS = [
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

export async function captureKeycodeCategories(page: Page): Promise<void> {
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

export async function captureKeyboardTab(page: Page): Promise<void> {
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

  // Click the connected device to show its keymap. The tile's text is
  // "{productName}›" (name span + chevron span), so an anchored regex on the
  // whole button would never match — anchor the exact name against the inner
  // `.font-medium` name span instead, mirroring connectToDevice's structure,
  // so a device whose name merely contains DEVICE_NAME can't match.
  const deviceBtn = editorContent
    .locator('button')
    .filter({ has: page.locator('.font-medium', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })
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

export async function captureSidebarTools(page: Page): Promise<void> {
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
    await clickThroughUnlock(page, typingTestBtn)
    await waitForTypingTestCountdown(page)
    await page.waitForTimeout(500)
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

export async function captureModalEditors(page: Page): Promise<void> {
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

export async function captureJsonEditors(page: Page): Promise<void> {
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

export async function captureEditorSettings(page: Page): Promise<void> {
  console.log('\n--- Phase 7: Editor Settings (Save Panel) ---')

  if (!(await openOverlayTab(page, 'data'))) {
    console.log(`  [skip] ${overlayTabNotFoundMessage('data')}`)
    return
  }
  await captureNamed(page, 'editor-settings-save', { fullPage: true })
}

// --- Phase 7.5: Overlay Panel ---

export async function captureOverlayPanel(page: Page): Promise<void> {
  console.log('\n--- Phase 7.5: Overlay Panel ---')

  const tabs = [
    ['tools', 'overlay-tools'],
    ['data', 'overlay-save'],
  ] as const

  for (const [tab, shotName] of tabs) {
    if (await openOverlayTab(page, tab)) {
      await captureNamed(page, shotName, { fullPage: true })
    } else {
      console.log(`  [skip] ${overlayTabNotFoundMessage(tab)}`)
    }
  }

  await closeKeycodesOverlay(page)
}

// --- Phase 8: Status Bar ---

export async function captureStatusBar(page: Page): Promise<void> {
  console.log('\n--- Phase 8: Status Bar ---')

  const statusBar = page.locator('[data-testid="status-bar"]')
  if (await isAvailable(statusBar)) {
    await captureNamed(page, 'status-bar', { element: statusBar })
  } else {
    console.log('  [skip] status-bar not found')
  }
}
