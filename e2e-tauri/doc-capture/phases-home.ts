// SPDX-License-Identifier: GPL-2.0-or-later
//
// The captures of the device-selection screen: the screen itself and its
// File tab, the Data modal's tree, and the Settings modal.

import { capture, captureNamed, isAvailable } from './common'
import type { Locator, Page } from './page'

// Click a tree-nav branch button only when it reports aria-expanded=false, so
// a branch already expanded is not collapsed again by the toggle handler.
// When already expanded, skip the click and the settle delay.
async function expandBranchIfCollapsed(branch: Locator, settleMs = 300): Promise<void> {
  if ((await branch.getAttribute('aria-expanded')) === 'true') return
  await branch.click()
  await branch.page().waitForTimeout(settleMs)
}

// --- Phase 1: Device Selection ---

export async function captureDeviceSelection(page: Page): Promise<void> {
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

export async function captureDataModal(page: Page): Promise<void> {
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
  // by aria-expanded to avoid collapsing an already-open branch.
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

export async function captureSettingsModal(page: Page): Promise<void> {
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

    const zoomRow = page.locator('[data-testid="settings-zoom-factor-row"]')
    if (await isAvailable(zoomRow)) {
      await zoomRow.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await captureNamed(page, 'settings-zoom', { fullPage: true })
    } else {
      console.log('  [skip] zoom factor row not found')
    }
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
