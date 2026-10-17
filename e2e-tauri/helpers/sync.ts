// SPDX-License-Identifier: GPL-2.0-or-later
//
// The UI steps and the fake Drive's state the sync spec shares: the sign-in
// played against the loopback redirect, the Settings modal's Connect tab,
// the Data modal's tree, and the files on the fake Drive.

import { $, browser } from '@wdio/globals'
import type { StoredFile } from '../../scripts/fake-drive/drive-state'
import { clickInPage, invokeCommand, tid, waitForGone } from './app'
import { fakeDrive } from './sync-harness'

/** Puts `value` into the input `selector` as React reads an edit: typed
 *  keys reach WebKitGTK's fields unreliably. */
async function fillInput(selector: string, value: string): Promise<void> {
  await $(selector).waitForDisplayed()
  await browser.execute(
    (sel: string, text: string) => {
      const input = document.querySelector(sel) as HTMLInputElement
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value,
  )
}

// ---- The fake Drive ----

/** The files on the fake Drive named `name`, oldest first. */
export function driveFilesNamed(name: string): StoredFile[] {
  return fakeDrive().state.files.filter((file) => file.name === name)
}

/** The names of the files on the fake Drive. */
export function driveFileNames(): string[] {
  return fakeDrive().state.files.map((file) => file.name)
}

function newestModifiedTime(files: StoredFile[]): string {
  return files.reduce((newest, file) => (file.modifiedTime > newest ? file.modifiedTime : newest), '')
}

/** The newest `modifiedTime` of the files named `name`; '' when none. */
export function driveModifiedTime(name: string): string {
  return newestModifiedTime(driveFilesNamed(name))
}

/** The newest `modifiedTime` on the fake Drive (its clock moves one second
 *  per write). */
export function driveClock(): string {
  return newestModifiedTime(fakeDrive().state.files)
}

export const settingsFileName = (uid: string): string => `keyboards_${uid}_settings.enc`

/** Runs a poll pass (trigger B) until `done` holds: a pass started while
 *  another sync holds the lock does nothing. */
export async function pollUntil(done: () => boolean | Promise<boolean>, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      await invokeCommand('dev_sync_run_poll_now')
      return done()
    },
    { timeout: 60_000, interval: 1000, timeoutMsg },
  )
}

// ---- The Settings modal's Connect tab ----

export async function openSyncSettings(): Promise<void> {
  await clickInPage(tid('settings-button'))
  await $(tid('settings-modal')).waitForDisplayed()
  await clickInPage(tid('settings-tab-data'))
  await $(tid('data-sync-title')).waitForDisplayed()
}

export async function closeSettings(): Promise<void> {
  await clickInPage(tid('settings-close'))
  await waitForGone(tid('settings-modal'), 'the Settings modal did not close')
}

/** Signs in from the Connect tab as a browser would: the app records the
 *  authorization URL instead of opening a browser
 *  (PIPETTE_DEV_SUPPRESS_BROWSER=1); the fake Drive's authorization
 *  endpoint answers it with the redirect to the app's loopback listener,
 *  carrying a code and the URL's state, which is then requested. */
export async function signIn(): Promise<void> {
  const before = await invokeCommand<string | null>('dev_sync_last_auth_url')
  await clickInPage(tid('sync-sign-in'))
  let authUrl = ''
  await browser.waitUntil(
    async () => {
      authUrl = (await invokeCommand<string | null>('dev_sync_last_auth_url')) ?? ''
      return authUrl !== '' && authUrl !== before
    },
    { timeoutMsg: 'the sign-in recorded no authorization URL' },
  )
  const params = new URL(authUrl).searchParams
  const state = params.get('state')
  const redirect = params.get('redirect_uri') ?? ''
  if (!state || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(redirect)) {
    throw new Error(`the authorization URL has no state or no loopback redirect: ${authUrl}`)
  }
  const consent = await fetch(authUrl, { redirect: 'manual' })
  const location = consent.headers.get('location') ?? ''
  if (consent.status !== 302 || !location.startsWith(redirect.replace(/\/$/, ''))) {
    throw new Error(`the fake Drive did not redirect to the loopback listener: ${consent.status} ${location}`)
  }
  if (new URL(location).searchParams.get('state') !== state) throw new Error('the redirect carries another state')
  const callback = await fetch(location)
  await callback.text()
  if (callback.status !== 200) throw new Error(`the loopback listener answered ${callback.status}`)
  await $(tid('sync-auth-status')).waitForDisplayed({ timeout: 30_000 })
}

/** Types `password` into the password field and saves it once its strength
 *  has been scored as strong enough: the save button is enabled already
 *  while the score is pending, but the save refuses an unscored password.
 *  The strength meter has five bars, all coloured at the top score. */
