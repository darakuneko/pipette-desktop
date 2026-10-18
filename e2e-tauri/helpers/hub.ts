// SPDX-License-Identifier: GPL-2.0-or-later
//
// The UI steps and the fake Hub's state the Hub spec shares: the Settings
// modal's Hub section, the snapshot rows of the Import / Save tab, the pack
// modals of the Tools tab, the stores read through vialAPI, and the waits
// on the fake Hub.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $, browser } from '@wdio/globals'
import type { HubPrivateLink } from '../../src/shared/types/hub-private'
import {
  clickInPage,
  closeSettings,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  invokeCommand,
  openOverlayTab,
  tid,
  vialApi,
  VIRTUAL_DEVICE_NAME,
  waitForGone,
  waitForUncovered,
} from './app'
import { userDataPath } from './driver'
import { fakeHub, hubControl } from './hub-harness'
import { fillInput } from './sync'

export const SAMPLE_PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '../../sample-packs')

/** The fake Hub's account with `email`. */
export function hubUser(email: string): { display_name: string | null } | undefined {
  return fakeHub().state.users.find((user) => user.email === email)
}

export async function openHubSettings(): Promise<void> {
  await clickInPage(tid('settings-button'))
  await $(tid('settings-modal')).waitForDisplayed()
  await clickInPage(tid('settings-tab-data'))
  await $(tid('pipette-hub-title')).waitForDisplayed()
}

/** Types `name` into the display name field and saves it. */
export async function saveDisplayName(name: string): Promise<void> {
  await fillInput(tid('hub-display-name-input'), name)
  const save = $(tid('hub-display-name-save'))
  await browser.waitUntil(() => save.isEnabled(), { timeoutMsg: `the display name ${name} cannot be saved` })
  await save.click()
}

export interface SnapshotEntry {
  id: string
  label: string
  hubPostId?: string
  hubPrivate?: HubPrivateLink
  deletedAt?: string
}

/** The live snapshot of keyboard `uid` labelled `label`, as on disk. */
export function snapshotEntry(uid: string, label: string): SnapshotEntry | undefined {
  const index = JSON.parse(readFileSync(userDataPath('sync', 'keyboards', uid, 'snapshots', 'index.json'), 'utf8')) as {
    entries: SnapshotEntry[]
  }
  return index.entries.find((entry) => entry.label === label && !entry.deletedAt)
}

/** The fake Hub's public posts and private posts titled `title`. */
export const hubPosts = (title: string) => fakeHub().state.posts.filter((post) => post.title === title)
export const hubPrivatePosts = (title: string) => fakeHub().state.privatePosts.filter((post) => post.title === title)

/** Connects the virtual keyboard, waits until nothing covers the editor,
 *  and answers the keyboard's uid. */
