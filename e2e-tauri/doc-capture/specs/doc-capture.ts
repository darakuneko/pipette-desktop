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

import { restartApp } from '../../helpers/app'
import { userDataPath } from '../../helpers/driver'
import {
  connectToEditor,
  outputDirectory,
  prepareCapture,
  waitForMachineHash,
  waitForSeededAnalytics,
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

describe('documentation screenshots', () => {
  it('captures the device-selection screen, Analyze and the keymap editor', async () => {
    const page = new Page()
    console.log(`Screenshots: ${outputDirectory()}`)

    // The first launch wrote this device's machine hash, which the typing
    // analytics seed reads; the seed then removes sync_state.json, so the
    // next launch rebuilds the cache from the seeded days.
    await waitForMachineHash()
    await restartApp(() => seedCaptureData(userDataPath(), Date.now()))
    await waitForSeededAnalytics()
    await prepareCapture(page)

    await captureDeviceSelection(page)       // 01, file-tab
    await captureDataModal(page)             // data-sidebar-*
    await captureSettingsModal(page)         // settings-defaults, settings-zoom
    await captureAnalyzePage(page)           // analyze-*

    await connectToEditor(page)

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
