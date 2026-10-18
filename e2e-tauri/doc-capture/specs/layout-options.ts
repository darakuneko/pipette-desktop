// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Layout Options screenshots: a dummy JSON definition with layout
// options (fixtures/e2e_test_001.json) loaded through the device selector's
// dummy button, and the Layout tab of the keycodes overlay before and after
// an option is changed.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/layout-options.ts

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickIntoFileDialog } from '../../helpers/app'
import { captureNamed, dismissNotificationModal, openOverlayTab, outputDirectory, prepareCapture } from '../common'
import { Page } from '../page'

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/e2e_test_001.json')

describe('layout options screenshots', () => {
  it('captures the Layout tab of a definition with layout options', async () => {
    const page = new Page()
    await prepareCapture(page)

    // The dummy button opens a file dialog; the development tools answer
    // it with the fixture.
    const dummyBtn = page.locator('[data-testid="dummy-button"]')
    await dummyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickIntoFileDialog('[data-testid="dummy-button"]', FIXTURE_PATH)

    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(2000)

    console.log('\n--- Layout Options Screenshots ---')

    await dismissNotificationModal(page)

    // Open overlay panel and switch to Layout tab
    if (!(await openOverlayTab(page, 'layout'))) {
      throw new Error('Layout tab not found — keyboard definition may not have layout options')
    }
    await page.waitForTimeout(200)
    await captureNamed(page, 'layout-options-open')

    // Change first visible option to capture the changed state.
    // Scope to the Layout tab content area (visible, not inert) to avoid
    // matching selects from the hidden Tools/Save tabs.
    const layoutContent = page.locator('[data-testid="keycodes-overlay-panel"] > div:not([inert]) select:not([aria-hidden="true"])')
    const checkboxes = page.locator('[data-testid="keycodes-overlay-panel"] > div:not([inert]) input[type="checkbox"]')
    if ((await layoutContent.count()) > 0) {
      await layoutContent.first().selectOption({ index: 1 })
      await page.waitForTimeout(500)
      await captureNamed(page, 'layout-options-changed')
    } else if ((await checkboxes.count()) > 0) {
      await checkboxes.first().click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'layout-options-changed')
    }

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