export async function connectAndFindUid(): Promise<string> {
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

/** The `{success, data}` answer of `member`, its data, or a throw. */
export async function dataOf<T>(member: string, ...args: unknown[]): Promise<T> {
  const answer = await vialApi<{ success: boolean; data?: T; error?: string }>(member, ...args)
  if (!answer.success) throw new Error(`${member} failed: ${JSON.stringify(answer)}`)
  return answer.data as T
}

/** Calls `member` with `paths` queued as the answer of its file dialog
 *  (`dev_dialog_respond`), and checks that the call took that answer. */
export async function withFilesDialog<T>(paths: string[], member: string, ...args: unknown[]): Promise<T> {
  const queued = (): Promise<number> => invokeCommand<number>('dev_dialog_queued')
  if ((await queued()) !== 0) throw new Error('a file dialog answer from an earlier step is still queued')
  await invokeCommand('dev_dialog_respond', { paths })
  const answer = await vialApi<T>(member, ...args)
  if ((await queued()) !== 0) throw new Error(`${member} opened no file dialog`)
  return answer
}

export interface PackMeta {
  id: string
  name: string
  hubPostId?: string
  uploaderName?: string
  hubUpdatedAt?: string
}

/** Waits until `member` lists a pack for which `match` holds, and
 *  answers it. */
export async function waitForPack(member: string, match: (meta: PackMeta) => boolean, timeoutMsg: string): Promise<PackMeta> {
  let found: PackMeta | undefined
  await browser.waitUntil(
    async () => {
      found = (await dataOf<PackMeta[]>(member)).find(match)
      return found !== undefined
    },
    { timeout: 30_000, timeoutMsg },
  )
  return found as PackMeta
}

/** Opens the device selector's settings on the Tools tab and the pack
 *  modal `modal` from its button `button`. */
export async function openFromTools(button: string, modal: string): Promise<void> {
  await clickInPage(tid('settings-button'))
  await $(tid('settings-modal')).waitForDisplayed()
  await clickInPage(tid('settings-tab-tools'))
  await clickInPage(tid(button))
  await $(tid(modal)).waitForDisplayed()
}

export async function closeFromTools(close: string, modal: string): Promise<void> {
  await clickInPage(tid(close))
  await waitForGone(tid(modal), `${modal} did not close`)
  await closeSettings()
}

/** The language pack the fake Hub keeps under `id`, with `edit` applied to
 *  its body, and its update time moved on. */
export async function changeHubLanguagePack(id: string, edit: (pack: Record<string, Record<string, string>>) => void): Promise<string> {
  const stored = fakeHub().state.packs.i18n.find((pack) => pack.id === id)
  if (!stored) throw new Error(`the fake Hub has no language pack ${id}`)
  const exported = JSON.parse(stored.pack_json) as { pack: Record<string, Record<string, string>> }
  edit(exported.pack)
  stored.pack_json = JSON.stringify(exported)
  return (await hubControl<{ updated_at: string }>('touch', { kind: 'i18n', id })).updated_at
}

export const readSample = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(SAMPLE_PACKS, path), 'utf8')) as Record<string, unknown>

export async function disconnect(): Promise<void> {
  await clickInPage(tid('disconnect-button'))
  await $(tid('settings-button')).waitForDisplayed()
}

/** Clicks `selector` once it is enabled: an action button stays disabled
 *  while the previous Hub operation finishes, and a click on it then does
 *  nothing. */
export async function clickWhenEnabled(selector: string): Promise<void> {
  const element = $(selector)
  await element.waitForExist({ timeout: 30_000 })
  await browser.waitUntil(() => element.isEnabled(), { timeout: 60_000, timeoutMsg: `${selector} stayed disabled` })
  await clickInPage(selector)
}

/** Clicks `button` of the snapshot row in the Import / Save tab, picks
 *  `visibility` in the upload dialog it opens, and confirms it. */
export async function uploadWithVisibility(button: string, visibility: 'public' | 'private'): Promise<void> {
  await openOverlayTab('data')
  await waitForUncovered(tid(button))
  await clickWhenEnabled(tid(button))
  await $(tid('upload-confirm-submit')).waitForDisplayed()
  await clickInPage(`${tid(`upload-confirm-visibility-${visibility}`)} input`)
  await clickInPage(tid('upload-confirm-submit'))
  await waitForGone(tid('upload-confirm-backdrop'), 'the upload dialog did not close')
}

/** Waits until the fake Hub has taken no request for a second, three
 *  times in a row: the page's own requests (its refresh of the posts
 *  after a launch or a sign-in) have ended, so the requests that follow
 *  are the test's. */
export async function waitForHubQuiet(): Promise<void> {
  let last = -1
  let quietChecks = 0
  await browser.waitUntil(
    () => {
      const count = fakeHub().requests.length
      quietChecks = count === last ? quietChecks + 1 : 0
      last = count
      return quietChecks >= 3
    },
    { timeout: 60_000, interval: 1000, timeoutMsg: 'the page kept sending Hub requests' },
  )
}

/** Waits for `done`, polling every half second, for at most a minute: an
 *  upload builds the keymap's PDF and thumbnail first. */
export async function waitForHub(done: () => boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => done(), { timeout: 60_000, interval: 500, timeoutMsg })
}
