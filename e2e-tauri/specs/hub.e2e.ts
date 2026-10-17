// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pipette Hub in the Tauri build, against the Node fake Hub of
// scripts/fake-hub (helpers/hub-harness.ts starts it and refuses to launch
// an app that is not pointed at it). The first session is the Hub test
// account, whose account exists on the fake Hub without a display name: a
// display name conflict resolved with the first token, the display name
// set (a taken one refused); a keymap snapshot uploaded, updated and
// deleted from the Import / Save tab, the posts listed page by page and
// another keyboard's posts renamed and deleted from the Data modal; a
// private post uploaded, switched to public and back, and deleted; a
// favorite and an Analyze filter (of the seeded typing data) posted; key
// labels, a language pack (from the Hub tab) and a theme pack searched,
// downloaded, uploaded, updated, synced and deleted; the Hub-linked
// language pack updated at launch; a 401, a 429 and a 403 injected. The
// second session signs in with the fake Google of scripts/fake-drive, takes
// a Hub token with its id_token and forgets it on sign-out. The tests share
// the sessions and run in order.

import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { HUB_ERROR_NOT_AUTHENTICATED } from '../../src/shared/types/hub'
import {
  clickInPage,
  invokeCommand,
  openOverlayTab,
  recordPageErrors,
  recordedPageErrors,
  restartApp,
  tid,
  vialApi,
  VIRTUAL_DEVICE_NAME,
  waitForGone,
} from '../helpers/app'
import { readAppConfig, userDataPath } from '../helpers/driver'
import {
  changeHubLanguagePack,
  clickWhenEnabled,
  closeFromTools,
  closeSettings,
  connectAndFindUid,
  dataOf,
  disconnect,
  hubPosts,
  hubPrivatePosts,
  hubUser,
  openFromTools,
  openHubSettings,
  type PackMeta,
  readSample,
  SAMPLE_PACKS,
  saveDisplayName,
  snapshotEntry,
  uploadWithVisibility,
  waitForHub,
  waitForHubQuiet,
  waitForPack,
  withFilesDialog,
} from '../helpers/hub'
import { HUB_TEST_ACCOUNT } from '../helpers/hub-env'
import {
  assertHubSession,
  fakeHub,
  hubControl,
  hubRequestsSince,
  hubState,
  injectHubFault,
  switchToGoogleSession,
} from '../helpers/hub-harness'
import { fillInput, openSyncSettings, signIn } from '../helpers/sync'
import { DUMMY_TA_UID, seedDummyTypingAnalytics } from '../../e2e/helpers/analyze-seed'

const DISPLAY_NAME = 'E2E Hub'
/** The display name the fake Hub gives the test account when it creates
 *  it: the local part of its email. */
