// SPDX-License-Identifier: GPL-2.0-or-later
//
// Starting hidden in the tray with a locked keyboard. With trayResident and
// startInTray on, a launch that restores a view needing the keyboard
// unlocked shows the hidden window with the Unlock dialog, and hides it
// back into the tray once unlocked (useBootHiddenWindow). Three restore
// paths open the dialog from different places: the Typing View (App.tsx's
// view-mode restore), the Typing Test (the editor's Typing Test toggle,
// which asks to unlock a locked keyboard) and REC on in the plain editor.
// The plain editor with REC off needs no unlock, so the window stays
// hidden and no dialog comes up: the hook never opens the dialog itself.
// Last, a second launch shows the window of the app started hidden.
//
// The virtual keyboard is locked at every launch, so each restore asks
// again. The tests share one session and run in order; each restart quits
// the app, edits the keyboard's pipette_settings.json while no app runs,
// and launches it again on the same userData directory, where it
// reconnects to the keyboard of the last session.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  invokeCommand,
  restartApp,
  tid,
  UNLOCK_DIALOG_HEADING,
  UNLOCK_KEYS,
  unlockIfAsked,
  vialApi,
  VIRTUAL_DEVICE_NAME,
  virtualDevice,
  waitForUncovered,
} from '../helpers/app'
import { launchAppAgain, readAppConfig, userDataPath } from '../helpers/driver'
import { isWindowVisible, waitForPage, waitForTray, waitForVisible } from '../helpers/resident'

/** How long a restored session gets to reconnect and bring the dialog up. */
const RESTORE_TIMEOUT_MS = 30_000
const UNLOCK_TIMEOUT_MS = 15_000
/** How long, and how often, the plain-editor launch is watched for a
 *  window or a dialog that must not come up: as long as the other launches
 *  get to bring the dialog up. */
const NO_REVEAL_SAMPLES = 25
const NO_REVEAL_INTERVAL_MS = 1_000
const SECOND_LAUNCH_TIMEOUT_MS = 30_000

type Settings = Record<string, unknown>

let uid = ''

function settingsPath(): string {
  return userDataPath('sync', 'keyboards', uid, 'pipette_settings.json')
}

/** The virtual keyboard's pipette_settings.json; empty before the app
 *  first writes it. */
function readSettings(): Settings {
  const path = settingsPath()
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Settings) : {}
}

/** Quits the app, applies `edit` to the keyboard's settings while no app
 *  runs, and launches the app again. */
async function relaunch(edit: (settings: Settings) => void): Promise<void> {
  await restartApp(() => {
    const settings = readSettings()
    edit(settings)
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  })
  await waitForPage()
}

const dialogUp = (): Promise<boolean> => $(UNLOCK_DIALOG_HEADING).isExisting()

/** Unlocks the keyboard through the Unlock dialog that is up, with a short
 *  countdown (it also shortens one already running). */
async function unlockShownDialog(): Promise<void> {
  await virtualDevice.setUnlockCounterMax(3)
  await virtualDevice.holdKeys(UNLOCK_KEYS)
  try {
    await browser.waitUntil(async () => !(await dialogUp()), {
      timeout: UNLOCK_TIMEOUT_MS,
      timeoutMsg: 'the Unlock dialog stayed after the combo was held',
    })
  } finally {
    await virtualDevice.releaseAll()
  }
}

/** The relaunched app shows its hidden window with the Unlock dialog, and
 *  hides it back into the tray once the keyboard is unlocked. */
async function expectRevealThenHide(): Promise<void> {
  await browser.waitUntil(async () => (await dialogUp()) && (await isWindowVisible()), {
    timeout: RESTORE_TIMEOUT_MS,
    timeoutMsg: 'the Unlock dialog did not come up in a visible window',
  })
  await unlockShownDialog()
  // The hook hides only a window it showed itself: a window already
  // visible when the app learnt it started hidden is left shown.
  await waitForVisible(false, 'the window did not hide back into the tray after the unlock')
  expect(await dialogUp()).toBe(false)
}

