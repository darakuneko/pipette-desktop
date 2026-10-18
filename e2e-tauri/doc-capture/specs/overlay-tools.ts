// SPDX-License-Identifier: GPL-2.0-or-later
//
// The keymap editor's keycodes overlay on its own: `overlay-tools.png`
// (Settings / Import tab) plus `overlay-save.png` and
// `editor-settings-save.png` (Save tab), the same screenshots the main
// capture takes, without its other phases.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/overlay-tools.ts

import {
  captureNamed,
  connectToDevice,
  dismissNotificationModal,
  openOverlayTab,
  outputDirectory,
  overlayTabNotFoundMessage,
  prepareCapture,
} from '../common'
import { VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import { Page } from '../page'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME

describe('overlay tools screenshots', () => {
  it('captures the Settings / Import and Save tabs of the keycodes overlay', async () => {
    const page = new Page()
    await prepareCapture(page)

    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)
    await dismissNotificationModal(page)

    // The Tools overlay tab isn't unlock-gated, so no clickThroughUnlock is
    // needed here — just open the keycodes overlay and select the tab.
    if (!(await openOverlayTab(page, 'tools'))) {
      console.log(`  [skip] ${overlayTabNotFoundMessage('tools')}`)
      return
    }

    await captureNamed(page, 'overlay-tools')

    if (await openOverlayTab(page, 'data')) {
      await captureNamed(page, 'overlay-save')
      await captureNamed(page, 'editor-settings-save')
    } else {
      console.log(`  [skip] ${overlayTabNotFoundMessage('data')}`)
    }

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
