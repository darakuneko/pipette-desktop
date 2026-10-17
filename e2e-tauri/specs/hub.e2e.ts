// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pipette Hub in the Tauri build, against the Node fake Hub of
// scripts/fake-hub (helpers/hub-harness.ts starts it and refuses to launch
// an app that is not pointed at it).

import { readFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import type { HubPrivateLink } from '../../src/shared/types/hub-private'
import {
  clickInPage,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  openOverlayTab,
  recordPageErrors,
  recordedPageErrors,
  tid,
  vialApi,
  VIRTUAL_DEVICE_NAME,
  waitForGone,
  waitForUncovered,
} from '../helpers/app'
import { readAppConfig, userDataPath } from '../helpers/driver'
import { HUB_TEST_ACCOUNT } from '../helpers/hub-env'
import { assertHubSession, fakeHub, hubControl, hubRequestsSince, hubState } from '../helpers/hub-harness'

const DISPLAY_NAME = 'E2E Hub'
/** The display name the fake Hub gives the test account when it creates
 *  it: the local part of its email. */
const TEST_ACCOUNT_LOCAL_PART = HUB_TEST_ACCOUNT.split('@')[0]
const TAKEN_NAME = 'Taken Name'
const POST_LABEL = 'E2E keymap post'
const POST_RENAMED = 'E2E other post renamed'
const OTHER_KEYBOARD = 'E2E other keyboard'
/** The Hub's files of a keymap post, sorted. */
const KEYMAP_FILE_TYPES = ['c', 'pdf', 'pipette', 'vil']

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

interface SnapshotEntry {
  id: string
  label: string
  hubPostId?: string
  hubPrivate?: HubPrivateLink
  deletedAt?: string
}

/** The live snapshot of keyboard `uid` labelled `label`, as on disk. */
function snapshotEntry(uid: string, label: string): SnapshotEntry | undefined {
  const index = JSON.parse(readFileSync(userDataPath('sync', 'keyboards', uid, 'snapshots', 'index.json'), 'utf8')) as {
    entries: SnapshotEntry[]
  }
  return index.entries.find((entry) => entry.label === label && !entry.deletedAt)
}

/** The fake Hub's public posts and private posts titled `title`. */
const hubPosts = (title: string) => fakeHub().state.posts.filter((post) => post.title === title)
const hubPrivatePosts = (title: string) => fakeHub().state.privatePosts.filter((post) => post.title === title)

/** Connects the virtual keyboard, waits until nothing covers the editor,
 *  and answers the keyboard's uid. */
async function connectAndFindUid(): Promise<string> {
  await connectVirtualKeyboard()
  await waitForUncovered(EDITOR_SELECTOR)
  let uid = ''
  await browser.waitUntil(
    async () => {
      const stored = await vialApi<{ uid: string; name: string }[]>('listStoredKeyboards')
      uid = stored.find((kb) => kb.name === VIRTUAL_DEVICE_NAME)?.uid ?? ''
      return uid !== ''
    },
    { timeoutMsg: 'the connected keyboard was not stored under its name' },
  )
  return uid
}

async function disconnect(): Promise<void> {
  await clickInPage(tid('disconnect-button'))
  await $(tid('settings-button')).waitForDisplayed()
}

/** Clicks `button` of the snapshot row in the Import / Save tab, picks
 *  `visibility` in the upload dialog it opens, and confirms it. */
async function uploadWithVisibility(button: string, visibility: 'public' | 'private'): Promise<void> {
  await openOverlayTab('data')
  await waitForUncovered(tid(button))
  await clickInPage(tid(button))
  await $(tid('upload-confirm-submit')).waitForDisplayed()
  await clickInPage(`${tid(`upload-confirm-visibility-${visibility}`)} input`)
  await clickInPage(tid('upload-confirm-submit'))
  await waitForGone(tid('upload-confirm-backdrop'), 'the upload dialog did not close')
}

/** Waits for `done`, polling every half second, for at most a minute: an
 *  upload builds the keymap's PDF and thumbnail first. */
async function waitForHub(done: () => boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => done(), { timeout: 60_000, interval: 500, timeoutMsg })
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
    let uid = ''

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

    it('uploads a keymap post, lists the posts page by page, updates it, renames and deletes posts', async () => {
      uid = await connectAndFindUid()
      await openOverlayTab('data')
      await $(tid('layout-store-save-input')).setValue(POST_LABEL)
      await $(tid('layout-store-save-submit')).click()
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL) !== undefined, { timeoutMsg: 'the snapshot was not saved' })

      await uploadWithVisibility('layout-store-upload-hub', 'public')
      await waitForHub(() => hubPosts(POST_LABEL).length === 1, 'the keymap post did not reach the Hub')
      const [post] = hubPosts(POST_LABEL)
      expect([post.keyboard_name, post.post_type]).toEqual([VIRTUAL_DEVICE_NAME, 'keyboard'])
      expect(post.files.map((file) => file.file_type).sort()).toEqual(KEYMAP_FILE_TYPES)
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL)?.hubPostId === post.id, {
        timeoutMsg: 'the snapshot was not linked to the post',
      })
      const upload = fakeHub().requests.find((r) => r.op === 'files.create')
      expect(upload?.account).toBe(HUB_TEST_ACCOUNT)
      expect(upload?.contentType).toBe('multipart/form-data')

      // My posts, a page at a time, and the posts of one keyboard. Fewer
      // than the Data modal's page, so it lists the uploaded post below.
      for (let i = 0; i < 6; i += 1) {
        await hubControl('posts', { owner: HUB_TEST_ACCOUNT, title: `E2E other post ${i}`, keyboardName: OTHER_KEYBOARD })
      }
      const page = await vialApi<{ success: boolean; posts: { id: string }[]; pagination: unknown }>('hubFetchMyPosts', {
        page: 2,
        per_page: 3,
      })
      expect(page.success).toBe(true)
      expect(page.posts).toHaveLength(3)
      expect(page.pagination).toEqual({ total: 7, page: 2, per_page: 3, total_pages: 3 })
      const mine = await vialApi<{ success: boolean; posts: { id: string }[] }>('hubFetchMyKeyboardPosts', VIRTUAL_DEVICE_NAME)
      expect(mine.posts.map((p) => p.id)).toEqual([post.id])

      const updatedAt = post.updated_at
      await uploadWithVisibility('layout-store-update-hub', 'public')
      await waitForHub(() => hubPosts(POST_LABEL)[0]?.updated_at !== updatedAt, 'the keymap post was not updated')
      expect(hubPosts(POST_LABEL).map((p) => p.id)).toEqual([post.id])

      // The Data modal lists the posts no local entry is linked to (the
      // other keyboard's), and renames and deletes them.
      const [renamed, deleted] = hubPosts('E2E other post 0').concat(hubPosts('E2E other post 1'))
      await disconnect()
      await clickInPage(tid('data-button'))
      await $(tid('data-modal')).waitForDisplayed()
      await clickInPage(tid('nav-cloud-hub'))
      await $(tid('nav-hub-keyboards')).waitForDisplayed({ timeout: 30_000 })
      if (!(await $(tid(`nav-hub-kb-${OTHER_KEYBOARD}`)).isDisplayed())) await clickInPage(tid('nav-hub-keyboards'))
      expect(await $(tid(`nav-hub-kb-${VIRTUAL_DEVICE_NAME}`)).isExisting()).toBe(false)
      await clickInPage(tid(`nav-hub-kb-${OTHER_KEYBOARD}`))
      await clickInPage(tid(`hub-title-${renamed.id}`))
      await fillInput(tid(`hub-rename-input-${renamed.id}`), POST_RENAMED)
      await browser.execute((sel: string) => (document.querySelector(sel) as HTMLInputElement).blur(), tid(`hub-rename-input-${renamed.id}`))
      await waitForHub(() => hubPosts(POST_RENAMED).map((p) => p.id).join() === renamed.id, 'the post was not renamed')
      await $(tid(`hub-title-${renamed.id}`)).waitForDisplayed()
      await clickInPage(tid(`hub-delete-${deleted.id}`))
      await clickInPage(tid(`hub-confirm-delete-${deleted.id}`))
      await waitForHub(() => !fakeHub().state.posts.some((p) => p.id === deleted.id), 'the post was not deleted')
      await waitForGone(tid(`hub-post-${deleted.id}`), 'the deleted post is still listed')
      await clickInPage(tid('data-modal-close'))
      await waitForGone(tid('data-modal'), 'the Data modal did not close')

      // Deleted from the snapshot it was uploaded from.
      await connectAndFindUid()
      await openOverlayTab('data')
      await clickInPage(tid('layout-store-remove-hub'))
      await clickInPage(tid('layout-store-hub-remove-confirm'))
      await waitForHub(() => !fakeHub().state.posts.some((p) => p.id === post.id), 'the post was not deleted')
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL)?.hubPostId === undefined, {
        timeoutMsg: 'the snapshot is still linked to the deleted post',
      })
    })

    it('uploads a private post, switches it to public and back, and deletes it', async () => {
      await uploadWithVisibility('layout-store-upload-hub', 'private')
      await waitForHub(() => hubPrivatePosts(POST_LABEL).length === 1, 'the private post did not reach the Hub')
      const [first] = hubPrivatePosts(POST_LABEL)
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL)?.hubPrivate?.id === first.id, {
        timeoutMsg: 'the snapshot was not linked to the private post',
      })
      const link = snapshotEntry(uid, POST_LABEL)?.hubPrivate
      expect(link?.url).toContain(first.token)
      expect(link?.expiresAt).toBe(first.expires_at)
      expect(hubPosts(POST_LABEL)).toEqual([])

      // To public: the private post goes and a public one comes.
      await uploadWithVisibility('layout-store-update-hub', 'public')
      await waitForHub(
        () => hubPrivatePosts(POST_LABEL).length === 0 && hubPosts(POST_LABEL).length === 1,
        'the private post was not switched to public',
      )
      const [publicPost] = hubPosts(POST_LABEL)
      await browser.waitUntil(() => {
        const entry = snapshotEntry(uid, POST_LABEL)
        return entry?.hubPostId === publicPost.id && entry.hubPrivate === undefined
      }, { timeoutMsg: 'the snapshot was not linked to the public post' })

      // And back to private.
      await uploadWithVisibility('layout-store-update-hub', 'private')
      await waitForHub(
        () => hubPosts(POST_LABEL).length === 0 && hubPrivatePosts(POST_LABEL).length === 1,
        'the public post was not switched to private',
      )
      const [second] = hubPrivatePosts(POST_LABEL)
      expect(second.id).not.toBe(first.id)
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL)?.hubPrivate?.id === second.id, {
        timeoutMsg: 'the snapshot was not linked to the new private post',
      })

      await clickInPage(tid('layout-store-remove-hub'))
      await clickInPage(tid('layout-store-hub-remove-confirm'))
      await waitForHub(() => hubPrivatePosts(POST_LABEL).length === 0, 'the private post was not deleted')
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL)?.hubPrivate === undefined, {
        timeoutMsg: 'the snapshot is still linked to the deleted private post',
      })
      // A private post the Hub no longer has counts as deleted.
      expect(await vialApi('hubDeletePrivatePost', 'files', second.id)).toEqual({ success: true })
      await disconnect()
    })
  })

  describe('the page', () => {
    it('logged no page errors', async () => {
      expect([...earlierErrors, ...(await recordedPageErrors())]).toEqual([])
    })
  })
})
