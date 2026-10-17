// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pipette Hub in the Tauri build, against the Node fake Hub of
// scripts/fake-hub (helpers/hub-harness.ts starts it and refuses to launch
// an app that is not pointed at it).

import { $, browser, expect } from '@wdio/globals'
import { clickInPage, recordPageErrors, recordedPageErrors, tid, waitForGone } from '../helpers/app'
import { readAppConfig } from '../helpers/driver'
import { HUB_TEST_ACCOUNT } from '../helpers/hub-env'
import { assertHubSession, fakeHub, hubControl, hubRequestsSince, hubState } from '../helpers/hub-harness'

const DISPLAY_NAME = 'E2E Hub'
/** The display name the fake Hub gives the test account when it creates
 *  it: the local part of its email. */
const TEST_ACCOUNT_LOCAL_PART = HUB_TEST_ACCOUNT.split('@')[0]
const TAKEN_NAME = 'Taken Name'

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

/** The fake Hub's account with `email`. */
function hubUser(email: string): { display_name: string | null } | undefined {
  return fakeHub().state.users.find((user) => user.email === email)
}

async function openHubSettings(): Promise<void> {
  await clickInPage(tid('settings-button'))
  await $(tid('settings-modal')).waitForDisplayed()
  await clickInPage(tid('settings-tab-data'))
  await $(tid('pipette-hub-title')).waitForDisplayed()
}

async function closeSettings(): Promise<void> {
  await clickInPage(tid('settings-close'))
  await waitForGone(tid('settings-modal'), 'the Settings modal did not close')
}

/** Types `name` into the display name field and saves it. */
async function saveDisplayName(name: string): Promise<void> {
  await fillInput(tid('hub-display-name-input'), name)
  const save = $(tid('hub-display-name-save'))
  await browser.waitUntil(() => save.isEnabled(), { timeoutMsg: `the display name ${name} cannot be saved` })
  await save.click()
}

describe('Tauri build Pipette Hub', function () {
  this.timeout(180_000)

  /** The first failed test: every later test builds on the state the
   *  earlier ones left, so they are not run after it. */
  let firstFailure: string | null = null
  /** Page errors of the page loads before the current one. */
  const earlierErrors: string[] = []

  beforeEach(function () {
    if (firstFailure !== null) {
      throw new Error(`not run: "${firstFailure}" failed, and the later tests depend on it`)
    }
  })

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return
    firstFailure = this.currentTest.title
    const page = await browser
      .execute(() => {
        const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
        return `topmost at the centre: ${top?.outerHTML.slice(0, 400) ?? 'none'}\n${document.body.innerText.slice(0, 1500)}`
      })
      .catch((err: unknown) => String(err))
    console.error(`page at the failure:\n${page}`)
    console.error(`fake Hub requests: ${fakeHub().requests.map((r) => `${r.method} ${r.path}`).join(', ')}`)
  })

  before(async () => {
    await assertHubSession()
    await recordPageErrors()
    await $(tid('settings-button')).waitForDisplayed({ timeout: 20_000 })
  })

  describe('the test account', () => {
    it('resolves a display name conflict with the first token, then sets the display name', async () => {
      // Another account has the name the Hub would give the test account,
      // so the first token request is refused until a name is chosen.
      await hubControl('users', { email: 'other@example.com', displayName: TEST_ACCOUNT_LOCAL_PART })
      const from = fakeHub().requests.length
      expect((await hubState()).tokenCached).toBe(false)

      await openHubSettings()
      await clickInPage(tid('hub-enable-toggle'))
      await browser.waitUntil(() => readAppConfig().hubEnabled === true, { timeoutMsg: 'the Hub was not enabled' })
      await $(tid('hub-auth-conflict-warning')).waitForDisplayed({ timeout: 30_000 })
      expect((await hubState()).tokenCached).toBe(false)

      await saveDisplayName(DISPLAY_NAME)
      await waitForGone(tid('hub-auth-conflict-warning'), 'the display name conflict stayed')
      // The account keeps no display name: the Hub applies the token's
      // name only to an account it creates.
      await $(tid('hub-display-name-required')).waitForDisplayed({ timeout: 30_000 })
      const tokens = hubRequestsSince(from).filter((r) => r.op === 'auth.token')
      expect(tokens.length).toBeGreaterThanOrEqual(2)
      expect(tokens[0].body).toEqual({ json: { id_token: '[redacted]' } })
      expect(tokens.at(-1)?.body).toEqual({ json: { id_token: '[redacted]', display_name: DISPLAY_NAME } })
      // Clearing the chosen name afterwards drops the JWT it got, as in
      // Electron; the next request takes a token again.
      const state = await hubState()
      expect([state.tokenCached, state.displayNamePending]).toEqual([false, false])

      // The other account takes another name, so the test account's own
      // token requests go through again; a name another account has is
      // refused and shown.
      await hubControl('users', { email: 'other@example.com', displayName: TAKEN_NAME })
      await saveDisplayName(TAKEN_NAME)
      await $(tid('hub-display-name-error')).waitForDisplayed({ timeout: 30_000 })
      expect(hubUser(HUB_TEST_ACCOUNT)?.display_name).toBeNull()

      await saveDisplayName(DISPLAY_NAME)
      await browser.waitUntil(() => hubUser(HUB_TEST_ACCOUNT)?.display_name === DISPLAY_NAME, {
        timeoutMsg: 'the display name did not reach the Hub',
      })
      await waitForGone(tid('hub-display-name-required'), 'the display name is still asked for')
      const patches = hubRequestsSince(from).filter((r) => r.op === 'auth.patchMe')
      expect(patches.map((r) => [r.account, r.body])).toEqual([
        [HUB_TEST_ACCOUNT, { json: { display_name: TAKEN_NAME } }],
        [HUB_TEST_ACCOUNT, { json: { display_name: DISPLAY_NAME } }],
      ])
      await closeSettings()
    })
  })

  describe('the page', () => {
    it('logged no page errors', async () => {
      expect([...earlierErrors, ...(await recordedPageErrors())]).toEqual([])
    })
  })
})
