// SPDX-License-Identifier: GPL-2.0-or-later
//
// The in-app update of the Tauri build against the fake update server of
// scripts/fake-update (helpers/updater-harness.ts): the startup notice
// first and the update modal only after it is closed, the modal's release
// page link and its three buttons, a skipped version not offered again
// after a restart while a newer one is, a tampered signature shown as an
// error, and Update recording the fake install and quitting through the
// quit sequence. The tests share one session and run in order; each
// restart quits the app and starts it again on the same userData
// directory.

import { existsSync, readFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { clickInPage, countIn, readAppLog, restartApp, tid, waitForGone } from '../helpers/app'
import { readAppConfig, sessionAppPid, userDataPath, waitForAppExit } from '../helpers/driver'
import {
  FAKE_INSTALL_FILE,
  STARTUP_NOTICE_TITLE,
  fakeUpdateNotices,
  fakeUpdates,
  releasesAboveApp,
} from '../helpers/updater-harness'

const NOTICE_MODAL = tid('notification-modal-backdrop')
const UPDATE_MODAL = tid('update-modal')
/** The app waits 3 s after the notices before it checks; with the startup
 *  of a 2-core runner on top. */
const MODAL_TIMEOUT_MS = 30_000
/** How long a launch is watched for an update modal that must not come up,
 *  after the app has fetched the manifest. */
const NO_MODAL_WAIT_MS = 2_000
// Longer than the deadline of the app's own quit sequence (30 s).
const QUIT_TIMEOUT_MS = 40_000
const { next, newer } = releasesAboveApp()

function manifestRequests(): number {
  return fakeUpdates().requests.filter((request) => request.path === '/manifest.json').length
}

async function waitForUpdateModal(): Promise<void> {
  await $(UPDATE_MODAL).waitForDisplayed({ timeout: MODAL_TIMEOUT_MS, timeoutMsg: 'the update modal did not come up' })
}

async function modalMessage(): Promise<string> {
  return browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', tid('update-modal-message'))
}

/** Restarts the app and waits until it has asked for the manifest. */
async function restartAndWaitForCheck(): Promise<void> {
  const before = manifestRequests()
  await restartApp()
  await browser.waitUntil(() => manifestRequests() > before, {
    timeout: MODAL_TIMEOUT_MS,
    timeoutMsg: 'the restarted app did not check for an update',
  })
}

describe('in-app update', () => {
  it('shows the startup notice first and the update only after it is closed', async () => {
    await $(NOTICE_MODAL).waitForDisplayed({ timeout: MODAL_TIMEOUT_MS })
    expect(await $(NOTICE_MODAL).getText()).toContain(STARTUP_NOTICE_TITLE)
    // Well past the check's delay: nothing is checked while the notice is up.
    await browser.pause(5_000)
    expect(manifestRequests()).toBe(0)
    expect(await $(UPDATE_MODAL).isExisting()).toBe(false)
    expect(fakeUpdateNotices().requests.length).toBeGreaterThan(0)

    await clickInPage(tid('notification-modal-close'))
    await waitForGone(NOTICE_MODAL, 'the notice modal did not close')
    await waitForUpdateModal()
    expect(manifestRequests()).toBe(1)
    expect(await modalMessage()).toContain(next)
  })

  it('opens the release page of the version through openExternal', async () => {
    // The shim's member is replaced by a recorder, so no browser starts.
    await browser.execute(() => {
      const page = window as unknown as { vialAPI: Record<string, unknown>; __e2eOpened: string[] }
      page.__e2eOpened = []
      page.vialAPI.openExternal = (url: string) => {
        page.__e2eOpened.push(url)
        return Promise.resolve()
      }
    })
    await clickInPage(tid('update-modal-release-link'))
    const opened = await browser.execute(() => (window as unknown as { __e2eOpened: string[] }).__e2eOpened)
    expect(opened).toEqual([`https://github.com/darakuneko/pipette-desktop/releases/tag/v${next}`])
  })

  it('closes on Not now without skipping', async () => {
    expect(await $(tid('update-modal-install')).isDisplayed()).toBe(true)
    await clickInPage(tid('update-modal-later'))
    await waitForGone(UPDATE_MODAL, 'Not now did not close the update modal')
    expect(readAppConfig().updateSkippedVersion).toBeUndefined()
  })

  it('offers the update again at the next launch, and skips it for good', async () => {
    await restartAndWaitForCheck()
    // The notice was marked seen when it was closed.
    await waitForUpdateModal()
    expect(await $(NOTICE_MODAL).isExisting()).toBe(false)
    await clickInPage(tid('update-modal-skip'))
    await waitForGone(UPDATE_MODAL, 'Skip did not close the update modal')
    await browser.waitUntil(() => readAppConfig().updateSkippedVersion === next, {
      timeoutMsg: 'the skipped version was not saved',
    })

    await restartAndWaitForCheck()
    await browser.pause(5_000 + NO_MODAL_WAIT_MS)
    expect(await $(UPDATE_MODAL).isExisting()).toBe(false)
  })

  it('offers a version newer than the skipped one', async () => {
    fakeUpdates().setRelease({ version: newer, tamper: 'signature' })
    await restartAndWaitForCheck()
    await waitForUpdateModal()
    expect(await modalMessage()).toContain(newer)
  })

  it('shows a tampered signature as an error and installs nothing', async () => {
    await clickInPage(tid('update-modal-install'))
    await $(tid('update-modal-error')).waitForDisplayed({ timeout: MODAL_TIMEOUT_MS })
    expect(await browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', tid('update-modal-error')))
      .toContain('could not be verified')
    expect(existsSync(userDataPath(FAKE_INSTALL_FILE))).toBe(false)
    expect(countIn(readAppLog(), '[update] download or verification failed')).toBe(1)
  })

  it('refuses a signature bound to another version than the manifest announces', async () => {
    fakeUpdates().setRelease({ version: newer, tamper: 'version' })
    await restartAndWaitForCheck()
    await waitForUpdateModal()
    await clickInPage(tid('update-modal-install'))
    await $(tid('update-modal-error')).waitForDisplayed({ timeout: MODAL_TIMEOUT_MS })
    expect(existsSync(userDataPath(FAKE_INSTALL_FILE))).toBe(false)
    expect(readAppLog()).toContain('signed for version 0.0.1')
  })

  it('records the update and quits through the quit sequence on Update', async () => {
    fakeUpdates().setRelease({ version: newer })
    await restartAndWaitForCheck()
    await waitForUpdateModal()
    const pid = sessionAppPid()
    await clickInPage(tid('update-modal-install'))
    await waitForAppExit(pid, QUIT_TIMEOUT_MS, 'of the update')
    const installed = JSON.parse(readFileSync(userDataPath(FAKE_INSTALL_FILE), 'utf8')) as { version: string; size: number }
    expect(installed.version).toBe(newer)
    expect(installed.size).toBeGreaterThan(0)
    const log = readAppLog()
    expect(countIn(log, '[quit] an update requested the quit; starting the quit sequence')).toBe(1)
    expect(log.indexOf('[update] recorded the fake install')).toBeLessThan(log.lastIndexOf('[quit] sequence ended'))
    expect(fakeUpdates().requests.some((request) => request.path.startsWith('/download/'))).toBe(true)
  })
})