const TEST_ACCOUNT_LOCAL_PART = HUB_TEST_ACCOUNT.split('@')[0]
const TAKEN_NAME = 'Taken Name'
const POST_LABEL = 'E2E keymap post'
const POST_RENAMED = 'E2E other post renamed'
const OTHER_KEYBOARD = 'E2E other keyboard'
const OTHER_ACCOUNT = 'other@example.com'
const TAP_DANCE = { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
const FAVORITE_LABEL = 'E2E favorite'
const ANALYTICS_LABEL = 'E2E analytics'
const DAY_MS = 86_400_000
const HUB_LANGUAGE_PACK = 'E2E Hub Japanese'
const OWN_LANGUAGE_PACK = 'E2E Own Japanese'
const OWN_THEME_PACK = 'E2E Own Theme'
const LANGUAGE_PACK_EXPORTED_AT = '2026-01-01T00:00:00.000Z'
/** The account the fake Google signs in (scripts/fake-drive/server.ts). */
const GOOGLE_ACCOUNT = 'fake-user@example.invalid'
/** Not a picture: the Hub checks a thumbnail's name and size only. */
const THUMBNAIL_BASE64 = Buffer.from('e2e thumbnail').toString('base64')
/** The Hub's files of a keymap post, sorted. */
const KEYMAP_FILE_TYPES = ['c', 'pdf', 'pipette', 'vil']

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
      await hubControl('users', { email: OTHER_ACCOUNT, displayName: TEST_ACCOUNT_LOCAL_PART })
      const from = fakeHub().requests.length
      expect((await hubState()).tokenCached).toBe(false)

      await openHubSettings()
      await clickWhenEnabled(tid('hub-enable-toggle'))
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
      expect(tokens.map((r) => r.body)).toContainEqual({ json: { id_token: '[redacted]', display_name: DISPLAY_NAME } })
      // Clearing the chosen name afterwards drops the JWT it got, as in
      // Electron; the next request takes a token again.
      await browser.waitUntil(
        async () => {
          const state = await hubState()
          return !state.displayNamePending && !state.tokenCached
        },
        { timeoutMsg: 'the chosen display name or its JWT stayed' },
      )

      // The other account takes another name, so the test account's own
      // token requests go through again; a name another account has is
      // refused and shown.
      await hubControl('users', { email: OTHER_ACCOUNT, displayName: TAKEN_NAME })
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
      await clickWhenEnabled(tid(`hub-delete-${deleted.id}`))
      await clickWhenEnabled(tid(`hub-confirm-delete-${deleted.id}`))
      await waitForHub(() => !fakeHub().state.posts.some((p) => p.id === deleted.id), 'the post was not deleted')
      await waitForGone(tid(`hub-post-${deleted.id}`), 'the deleted post is still listed')
      await clickInPage(tid('data-modal-close'))
      await waitForGone(tid('data-modal'), 'the Data modal did not close')

      // Deleted from the snapshot it was uploaded from.
      await connectAndFindUid()
      await openOverlayTab('data')
      await clickWhenEnabled(tid('layout-store-remove-hub'))
      await clickWhenEnabled(tid('layout-store-hub-remove-confirm'))
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

      await clickWhenEnabled(tid('layout-store-remove-hub'))
      await clickWhenEnabled(tid('layout-store-hub-remove-confirm'))
      await waitForHub(() => hubPrivatePosts(POST_LABEL).length === 0, 'the private post was not deleted')
      await browser.waitUntil(() => snapshotEntry(uid, POST_LABEL)?.hubPrivate === undefined, {
        timeoutMsg: 'the snapshot is still linked to the deleted private post',
      })
      // A private post the Hub no longer has counts as deleted.
      expect(await vialApi('hubDeletePrivatePost', 'files', second.id)).toEqual({ success: true })
    })

    it('uploads a favorite as a public post, updates it and uploads it as a private post', async () => {
      const saved = await vialApi<{ success: boolean; entry: { id: string } }>(
        'favoriteStoreSave',
        'tapDance',
        JSON.stringify({ type: 'tapDance', data: TAP_DANCE }),
        FAVORITE_LABEL,
      )
      expect(saved.success).toBe(true)
      const params = { type: 'tapDance', entryId: saved.entry.id, title: FAVORITE_LABEL, vialProtocol: 6 }

      const uploaded = await vialApi<{ success: boolean; postId: string }>('hubUploadFavoritePost', params)
      expect(uploaded.success).toBe(true)
      const [post] = hubPosts(FAVORITE_LABEL)
      expect([post.id, post.post_type, post.keyboard_name]).toEqual([uploaded.postId, 'td', null])
      const sent = fakeHub().requests.filter((r) => r.op === 'files.create').at(-1)?.body as { parts: { name: string; value?: string }[] }
      expect(sent.parts.find((part) => part.name === 'post_type')?.value).toBe('td')

      const updated = await vialApi<{ success: boolean }>('hubUpdateFavoritePost', { ...params, postId: post.id, title: `${FAVORITE_LABEL} 2` })
      expect(updated.success).toBe(true)
      expect(fakeHub().state.posts.find((p) => p.id === post.id)?.title).toBe(`${FAVORITE_LABEL} 2`)

      const shared = await vialApi<{ success: boolean; id: string; url: string; expiresAt: string }>('hubUploadPrivateFavoritePost', {
        ...params,
        expiresInDays: 3,
      })
      expect(shared.success).toBe(true)
      const [privatePost] = hubPrivatePosts(FAVORITE_LABEL)
      expect([shared.id, shared.expiresAt]).toEqual([privatePost.id, privatePost.expires_at])
      expect(shared.url).toContain(privatePost.token)
      expect(privatePost.post_type).toBe('td')
      await disconnect()
    })

    it('previews, uploads and updates an Analyze post from the seeded typing data', async () => {
      earlierErrors.push(...(await recordedPageErrors()))
      await restartApp(async () => {
        await seedDummyTypingAnalytics(userDataPath(), Date.now())
      })
      await recordPageErrors()
      await $(tid('settings-button')).waitForDisplayed({ timeout: 20_000 })
      await browser.waitUntil(async () => (await vialApi<unknown[]>('typingAnalyticsListItemsLocal', DUMMY_TA_UID)).length > 0, {
        timeout: 30_000,
        timeoutMsg: 'the seeded days are not in the cache',
      })
      const keyboards = await vialApi<{ uid: string; productName: string; vendorId: number; productId: number }[]>(
        'typingAnalyticsListKeyboards',
      )
      const summary = keyboards.find((kb) => kb.uid === DUMMY_TA_UID)
      if (!summary) throw new Error('the seeded keyboard is not listed')
      const keyboard = { productName: summary.productName, vendorId: summary.vendorId, productId: summary.productId }
      const now = Date.now()
      const saveFilter = async (label: string, range: { fromMs: number; toMs: number }): Promise<string> => {
        const json = JSON.stringify({ version: 1, analysisTab: 'summary', range, filters: { deviceScopes: ['own'] } })
        const saved = await vialApi<{ success: boolean; entry: { id: string } }>('analyzeFilterStoreSave', DUMMY_TA_UID, json, label)
        expect(saved.success).toBe(true)
        return saved.entry.id
      }
      const week = await saveFilter(ANALYTICS_LABEL, { fromMs: now - 7 * DAY_MS, toMs: now })
      // An hour long before the seeded days: no keystrokes.
      const empty = await saveFilter('E2E empty', { fromMs: now - 200 * DAY_MS, toMs: now - 200 * DAY_MS + 3_600_000 })
      const base = { uid: DUMMY_TA_UID, keyboard, fingerOverrides: {}, layoutComparisonInputs: null }

      type Preview = { success: boolean; preview: { totalKeystrokes: number; estimatedBytes: number; validation: { ok: boolean } } }
      const tooFew = await vialApi<Preview>('hubPreviewAnalyticsPost', { ...base, entryId: empty })
      expect(tooFew.success).toBe(true)
      expect([tooFew.preview.totalKeystrokes, tooFew.preview.validation.ok]).toEqual([0, false])
      const preview = await vialApi<Preview>('hubPreviewAnalyticsPost', { ...base, entryId: week })
      expect(preview.preview.validation).toEqual({ ok: true })
      expect(preview.preview.totalKeystrokes).toBeGreaterThanOrEqual(100)

      const params = { ...base, entryId: week, title: ANALYTICS_LABEL, thumbnailBase64: THUMBNAIL_BASE64 }
      const uploaded = await vialApi<{ success: boolean; postId: string }>('hubUploadAnalyticsPost', params)
      expect(uploaded.success).toBe(true)
      const [post] = hubPosts(ANALYTICS_LABEL)
      expect([post.id, post.post_type, post.keyboard_uid, post.total_keystrokes]).toEqual([
        uploaded.postId,
        'analytics',
        DUMMY_TA_UID,
        preview.preview.totalKeystrokes,
      ])
      const linked = async (): Promise<string | undefined> =>
        (await vialApi<{ entries: { id: string; hubPostId?: string }[] }>('analyzeFilterStoreList', DUMMY_TA_UID)).entries.find(
          (entry) => entry.id === week,
        )?.hubPostId
      expect(await linked()).toBe(post.id)

      const updatedAt = post.updated_at
      const updated = await vialApi<{ success: boolean; postId: string }>('hubUpdateAnalyticsPost', {
        ...params,
        postId: post.id,
        title: `${ANALYTICS_LABEL} 2`,
      })
      expect(updated).toEqual({ success: true, postId: post.id })
      const after = fakeHub().state.posts.find((p) => p.id === post.id)
      expect([after?.title, after?.updated_at !== updatedAt]).toEqual([`${ANALYTICS_LABEL} 2`, true])
    })

    it('searches, downloads, uploads, updates, syncs and deletes key labels', async () => {
      const sample = readSample('key-labels/eucalyn.json') as { name: string; map: Record<string, string> }
      // Another account's label with the sample's name.
      const theirs = await hubControl<{ id: string; updated_at: string }>('key-labels', {
        owner: OTHER_ACCOUNT,
        name: sample.name,
        map: sample.map,
        keymapApplicable: true,
      })
      type Meta = { id: string; name: string; hubPostId?: string; uploaderName?: string; hubUpdatedAt?: string }
      const metas = (): Promise<Meta[]> => dataOf<Meta[]>('keyLabelStoreList')

      await withFilesDialog([join(SAMPLE_PACKS, 'key-labels/eucalyn.json')], 'keyLabelStoreImport')
      const local = (await metas()).find((meta) => meta.name === sample.name)
      if (!local) throw new Error('the sample key label was not imported')
      expect(await vialApi('keyLabelHubUpload', local.id)).toEqual({
        success: false,
        errorCode: 'DUPLICATE_NAME',
        error: 'KEY_LABEL_DUPLICATE',
      })

      await dataOf('keyLabelStoreRename', local.id, 'E2E Eucalyn')
      const uploaded = await dataOf<Meta>('keyLabelHubUpload', local.id)
      const mine = fakeHub().state.keyLabels.find((label) => label.name === 'E2E Eucalyn')
      expect([uploaded.hubPostId, uploaded.uploaderName, uploaded.hubUpdatedAt]).toEqual([mine?.id, DISPLAY_NAME, mine?.updated_at])
      const updated = await dataOf<Meta>('keyLabelHubUpdate', local.id)
      expect(updated.hubUpdatedAt).not.toBe(uploaded.hubUpdatedAt)

      const found = await dataOf<{ items: { id: string }[]; total: number }>('keyLabelHubList', { q: 'eucalyn' })
      expect(found.items.map((item) => item.id).sort()).toEqual([theirs.id, mine?.id].sort())
      expect((await dataOf<{ name: string }>('keyLabelHubDetail', theirs.id)).name).toBe(sample.name)
      const downloaded = await dataOf<Meta>('keyLabelHubDownload', theirs.id)
      expect([downloaded.id, downloaded.hubPostId, downloaded.uploaderName, downloaded.hubUpdatedAt]).toEqual([
        theirs.id,
        theirs.id,
        TAKEN_NAME,
        theirs.updated_at,
      ])

      // Their label changes on the Hub: the timestamps tell, and a sync
      // takes it.
      const touched = await hubControl<{ updated_at: string }>('touch', { kind: 'keyLabel', id: theirs.id })
      const stamps = await dataOf<{ items: { id: string; updated_at: string }[] }>('keyLabelHubTimestamps', [theirs.id, 'missing-id'])
      expect(stamps.items).toEqual([{ id: theirs.id, updated_at: touched.updated_at }])
      expect((await dataOf<Meta>('keyLabelHubSync', downloaded.id)).hubUpdatedAt).toBe(touched.updated_at)

      expect(await vialApi('keyLabelHubDelete', local.id)).toEqual({ success: true })
      expect(fakeHub().state.keyLabels.some((label) => label.id === mine?.id)).toBe(false)
      expect((await metas()).find((meta) => meta.id === local.id)?.hubPostId).toBeUndefined()
    })

    let hubLanguagePack = { id: '', localId: '' }

    it('downloads and applies a language pack from the Hub tab, syncs it, and uploads, updates and removes its own', async () => {
      const sample = readSample('i18n/i18n-packs-Japanese.json')
      const theirs = await hubControl<{ id: string; updated_at: string }>('i18n-packs', {
        owner: OTHER_ACCOUNT,
        export: { version: 1, kind: 'i18n', exportedAt: LANGUAGE_PACK_EXPORTED_AT, pack: { ...sample, name: HUB_LANGUAGE_PACK } },
      })
      const own = await dataOf<PackMeta>('i18nPackImportApply', { ...sample, name: OWN_LANGUAGE_PACK })

      await openFromTools('settings-language-packs-button', 'language-packs-modal')
      await clickInPage(tid('language-packs-tab-hub'))
      await fillInput(tid('language-packs-search-input'), 'E2E Hub')
      await clickWhenEnabled(tid('language-packs-search-button'))
      await $(tid(`language-packs-hub-row-${theirs.id}`)).waitForDisplayed({ timeout: 30_000 })
      await clickWhenEnabled(tid(`language-packs-hub-download-${theirs.id}`))
      const downloaded = await waitForPack('i18nPackList', (meta) => meta.hubPostId === theirs.id, 'the Hub pack was not downloaded')
      expect([downloaded.name, downloaded.uploaderName, downloaded.hubUpdatedAt]).toEqual([HUB_LANGUAGE_PACK, TAKEN_NAME, theirs.updated_at])
      hubLanguagePack = { id: theirs.id, localId: downloaded.id }

      await clickInPage(tid('language-packs-tab-installed'))
      await clickWhenEnabled(tid(`language-packs-select-${downloaded.id}`))
      await browser.waitUntil(() => readAppConfig().language === `pack:${downloaded.id}`, { timeoutMsg: 'the pack was not applied' })
      await clickWhenEnabled(tid('language-packs-select-builtin:en'))
      await browser.waitUntil(() => readAppConfig().language === 'builtin:en', { timeoutMsg: 'English was not applied again' })

      await clickWhenEnabled(tid(`language-packs-upload-${own.id}`))
      const uploaded = await waitForPack('i18nPackList', (meta) => meta.id === own.id && meta.hubPostId !== undefined, 'the own pack was not uploaded')
      const onHub = fakeHub().state.packs.i18n.find((pack) => pack.name === OWN_LANGUAGE_PACK)
      expect([uploaded.hubPostId, uploaded.uploaderName, uploaded.hubUpdatedAt]).toEqual([onHub?.id, DISPLAY_NAME, onHub?.updated_at])
      await clickWhenEnabled(tid(`language-packs-update-${own.id}`))
      await waitForPack('i18nPackList', (meta) => meta.id === own.id && meta.hubUpdatedAt !== uploaded.hubUpdatedAt, 'the own pack was not updated')
      await clickWhenEnabled(tid(`language-packs-remove-${own.id}`))
      await clickWhenEnabled(tid(`language-packs-confirm-remove-${own.id}`))
      await waitForPack('i18nPackList', (meta) => meta.id === own.id && meta.hubPostId === undefined, 'the own pack is still linked')
      expect(fakeHub().state.packs.i18n.some((pack) => pack.id === onHub?.id)).toBe(false)
      await closeFromTools('language-packs-modal-close', 'language-packs-modal')

      // The Hub's pack changes: opening the modal shows it, and Sync takes it.
      const touched = await changeHubLanguagePack(theirs.id, () => {})
      await openFromTools('settings-language-packs-button', 'language-packs-modal')
      await $(tid(`language-packs-update-available-${downloaded.id}`)).waitForDisplayed({ timeout: 30_000 })
      await clickWhenEnabled(tid(`language-packs-sync-${downloaded.id}`))
      await waitForPack('i18nPackList', (meta) => meta.id === downloaded.id && meta.hubUpdatedAt === touched, 'the pack was not synced')
      await waitForGone(tid(`language-packs-update-available-${downloaded.id}`), 'the pack still shows an update')
      await closeFromTools('language-packs-modal-close', 'language-packs-modal')
    })

    it('uploads, lists, updates, downloads and deletes a theme pack', async () => {
      const own = await dataOf<PackMeta>('themePackImportApply', { ...readSample('themes/catppuccin-mocha.json'), name: OWN_THEME_PACK })
      const { pack } = await dataOf<{ pack: Record<string, unknown> }>('themePackGet', own.id)
      const uploaded = await vialApi<{ success: boolean; postId: string }>('hubUploadThemePost', { entryId: own.id, pack })
      expect(uploaded.success).toBe(true)
      const linked = await waitForPack('themePackList', (meta) => meta.id === own.id && meta.hubPostId === uploaded.postId, 'the theme was not linked')
      expect(linked.uploaderName).toBe(DISPLAY_NAME)

      const listed = await vialApi<{ success: boolean; data: { items: { id: string; name: string }[] } }>('hubListThemePosts', { q: 'E2E Own' })
      expect(listed.data.items.map((item) => [item.id, item.name])).toEqual([[uploaded.postId, OWN_THEME_PACK]])
      expect(await vialApi('hubUpdateThemePost', { entryId: own.id, postId: uploaded.postId, pack })).toEqual(
        expect.objectContaining({ success: true }),
      )
      const onHub = fakeHub().state.packs.theme.find((p) => p.id === uploaded.postId)
      await waitForPack('themePackList', (meta) => meta.id === own.id && meta.hubUpdatedAt === onHub?.updated_at, 'the update time was not kept')
      const stamps = await dataOf<{ items: { id: string; updated_at: string }[] }>('themePackHubTimestamps', [uploaded.postId])
      expect(stamps.items).toEqual([{ id: uploaded.postId, updated_at: onHub?.updated_at }])
      const downloaded = await vialApi<{ success: boolean; data: { name: string } }>('hubDownloadThemePost', uploaded.postId)
      expect(downloaded.data.name).toBe(OWN_THEME_PACK)

      expect(await vialApi('hubDeleteThemePost', uploaded.postId, own.id)).toEqual({ success: true })
      expect(fakeHub().state.packs.theme).toEqual([])
      await waitForPack('themePackList', (meta) => meta.id === own.id && meta.hubPostId === undefined, 'the theme is still linked')
    })

    it('updates the Hub-linked language pack at launch, and on demand with the change event', async () => {
      const save = (pack: Record<string, Record<string, string>>, text: string): void => {
        pack.common.save = text
      }
      const touched = await changeHubLanguagePack(hubLanguagePack.id, (pack) => save(pack, 'E2E 保存 1'))
      earlierErrors.push(...(await recordedPageErrors()))
      await restartApp()
      await recordPageErrors()
      await browser.waitUntil(async () => (await hubState()).startupSyncDone, {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: 'the startup update of the language packs did not finish',
      })
      expect((await hubState()).startupSync).toEqual({ checked: 1, updated: 1, missingOnHub: 0, errors: 0 })
      const body = async (): Promise<string> =>
        (await dataOf<{ pack: { common: { save: string } } }>('i18nPackGet', hubLanguagePack.localId)).pack.common.save
      expect(await body()).toBe('E2E 保存 1')
      await waitForPack('i18nPackList', (meta) => meta.id === hubLanguagePack.localId && meta.hubUpdatedAt === touched, 'the update time was not kept')

      await browser.execute(() => {
        const page = window as unknown as {
          __e2eI18nChanged: number
          vialAPI: { i18nPackOnChanged: (callback: () => void) => () => void }
        }
        page.__e2eI18nChanged = 0
        page.vialAPI.i18nPackOnChanged(() => { page.__e2eI18nChanged += 1 })
      })
      await changeHubLanguagePack(hubLanguagePack.id, (pack) => save(pack, 'E2E 保存 2'))
      expect(await invokeCommand('dev_hub_run_startup_sync')).toEqual({ checked: 1, updated: 1, missingOnHub: 0, errors: 0 })
      await browser.waitUntil(
        () => browser.execute(() => (window as unknown as { __e2eI18nChanged: number }).__e2eI18nChanged > 0),
        { timeoutMsg: 'no i18n-pack:changed event came' },
      )
      expect(await body()).toBe('E2E 保存 2')
      // Nothing newer on the Hub: nothing is downloaded.
      expect(await invokeCommand('dev_hub_run_startup_sync')).toEqual({ checked: 1, updated: 0, missingOnHub: 0, errors: 0 })
    })

    it('takes a token again after a 401, waits out a 429, and shows a deactivated account after a 403', async () => {
      const myPosts = (): Promise<{ success: boolean; error?: string }> => vialApi('hubFetchMyPosts')
      await waitForHubQuiet()
      expect((await myPosts()).success).toBe(true)
      expect((await hubState()).tokenCached).toBe(true)

      let from = fakeHub().requests.length
      await injectHubFault({ status: 401, count: 1, only: 'files.me' })
      expect((await myPosts()).success).toBe(true)
      expect(hubRequestsSince(from).map((r) => r.op)).toEqual(['files.me', 'auth.token', 'files.me'])

      from = fakeHub().requests.length
      await injectHubFault({ status: 429, count: 1, only: 'files.me', retryAfter: '1' })
      const started = Date.now()
      expect((await myPosts()).success).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(hubRequestsSince(from).map((r) => r.op)).toEqual(['files.me', 'files.me'])

      // A long wait is not waited out.
      await injectHubFault({ status: 429, count: 1, only: 'files.me', retryAfter: '3600' })
      expect(await myPosts()).toEqual({ success: false, error: 'RATE_LIMITED' })

      // The page's own request of the posts at launch gets the 403.
      await injectHubFault({ status: 403, count: 1, only: 'files.me' })
      earlierErrors.push(...(await recordedPageErrors()))
      await restartApp()
      await recordPageErrors()
      await openHubSettings()
      await $(tid('hub-account-deactivated-warning')).waitForDisplayed({ timeout: 30_000 })
      await closeSettings()
      expect(await myPosts()).toEqual(expect.objectContaining({ success: true }))
    })
  })

  describe('a Google account', () => {
    it('signs in with the fake Google, takes a Hub token with its id_token, and forgets the token on sign-out', async () => {
      earlierErrors.push(...(await recordedPageErrors()))
      await switchToGoogleSession()
      await recordPageErrors()
      await $(tid('settings-button')).waitForDisplayed({ timeout: 20_000 })
      expect(await vialApi('hubFetchAuthMe')).toEqual({ success: false, error: HUB_ERROR_NOT_AUTHENTICATED })

      await openSyncSettings()
      await signIn()
      const from = fakeHub().requests.length
      await clickWhenEnabled(tid('hub-enable-toggle'))
      await browser.waitUntil(() => readAppConfig().hubEnabled === true, { timeoutMsg: 'the Hub was not enabled' })
      // A new account, which the Hub has no display name for.
      await waitForHub(
        () => hubUser(GOOGLE_ACCOUNT) !== undefined && hubRequestsSince(from).some((r) => r.op === 'auth.me'),
        'the Hub account was not created and read',
      )
      await waitForHubQuiet()
      expect(hubUser(GOOGLE_ACCOUNT)?.display_name).toBeNull()
      await $(tid('hub-display-name-required')).waitForDisplayed()
      const sent = hubRequestsSince(from)
      const tokens = sent.filter((r) => r.op === 'auth.token')
      expect(tokens.length).toBeGreaterThanOrEqual(1)
      for (const token of tokens) expect(token.body).toEqual({ json: { id_token: '[redacted]' } })
      const authorized = sent.filter((r) => r.op !== 'auth.token')
      expect(authorized.length).toBeGreaterThanOrEqual(1)
      for (const request of authorized) expect(request.account).toBe(GOOGLE_ACCOUNT)
      const signedIn = await hubState()
      expect(signedIn.tokenCached).toBe(true)

      await clickInPage(tid('sync-sign-out'))
      await clickInPage(tid('sync-sign-out-confirm'))
      await $(tid('sync-sign-in')).waitForDisplayed({ timeout: 30_000 })
      const signedOut = await hubState()
      expect(signedOut.tokenCached).toBe(false)
      expect(signedOut.tokenGeneration).toBeGreaterThan(signedIn.tokenGeneration)
      await $(tid('hub-requires-auth')).waitForDisplayed()

      await waitForHubQuiet()
      const before = fakeHub().requests.length
      expect(await vialApi('hubFetchAuthMe')).toEqual({ success: false, error: HUB_ERROR_NOT_AUTHENTICATED })
      expect(hubRequestsSince(before)).toEqual([])
      await closeSettings()
    })
  })

  describe('the page', () => {
    it('sent the Hub only requests of the routes it serves', () => {
      expect(fakeHub().requests.filter((r) => r.op === null).map((r) => `${r.method} ${r.path}`)).toEqual([])
    })

    it('logged no page errors', async () => {
      expect([...earlierErrors, ...(await recordedPageErrors())]).toEqual([])
    })
  })
})
