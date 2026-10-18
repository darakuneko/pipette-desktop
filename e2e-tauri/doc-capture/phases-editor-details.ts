// SPDX-License-Identifier: GPL-2.0-or-later
//
// The captures of the keymap editor's details: the Key Label simulation and
// its apply modal, the inline favorites, the key popover, the Basic tab's
// views, the layer panel, the tile grids and the macro modal.

import { captureNamed, escapeRegex, isAvailable } from './common'
import type { Page } from './page'
import { DOC_CAPTURE_COLEMAK_NAME } from './seed'

// --- Phase 8b: Simulation/Base tabs + Key Label "Apply to Keymap" confirm modal ---

// Drives the footer's Keyboard Layout select to the seeded `keymapApplicable`
// Colemak entry (seedDummyKeyLabel in seed.ts). Selecting it does not open
// any modal by itself — it switches the display and reveals the vertical
// simulation/Base tabs on the keymap. This waits for the simulation tab,
// clicks the Apply button on its layer-indicator row (the only way left to
// reach the Rewrite confirm modal), and captures it. Dismisses with Cancel,
// then resets the select back to QWERTY so every capture AFTER this one
// (Favorites, Key Popover, Basic View variants, ...) runs against the same
// untabbed QWERTY state every other phase assumes.
export async function captureKeyLabelKeymapApply(page: Page): Promise<void> {
  console.log('\n--- Phase 8b: Simulation/Base Tabs + Apply-to-Keymap Modal ---')

  const layoutTrigger = page.getByRole('button', { name: 'Key Labels' })
  const triggerCount = await layoutTrigger.count()
  if (triggerCount === 0) {
    console.log('  [skip] Keyboard Layout select trigger not found (button aria-label="Key Labels" — footer may be in Edit mode, or quickSettings/keyboardLayout is unset)')
    return
  }
  if (triggerCount > 1) {
    console.log(`  [skip] ambiguous match: ${triggerCount} buttons named "Key Labels" (expected exactly 1)`)
    return
  }
  await layoutTrigger.click()
  await page.waitForTimeout(300)

  const option = page.getByRole('option', { name: DOC_CAPTURE_COLEMAK_NAME })
  const optionCount = await option.count()
  if (optionCount === 0) {
    console.log(`  [skip] seeded option "${DOC_CAPTURE_COLEMAK_NAME}" not found in the layout dropdown (seedDummyKeyLabel may not have landed, or the dropdown didn't open)`)
    return
  }
  await option.click()
  await page.waitForTimeout(300)

  const simulationTab = page.locator('[data-testid="keymap-pack-tab-simulation"]')
  try {
    await simulationTab.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    // No tabs within the timeout means `remapKind` never became 'simulated'
    // for the seeded entry — either `keymapApplicable` or the map's own
    // `buildKeymapRewriteTable` build failed.
    console.log('  [skip] simulation tab did not appear within 3s (remapKind never became "simulated" — check keymapApplicable and buildKeymapRewriteTable on the seeded entry)')
    return
  }

  const applyButton = page.locator('[data-testid="keymap-pack-apply-button"]')
  if (!(await isAvailable(applyButton))) {
    console.log('  [skip] simulation tab\'s Apply button not found (keymapEditable — keyboard.keymap.size > 0 — was likely false)')
    return
  }

  // Capture the tab strip itself, undimmed, before the confirm modal opens.
  // The modal shot below dims this same background, which is enough for
  // spatial context but not for judging the simulated-colour key tint the
  // guide's prose describes — this shot gives that a clean reference.
  await captureNamed(page, 'key-label-simulation-tabs', { fullPage: true })

  await applyButton.click()
  await page.waitForTimeout(300)

  const modal = page.locator('[data-testid="keymap-apply-confirm-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] apply-to-keymap confirm modal did not open within 3s of clicking Apply')
    return
  }

  await captureNamed(page, 'key-label-keymap-apply-modal', { fullPage: true })
  console.log('  [ok] key-label-keymap-apply-modal.png captured')

  await page.locator('[data-testid="keymap-apply-confirm-cancel"]').click()
  await page.waitForTimeout(300)

  // Reset the select back to QWERTY (Default) — every capture after this
  // phase assumes the untabbed, unremapped state.
  await layoutTrigger.click()
  await page.waitForTimeout(300)
  const qwertyOption = page.getByRole('option', { name: 'QWERTY (Default)' })
  if (await isAvailable(qwertyOption)) {
    await qwertyOption.click()
    await page.waitForTimeout(300)
  } else {
    console.log('  [warn] could not find the QWERTY (Default) option to reset the layout select — later captures may run against Colemak')
  }
}

// --- Phase 9: Inline Favorites ---

export async function captureFavorites(page: Page): Promise<void> {
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

export async function captureKeyPopover(page: Page): Promise<void> {
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

export async function captureBasicViewVariants(page: Page): Promise<void> {
  console.log('\n--- Phase 11: Basic View Variants ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Switch to Basic tab first
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }

  const viewTypeTrigger = page.getByRole('button', { name: 'Basic Tab View' })
  if (!(await isAvailable(viewTypeTrigger))) {
    console.log('  [skip] basic view type selector not found')
    return
  }

  const viewListbox = page.getByRole('listbox', { name: 'Basic Tab View' })
  const viewTypes = [
    { value: 'ANSI', name: 'basic-ansi-view' },
    { value: 'ISO', name: 'basic-iso-view' },
    { value: 'JIS', name: 'basic-jis-view' },
    { value: 'LIST', name: 'basic-list-view' },
  ]

  for (const view of viewTypes) {
    await viewTypeTrigger.click()
    await page.waitForTimeout(200)
    await viewListbox.getByRole('option', { name: view.value, exact: true }).click()
    await page.waitForTimeout(500)
    await captureNamed(page, view.name, { fullPage: true })
  }

  // Restore ANSI view
  await viewTypeTrigger.click()
  await page.waitForTimeout(200)
  await viewListbox.getByRole('option', { name: 'ANSI', exact: true }).click()
  await page.waitForTimeout(300)
}

// --- Phase 12: Layer Panel States ---

export async function captureLayerPanelStates(page: Page): Promise<void> {
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

export async function captureTileGrids(page: Page): Promise<void> {
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

export async function captureMacroEditModal(page: Page): Promise<void> {
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
  // without mutating device state. If none are configured we skip. Macro tile 0 is
  // seeded as a text-only macro ("Hello") with no keycode field, so the edit-mode
  // capture below would find nothing to click — skip it in favor of another
  // configured tile (e.g. macro tile 1, seeded as a tap-KC_A action) whenever one
  // exists.
  const configuredTiles = page.locator('[data-testid^="macro-tile-"][data-configured]')
  const configuredCount = await configuredTiles.count()
  if (configuredCount === 0) {
    console.log('  [skip] No configured macro tile found — configure a macro on the device first')
    return
  }
  let configuredTile = configuredTiles.first()
  for (let i = 0; i < configuredCount; i++) {
    const candidate = configuredTiles.nth(i)
    if ((await candidate.getAttribute('data-testid')) !== 'macro-tile-0') {
      configuredTile = candidate
      break
    }
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
