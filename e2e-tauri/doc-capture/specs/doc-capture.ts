// SPDX-License-Identifier: GPL-2.0-or-later
//
// The main screenshot capture of the operation guide (`pnpm doc:screenshots`):
// the device-selection screen, Analyze on the seeded typing analytics, and
// the keymap editor of the virtual keyboard. The app runs with the session's
// temporary userData directory (wdio.conf.ts); the seed goes into it while
// the app is stopped, and the screenshots go to docs/screenshots or to the
// directory capture-paths.ts allows instead.
//
// Numbered screenshots (`NN-name.png`, `capture`) follow the order of the
// calls below; named ones (`name.png`, `captureNamed`) do not depend on it.

import { existsSync } from 'node:fs'
import { browser } from '@wdio/globals'
import { restartApp, vialApi, VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import { DUMMY_TA_UID } from '../../helpers/analyze-seed'
import { userDataPath } from '../../helpers/driver'
import {
  connectToDevice,
  deviceButton,
  dismissNotificationModal,
  outputDirectory,
  resetToEditorMode,
  waitForUnlockDialog,
} from '../common'
import { Page } from '../page'
import { captureAnalyzePage } from '../phases-analyze'
import {
  captureEditorSettings,
  captureJsonEditors,
  captureKeyboardTab,
  captureKeycodeCategories,
  captureKeymapEditor,
  captureLayerNavigation,
  captureModalEditors,
  captureOverlayPanel,
  captureSidebarTools,
  captureStatusBar,
} from '../phases-editor'
import {
  captureBasicViewVariants,
  captureFavorites,
  captureKeyLabelKeymapApply,
  captureKeyPopover,
  captureLayerPanelStates,
  captureMacroEditModal,
  captureTileGrids,
} from '../phases-editor-details'
import { captureDataModal, captureDeviceSelection, captureSettingsModal } from '../phases-home'
import { seedCaptureData } from '../seed'

/** The page size every screenshot is taken at: the window's default size
 *  on a screen of exactly that size (an Xvfb screen of 1440x1024, where the
 *  window has no frame), at scale 1. */
const VIEWPORT = { width: 1440, height: 1024, scale: 1 }
const STARTUP_TIMEOUT_MS = 30_000

async function assertViewport(): Promise<void> {
  const actual = await browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scale: window.devicePixelRatio,
  }))
  if (actual.width !== VIEWPORT.width || actual.height !== VIEWPORT.height || actual.scale !== VIEWPORT.scale) {
    throw new Error(
      `the capture needs a ${VIEWPORT.width}x${VIEWPORT.height} page at scale ${VIEWPORT.scale} ` +
        `(run it under an Xvfb screen of ${VIEWPORT.width}x${VIEWPORT.height}), not ` +
        `${actual.width}x${actual.height} at scale ${actual.scale}`,
    )
  }
}

/** Waits until the device list shows the virtual keyboard, so the first
 *  screenshot has it. */
async function waitForDeviceList(page: Page): Promise<void> {
  await deviceButton(page, VIRTUAL_DEVICE_NAME).waitFor({ state: 'visible', timeout: STARTUP_TIMEOUT_MS })
  await page.waitForTimeout(1000)
}

async function connectDevice(page: Page): Promise<void> {
  if (!(await connectToDevice(page, VIRTUAL_DEVICE_NAME))) {
    throw new Error(`could not connect to ${VIRTUAL_DEVICE_NAME}`)
  }
  console.log(`Connected to ${VIRTUAL_DEVICE_NAME}`)
  // The virtual keyboard is locked on every launch. Clearing a possible
  // Unlock dialog and resetting to the keymap editor keeps every phase
  // starting from the same state.
  await waitForUnlockDialog(page)
  await resetToEditorMode(page)
}

describe('documentation screenshots', () => {
  it('captures the device-selection screen, Analyze and the keymap editor', async () => {
    const page = new Page()
    console.log(`Screenshots: ${outputDirectory()}`)

    // The first launch wrote this device's machine hash, which the typing
    // analytics seed reads; the seed then removes sync_state.json, so the
    // next launch rebuilds the cache from the seeded days.
    await browser.waitUntil(() => existsSync(userDataPath('local', 'typing-analytics', 'sync_state.json')), {
      timeout: STARTUP_TIMEOUT_MS,
      timeoutMsg: 'the app did not write sync_state.json',
    })
    await restartApp(() => seedCaptureData(userDataPath(), Date.now()))
    await browser.waitUntil(
      async () => (await vialApi<unknown[]>('typingAnalyticsListItemsLocal', DUMMY_TA_UID)).length > 0,
      { timeout: STARTUP_TIMEOUT_MS, timeoutMsg: 'the seeded typing analytics are not in the cache' },
    )
    await assertViewport()
    await waitForDeviceList(page)
    await dismissNotificationModal(page)

    await captureDeviceSelection(page)       // 01, file-tab
    await captureDataModal(page)             // data-sidebar-*
    await captureSettingsModal(page)         // settings-defaults, settings-zoom
    await captureAnalyzePage(page)           // analyze-*

    await connectDevice(page)

    await captureKeymapEditor(page)          // 02
    await captureLayerNavigation(page)       // 03-05
    await captureKeycodeCategories(page)     // tab-*
    await captureKeyboardTab(page)           // keyboard-tab-device-list, keyboard-tab-keymap
    await captureSidebarTools(page)          // toolbar, zoom-in, typing-test
    await captureModalEditors(page)          // lighting-modal, combo / key-override / alt-repeat-key
    await captureJsonEditors(page)           // json-editor-tap-dance, json-editor-macro
    await captureEditorSettings(page)        // editor-settings-save
    await captureOverlayPanel(page)          // overlay-tools, overlay-save
    await captureStatusBar(page)             // status-bar
    await captureKeyLabelKeymapApply(page)   // key-label-simulation-tabs, key-label-keymap-apply-modal
    await captureFavorites(page)             // inline-favorites
    await captureKeyPopover(page)            // key-popover-key/code/modifier/lt
    await captureBasicViewVariants(page)     // basic-{ansi,iso,jis,list}-view
    await captureLayerPanelStates(page)      // layer-panel-collapsed/expanded
    await captureTileGrids(page)             // td / macro / combo / ko / ar tile grids
    await captureMacroEditModal(page)        // macro-list-mode, macro-edit-mode

    console.log(`\nAll screenshots saved to: ${outputDirectory()}`)
  })
})