describe('Tauri build start in the tray with a locked keyboard', function () {
  this.timeout(180_000)

  /** The first failed test: every later test builds on the state the
   *  earlier ones left, so they are not run after it. */
  let firstFailure: string | null = null

  before(function () {
    // The restart finds the app's process through /proc.
    if (process.platform !== 'linux') this.skip()
  })

  beforeEach(function () {
    if (firstFailure !== null) {
      throw new Error(`not run: "${firstFailure}" failed, and the later tests depend on it`)
    }
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') firstFailure = this.currentTest.title
  })

  it('enters the Typing View, turns the tray and startInTray on, and quits in the Typing View', async () => {
    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
    // Connecting names the keyboard and creates its directory.
    await browser.waitUntil(
      async () => {
        const stored = await vialApi<{ uid: string; name: string }[]>('listStoredKeyboards')
        uid = stored.find((kb) => kb.name === VIRTUAL_DEVICE_NAME)?.uid ?? ''
        return uid !== ''
      },
      { timeoutMsg: 'the connected keyboard was not stored under its name' },
    )

    // The Typing View asks to unlock the keyboard, locked at launch.
    await virtualDevice.setUnlockCounterMax(3)
    await waitForUncovered(tid('view-only-button'))
    await clickInPage(tid('view-only-button'))
    await unlockIfAsked()
    await browser.waitUntil(() => readSettings().viewMode === 'typingView', {
      timeoutMsg: 'the Typing View was not saved as the view mode',
    })

    await invokeCommand('app_config_set', { key: 'trayResident', value: 'true' })
    await invokeCommand('app_config_set', { key: 'startInTray', value: 'true' })
    // Starting hidden needs the tray icon to show the window again.
    await waitForTray((state) => state.active, 'the tray icon did not come up')

    await restartApp(() => {
      const config = readAppConfig()
      expect(config.trayResident).toBe(true)
      expect(config.startInTray).toBe(true)
      expect(readSettings().viewMode).toBe('typingView')
    })
    await waitForPage()
  })

  it('restoring the Typing View shows the Unlock dialog, then hides back into the tray', async () => {
    await expectRevealThenHide()
  })

  it('restoring the Typing Test shows the Unlock dialog, then hides back into the tray', async () => {
    await relaunch((settings) => {
      settings.viewMode = 'typingTest'
    })
    await expectRevealThenHide()
  })

  it('restoring the plain editor stays in the tray with no Unlock dialog', async () => {
    await relaunch((settings) => {
      settings.viewMode = 'editor'
    })
    // The editor is there once the reconnect has loaded the keyboard, which
    // is when the other restores bring the dialog up.
    await $(EDITOR_SELECTOR).waitForExist({ timeout: RESTORE_TIMEOUT_MS })
    for (let sample = 0; sample < NO_REVEAL_SAMPLES; sample++) {
      expect({ sample, visible: await isWindowVisible() }).toEqual({ sample, visible: false })
      expect({ sample, dialog: await dialogUp() }).toEqual({ sample, dialog: false })
      await browser.pause(NO_REVEAL_INTERVAL_MS)
    }
  })

  it('REC on in the plain editor shows the Unlock dialog, hides back into the tray, and keeps recording on', async () => {
    await relaunch((settings) => {
      settings.viewMode = 'editor'
      settings.typingRecordEnabled = true
    })
    await expectRevealThenHide()
    // The status bar's Recording indicator follows the saved REC setting
    // only; the page keeps running while the window is hidden.
    await $(tid('recording-status')).waitForExist()
  })

  it('a second launch shows the window of the app started hidden', async () => {
    await relaunch((settings) => {
      settings.viewMode = 'editor'
      settings.typingRecordEnabled = false
    })
    await $(EDITOR_SELECTOR).waitForExist({ timeout: RESTORE_TIMEOUT_MS })
    expect(await isWindowVisible()).toBe(false)

    const second = await launchAppAgain(SECOND_LAUNCH_TIMEOUT_MS)
    if (second.code !== 0) {
      throw new Error(`the second launch ended with code ${second.code} (signal ${second.signal}):\n${second.output}`)
    }
    await waitForVisible(true, 'the second launch did not show the window')
  })
})
