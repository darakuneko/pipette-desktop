// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Theme Packs modal (Settings → Tools): its Installed tab, with two of
// the sample theme packs installed, and its Find on Hub tab, searching the
// fake Hub's copies of the sample theme packs.
//
// Settings (and Theme Packs behind it) is only reachable from the
// device-selector screen (SettingsModal renders only while no device is
// connected), so the whole capture happens there. The screenshots are
// cropped to the modal.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/theme-packs.ts

import { dataOf, readSample } from '../../helpers/hub'
import { captureNamed, isAvailable, outputDirectory } from '../common'
import { seedHubThemePacks, startSignedInToHub } from '../hub-capture'
import { Page } from '../page'

/**
 * Saves the screenshot `name`, cropped to the element `testId` when it is
 * there, else the whole window.
 */
async function capture(page: Page, name: string, testId: string): Promise<void> {
  const locator = page.locator(`[data-testid="${testId}"]`)
  await captureNamed(page, name, (await isAvailable(locator)) ? { element: locator } : undefined)
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
    await disconnectBtn.click()
    await page.waitForTimeout(500)
  }
}

async function openThemePacksModal(page: Page): Promise<boolean> {
  await ensureDeviceSelectorScreen(page)

  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] settings-button not found')
    return false
  }
  await settingsBtn.click()
  await page.waitForTimeout(500)

  const settingsBackdrop = page.locator('[data-testid="settings-backdrop"]')
  if (!(await settingsBackdrop.isVisible())) {
    console.log('  [skip] settings modal did not open')
    return false
  }

  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click()
    await page.waitForTimeout(300)
  }

  const editBtn = page.locator('[data-testid="settings-theme-packs-button"]')
  if (!(await isAvailable(editBtn))) {
    console.log('  [skip] Theme Packs Edit button not found')
    return false
  }
  await editBtn.click()
  await page.waitForTimeout(500)

  const modal = page.locator('[data-testid="theme-packs-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Theme Packs modal did not open')
    return false
  }
  return true
}

async function captureInstalledTab(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Installed tab ---')
  const installedTab = page.locator('[data-testid="theme-packs-tab-installed"]')
  if (await isAvailable(installedTab)) {
    await installedTab.click()
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(500)
  await capture(page, 'theme-packs-installed', 'theme-packs-modal')
}

async function captureFindOnHubTab(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Find on Hub tab ---')
  const hubTab = page.locator('[data-testid="theme-packs-tab-hub"]')
  if (!(await isAvailable(hubTab))) {
    console.log('  [skip] Find on Hub tab not found')
    return
  }
  await hubTab.click()
  await page.waitForTimeout(300)

  const input = page.locator('[data-testid="theme-packs-search-input"]')
  if (!(await isAvailable(input))) {
    console.log('  [skip] search input not found')
    return
  }
  await input.fill('Solarized')

  const searchBtn = page.locator('[data-testid="theme-packs-search-button"]')
  if (await isAvailable(searchBtn)) {
    await searchBtn.click()
  }

  const firstResult = page.locator('[data-testid^="theme-packs-hub-row-"]')
  try {
    await firstResult.first().waitFor({ state: 'visible', timeout: 5000 })
    console.log('  Hub results visible')
  } catch {
    console.log('  [warn] No Hub results returned (Hub state?)')
  }
  await page.waitForTimeout(500)
  await capture(page, 'theme-packs-hub', 'theme-packs-modal')
}

/** The sample theme packs installed for the Installed tab. */
const INSTALLED_THEMES = ['themes/catppuccin-mocha.json', 'themes/tokyo-night.json']

describe('Theme Packs screenshots', () => {
  it('captures the Installed and Find on Hub tabs', async () => {
    const page = new Page()
    await seedHubThemePacks()
    await startSignedInToHub(page)
    for (const path of INSTALLED_THEMES) await dataOf('themePackImportApply', readSample(path))

    if (!(await openThemePacksModal(page))) return

    await captureInstalledTab(page)
    await captureFindOnHubTab(page)

    console.log(`\nTheme Packs screenshots saved to: ${outputDirectory()}`)
  })
})