export async function submitPassword(password: string): Promise<void> {
  await fillInput(tid('sync-password-input'), password)
  await browser.waitUntil(
    () =>
      browser.execute((sel: string) => {
        const section = document.querySelector(sel)?.parentElement
        const bars = section ? [...section.querySelectorAll('div.flex-1.rounded')] : []
        return bars.length === 5 && bars.every((bar) => !bar.classList.contains('bg-surface-dim'))
      }, tid('sync-password-input')),
    { timeoutMsg: 'the password was not scored as strong enough' },
  )
  const save = $(tid('sync-password-save'))
  await browser.waitUntil(() => save.isEnabled(), { timeoutMsg: 'the password cannot be saved' })
  await save.click()
}

/** Sets the sync password on a machine that has none stored yet. */
export async function setPassword(password: string): Promise<void> {
  // The tab checks Drive for a password first.
  await $(tid('sync-password-input')).waitForDisplayed({ timeout: 30_000 })
  await submitPassword(password)
  await $(tid('sync-password-set')).waitForDisplayed({ timeout: 60_000 })
}

/** Turns Auto Sync on, which also runs a sync, and waits for its end. */
export async function enableAutoSync(): Promise<void> {
  await clickInPage(tid('sync-auto-on'))
  await $(tid('sync-auto-off')).waitForDisplayed()
  await waitForSyncIdle()
}

/** Waits until the sync the Connect tab runs has ended: its button is
 *  enabled again and no sync work runs. */
async function waitForSyncIdle(): Promise<void> {
  await waitForQuietSync(() => $(tid('sync-now')).isEnabled())
}

interface DevSyncState {
  workRunning: boolean
  flushDueInMs: number | null
}

/** How far off a scheduled flush may be for the sync to count as quiet. */
const QUIET_FLUSH_MARGIN_MS = 20_000

/** Waits until no sync work runs and no flush is due soon, on two checks
 *  in a row (a manual sync runs several passes, with the lock free in
 *  between), and `ready` holds. A step that a running pass would make skip,
 *  as a connect's download does, waits for it first. */
export async function waitForQuietSync(ready: () => Promise<boolean> = async () => true): Promise<void> {
  let quietChecks = 0
  await browser.waitUntil(
    async () => {
      const state = await invokeCommand<DevSyncState>('dev_sync_state')
      const quiet =
        !state.workRunning &&
        (state.flushDueInMs === null || state.flushDueInMs > QUIET_FLUSH_MARGIN_MS) &&
        (await ready())
      quietChecks = quiet ? quietChecks + 1 : 0
      return quietChecks >= 2
    },
    { timeout: 60_000, interval: 500, timeoutMsg: 'the sync did not settle' },
  )
}

// ---- The Data modal ----

/** Opens the Data modal and waits for the sync its opening runs with Auto
 *  Sync on: the trash and the resets refuse to act while a sync runs. */
export async function openDataModal(): Promise<void> {
  await clickInPage(tid('data-button'))
  await $(tid('data-modal')).waitForDisplayed()
  await waitForQuietSync()
}

export async function closeDataModal(): Promise<void> {
  await clickInPage(tid('data-modal-close'))
  await waitForGone(tid('data-modal'), 'the Data modal did not close')
}

/** Opens the tree branch `branch` unless `child` already shows. */
export async function expandBranch(branch: string, child: string, timeout = 15_000): Promise<void> {
  if (await $(tid(child)).isDisplayed()) return
  await clickInPage(tid(branch))
  await $(tid(child)).waitForDisplayed({ timeout })
}

/** Closes the Data and Settings modals a failed test left open and leaves
 *  the keymap editor, so the next test starts from the device list. */
export async function returnToDeviceList(): Promise<void> {
  for (const [shown, close] of [
    ['data-modal', 'data-modal-close'],
    ['settings-modal', 'settings-close'],
    ['disconnect-button', 'disconnect-button'],
  ]) {
    if (await $(tid(shown)).isDisplayed().catch(() => false)) {
      await clickInPage(tid(close)).catch(() => {})
    }
  }
}

// ---- Typing days ----

/** A day file of `hash`'s typing on keyboard `uid`: its scope and ten
 *  minutes from noon (UTC) of the UTC day `day`. */
export function deviceDayContent(uid: string, hash: string, scopeId: string, day: string): string {
  const noon = Date.parse(`${day}T12:00:00.000Z`)
  const row = (kind: string, id: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ id, kind, updated_at: noon, payload }) + '\n'
  let content = row('scope', `scope|${scopeId}`, {
    id: scopeId,
    machineHash: hash,
    osPlatform: 'linux',
    osRelease: '6.8.0-e2e',
    osArch: 'x64',
    keyboardUid: uid,
    keyboardVendorId: 0x4153,
    keyboardProductId: 0x4d47,
    keyboardProductName: 'E2E sync keyboard',
  })
  for (let minute = 0; minute < 10; minute += 1) {
    const minuteTs = noon + minute * 60_000
    content += row('minute-stats', `minute-stats|${scopeId}|${minuteTs}`, {
      scopeId,
      minuteTs,
      keystrokes: 120,
      activeMs: 40_000,
      intervalAvgMs: 180,
      intervalMinMs: 60,
      intervalP25Ms: 120,
      intervalP50Ms: 170,
      intervalP75Ms: 220,
      intervalMaxMs: 600,
    })
  }
  return content
}
