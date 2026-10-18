// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Key Labels modal (Settings → Tools): its Installed tab, with two Key
// Labels downloaded from the fake Hub and one imported from a file, and its
// Find on Hub tab, searching the fake Hub's copies of the sample Key
// Labels. The app is signed in to the fake Hub with a display name, so the
// rows show their Hub actions. The screenshots are cropped to the modal.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/key-labels.ts

import { join } from 'node:path'
import { dataOf, SAMPLE_PACKS, withFilesDialog } from '../../helpers/hub'
import { captureNamed, dismissNotificationModal, dismissOverlay, isAvailable, outputDirectory } from '../common'
import { seedHubKeyLabels, startSignedInToHub } from '../hub-capture'
import { Page } from '../page'

/** The fake Hub's Key Labels downloaded for the Installed tab. */
const DOWNLOADED_LABELS = ['Eucalyn', 'Astarte']
/** The sample Key Label imported from its file for the Installed tab. */
const IMPORTED_LABEL_FILE = 'key-labels/yamato.json'
/** Matches the two Japanese Key Labels on the fake Hub, neither of them
 *  installed. */
const HUB_SEARCH = 'ja'

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  await dismissNotificationModal(page)
}

async function capture(page: Page, name: string): Promise<void> {
  // Element-only capture so the static dim backdrop doesn't dominate the
  // image and the modal lands at full crop in the docs.
  const modal = page.locator('[data-testid="key-labels-modal"]')
  await captureNamed(page, name, (await isAvailable(modal)) ? { element: modal } : undefined)
}

/**
 * The Settings modal is only reachable from the device-selector screen.
 * Disconnect first if the app connected on launch, so the device selector
 * (and its settings-button) is reachable either way.
 */
async function ensureDeviceSelectorScreen(page: Page): Promise<void> {
  const disconnectBtn = page.locator('[data-testid="disconnect-button"]')
  if (await isAvailable(disconnectBtn)) {
    console.log('  Connected on launch — disconnecting to reach the device selector...')
    await disconnectBtn.click({ force: true })
    await page.waitForTimeout(500)
  }
}

async function openKeyLabelsModal(page: Page): Promise<boolean> {
  await ensureDeviceSelectorScreen(page)

  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] settings-button not found')
    return false
  }
  await settingsBtn.click({ force: true })
  await page.waitForTimeout(500)

  const settingsBackdrop = page.locator('[data-testid="settings-backdrop"]')
  if (!(await settingsBackdrop.isVisible())) {
    console.log('  [skip] settings modal did not open')
    return false
  }

  // The Tools tab is the default selection on first open, but click it
  // anyway to be deterministic across re-runs.
  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click({ force: true })
    await page.waitForTimeout(300)
  }

  const editBtn = page.locator('[data-testid="settings-key-labels-button"]')
  if (!(await isAvailable(editBtn))) {
    console.log('  [skip] Key Labels Manage Edit button not found')
    return false
  }
  await editBtn.click({ force: true })
  await page.waitForTimeout(500)

  const modal = page.locator('[data-testid="key-labels-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Key Labels modal did not open')
    return false
  }
  return true
}

async function captureInstalledTab(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Installed tab ---')
  const installedTab = page.locator('[data-testid="key-labels-tab-installed"]')
  if (await isAvailable(installedTab)) {
    await installedTab.click({ force: true })
    await page.waitForTimeout(300)
  }
  // Give metas refresh + sync notifications a moment to land.
  await page.waitForTimeout(500)
  // Populate the Updated column for every foreign row by invoking the
  // Sync IPC directly via window.vialAPI. Going through the UI would
  // leave a "Synced" inline badge on the last-clicked row; bypassing
  // the click handler skips that side effect so the captured screenshot
  // stays neutral. Best-effort: errors per row are logged and ignored.
  type FauxApi = { keyLabelHubSync(id: string): Promise<{ success: boolean; error?: string }> }
  type FauxWindow = Window & { vialAPI: FauxApi }
  const syncButtons = page.locator('[data-testid^="key-labels-sync-"]')
  const ids: string[] = []
  for (let i = 0; i < await syncButtons.count(); i++) {
    const testid = await syncButtons.nth(i).getAttribute('data-testid')
    if (testid) ids.push(testid.replace('key-labels-sync-', ''))
  }
  if (ids.length > 0) {
    console.log(`  Priming ${ids.length} foreign row(s) via keyLabelHubSync IPC so the Updated column shows real Hub timestamps`)
    const results = await page.evaluate(async (localIds: string[]) => {
      const api = (window as unknown as FauxWindow).vialAPI
      const out: { id: string; ok: boolean; error?: string }[] = []
      for (const id of localIds) {
        const res = await api.keyLabelHubSync(id)
        out.push({ id, ok: res.success, error: res.error })
      }
      // useKeyLabels.ts listens for this event and re-runs `keyLabelStoreList`,
      // which is how every modal instance picks up the new hubUpdatedAt.
      window.dispatchEvent(new Event('pipette:key-labels-changed'))
      return out
    }, ids)
    for (const r of results) {
      if (!r.ok) console.log(`    [warn] Sync failed for ${r.id}: ${r.error}`)
    }
    // Wait for the re-list to land in the DOM.
    await page.waitForTimeout(400)
  }
  await capture(page, 'key-labels-installed')
}

async function captureFindOnHubTab(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Find on Hub tab ---')
  const hubTab = page.locator('[data-testid="key-labels-tab-hub"]')
  if (!(await isAvailable(hubTab))) {
    console.log('  [skip] Find on Hub tab not found')
    return
  }
  await hubTab.click({ force: true })
  await page.waitForTimeout(300)

  const input = page.locator('[data-testid="key-labels-search-input"]')
  if (!(await isAvailable(input))) {
    console.log('  [skip] search input not found')
    return
  }
  // Two characters start the search after its 300ms debounce.
  await input.fill(HUB_SEARCH)

  // Wait for at least one download row to render OR for the empty state
  // to settle (whichever happens first), with a hard timeout cap.
  const firstResult = page.locator('[data-testid^="key-labels-download-"]')
  try {
    await firstResult.first().waitFor({ state: 'visible', timeout: 5000 })
    console.log('  Hub results visible')
  } catch {
    console.log('  [warn] No Hub results returned (Hub state?)')
  }
  await page.waitForTimeout(500)
  await capture(page, 'key-labels-hub')
}

describe('Key Labels screenshots', () => {
  it('captures the Installed and Find on Hub tabs', async () => {
    const page = new Page()
    const hubIds = await seedHubKeyLabels()
    await startSignedInToHub(page)
    for (const name of DOWNLOADED_LABELS) {
      const id = hubIds.get(name)
      if (!id) throw new Error(`the fake Hub has no Key Label ${name}`)
      await dataOf('keyLabelHubDownload', id)
    }
    const imported = await withFilesDialog<{ success: boolean }>([join(SAMPLE_PACKS, IMPORTED_LABEL_FILE)], 'keyLabelStoreImport')
    if (!imported.success) throw new Error(`${IMPORTED_LABEL_FILE} was not imported: ${JSON.stringify(imported)}`)

    await dismissOverlays(page)
    if (!(await openKeyLabelsModal(page))) return

    await captureInstalledTab(page)
    await captureFindOnHubTab(page)

    console.log(`\nKey Labels screenshots saved to: ${outputDirectory()}`)
  })
})
