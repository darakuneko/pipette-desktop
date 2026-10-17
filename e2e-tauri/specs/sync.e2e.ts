// SPDX-License-Identifier: GPL-2.0-or-later
//
// Cloud Sync in the Tauri build, against the Node fake Drive of
// scripts/fake-drive (helpers/sync-harness.ts starts it and refuses to
// launch an app that is not pointed at it). Two machines share the Drive
// one after the other, as the app is a single instance: machine A signs
// in, sets the password and turns Auto Sync on; a change goes up ten
// seconds after it is saved; Analyze uploads the typing days of the
// keyboard it opens; a change saved right before a quit reaches Drive or
// stays pending. Machine B (another userData directory, so another machine
// hash) signs in with the same password, polls, lists the keyboard only on
// Drive and downloads it on connect; a duplicate on Drive goes to the
// trash and is deleted from the trash screen; A's typing days are fetched
// when B opens them, and one is deleted; a password change a quit
// interrupts is resumed after the restart; a newer sync-format marker
// stops the sync; the three resets clear Drive, the keyboard and the
// app's settings. Failures are injected through the fake Drive's control
// endpoint; the duplicate and the newer marker are put in its state, as
// another machine would have written them. The tests share the sessions
// and run in order.

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  invokeCommand,
  openToolsOverlay,
  restartApp,
  tid,
  vialApi,
  VIRTUAL_DEVICE_NAME,
  waitForGone,
} from '../helpers/app'
import { quitApp, readAppConfig, readPendingUnits, userDataPath } from '../helpers/driver'
import { fakeDrive, injectDriveFault, switchMachine } from '../helpers/sync-harness'
import {
  closeDataModal,
  closeSettings,
  deviceDayContent,
  driveClock,
  driveFileNames,
  driveFilesNamed,
  driveModifiedTime,
  enableAutoSync,
  expandBranch,
  openDataModal,
  openSyncSettings,
  pollUntil,
  returnToDeviceList,
  setPassword,
  settingsFileName,
  signIn,
  submitPassword,
  waitForQuietSync,
} from '../helpers/sync'

const PASSWORD = 'e2e-Sync-Pass-7Qx!vR2#mK9w-Lime'
const NEW_PASSWORD = 'e2e-Changed-Pass-4Lp$zT8@nB3q-Fig'
/** The keyboard of the seeded typing days. */
const TYPING_UID = 'e2e-sync-typing-kb'
const TYPING_SCOPE = 'e2e-sync-scope'
/** A keyboard B types on and deletes the typing of. */
const SCRATCH_UID = 'e2e-sync-scratch-kb'
const FAVORITE_LABEL = 'E2E sync favorite'
const FAVORITE_FILE = 'favorites_tapDance.enc'
const TAP_DANCE = { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
const META_FILE = 'meta_keyboard-names.enc'
const PASSWORD_CHANGE_LOCK = 'password-change-lock.json'
const AUTO_MOVE = '[data-testid="overlay-auto-advance-toggle"]'
/** The flush's delay after the last change (trigger A). */
const FLUSH_DELAY_MS = 10_000
/** Longer than the deadline of the app's own quit sequence (30 s). */
const QUIT_TIMEOUT_MS = 40_000
const DAY_MS = 86_400_000

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function readSettings(uid: string): Record<string, unknown> | null {
  const path = userDataPath('sync', 'keyboards', uid, 'pipette_settings.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null
}

const machineHash = (): Promise<string> => invokeCommand<string>('dev_typing_analytics_machine_hash')

const dayFileName = (uid: string, hash: string, day: string): string =>
  `keyboards_${uid}_devices_${hash}_days_${day}.enc`

/** Flips Auto Move of the connected keyboard, and resolves with the new
 *  value once the pipette settings hold it. */
async function toggleAutoMove(uid: string): Promise<boolean> {
  await openToolsOverlay()
  const next = (await $(AUTO_MOVE).getAttribute('aria-checked')) !== 'true'
  await $(AUTO_MOVE).click()
  await browser.waitUntil(() => readSettings(uid)?.autoAdvance === next, {
    timeoutMsg: 'Auto Move was not stored in the pipette settings',
  })
  return next
}

/** Deletes the day `date` (local) from the typing list the Data modal
 *  shows. */
async function deleteDay(date: string): Promise<void> {
  const box = $(tid(`typing-row-${date}`)).$('input[type="checkbox"]')
  await box.waitForDisplayed({ timeout: 30_000 })
  await box.click()
  await browser.waitUntil(() => box.isSelected(), { timeoutMsg: `the day ${date} was not selected` })
  await clickInPage(tid('typing-delete-selected'))
  await clickInPage(tid('typing-delete-selected-confirm'))
}

/** Leaves the keymap editor for the device list. */
async function disconnect(): Promise<void> {
  await clickInPage(tid('disconnect-button'))
  await $(tid('settings-button')).waitForDisplayed()
}

async function connectAndFindUid(): Promise<string> {
  await connectVirtualKeyboard()
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

describe('Tauri build Cloud Sync', function () {
  this.timeout(180_000)

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return
    const page = await browser.execute(() => document.body.innerText).catch((err: unknown) => String(err))
    console.error(`page text at the failure:\n${page.slice(0, 1500)}`)
    console.error(`files on the fake Drive: ${driveFileNames().join(', ')}`)
    await returnToDeviceList()
  })

  let uid = ''
  let hashA = ''
  let hashB = ''
  let autoAdvanceOnDrive = false
  const typingDays = [utcDay(Date.now() - 2 * DAY_MS), utcDay(Date.now() - DAY_MS)]
  const ownTypingDay = utcDay(Date.now() - 3 * DAY_MS)

  describe('machine A', () => {
    it('signs in, sets the password and uploads a change ten seconds after it is saved', async () => {
      hashA = await machineHash()
      await openSyncSettings()
      await signIn()
      await setPassword(PASSWORD)
      expect(driveFileNames()).toContain('sync-format-v2.json')
      await enableAutoSync()
      expect(readAppConfig().autoSync).toBe(true)
      await closeSettings()

      const saved = await vialApi<{ success: boolean }>(
        'favoriteStoreSave',
        'tapDance',
        JSON.stringify({ type: 'tapDance', data: TAP_DANCE }),
        FAVORITE_LABEL,
      )
      expect(saved.success).toBe(true)
      uid = await connectAndFindUid()
      autoAdvanceOnDrive = await toggleAutoMove(uid)
      const savedAt = Date.now()
      await browser.waitUntil(() => driveFilesNamed(settingsFileName(uid)).length > 0, {
        timeout: 45_000,
        timeoutMsg: 'the saved setting did not reach Drive',
      })
      expect(Date.now() - savedAt).toBeGreaterThanOrEqual(FLUSH_DELAY_MS - 2000)
      // The keyboard's name, written on connect, may go with the next flush.
      await browser.waitUntil(
        () => [FAVORITE_FILE, META_FILE].every((name) => driveFilesNamed(name).length === 1),
        { timeout: 45_000, timeoutMsg: 'the favorite and the keyboard names did not reach Drive' },
      )
      await browser.waitUntil(() => !readPendingUnits().includes(`keyboards/${uid}/settings`), {
        timeoutMsg: 'the uploaded unit is still pending',
      })
    })

    it('uploads the typing days of the keyboard Analyze opens', async () => {
      await disconnect()
      await restartApp(() => {
        const dir = userDataPath('sync', 'keyboards', TYPING_UID, 'devices', hashA)
        mkdirSync(dir, { recursive: true })
        for (const day of typingDays) writeFileSync(join(dir, `${day}.jsonl`), deviceDayContent(TYPING_UID, hashA, TYPING_SCOPE, day))
        // Without it the launch keeps the cache, which lacks the days.
        rmSync(userDataPath('local', 'typing-analytics', 'sync_state.json'), { force: true })
      })
      for (const day of typingDays) expect(driveFilesNamed(dayFileName(TYPING_UID, hashA, day))).toHaveLength(0)

      await clickInPage(tid('tab-analyze'))
      await $(tid('analyze-page')).waitForDisplayed()
      await clickInPage(tid('analyze-filter-chip'))
      await $(tid('analyze-filter-modal')).waitForDisplayed()
      await $(tid(`analyze-kb-${TYPING_UID}`)).waitForExist({ timeout: 30_000 })
      await $(tid('analyze-filter-keyboard')).selectByAttribute('value', TYPING_UID)
      await $(tid('analyze-filter-modal-apply')).click()
      await waitForGone(tid('analyze-filter-modal'), 'the Analyze filter modal did not close')
      await browser.waitUntil(
        () => typingDays.every((day) => driveFilesNamed(dayFileName(TYPING_UID, hashA, day)).length === 1),
        { timeout: 60_000, timeoutMsg: 'the typing days did not reach Drive' },
      )
      await clickInPage(tid('analyze-back'))
      await $(tid('analyze-page')).waitForDisplayed({ reverse: true })
    })

    it('sends a change saved right before a quit, or keeps it pending', async () => {
      await connectVirtualKeyboard()
      const before = driveModifiedTime(settingsFileName(uid))
      const value = await toggleAutoMove(uid)
      await quitApp(QUIT_TIMEOUT_MS)
      const reached = driveModifiedTime(settingsFileName(uid)) > before
      const pending = readPendingUnits().includes(`keyboards/${uid}/settings`)
      expect(reached || pending).toBe(true)
      if (reached) autoAdvanceOnDrive = value
    })
  })

  describe('machine B', () => {
    it('signs in with the same password, polls, lists the keyboard only on Drive and downloads it on connect', async () => {
      await switchMachine()
      hashB = await machineHash()
      expect(hashB).not.toBe(hashA)

      await openSyncSettings()
      await signIn()
      await $(tid('sync-existing-password-hint')).waitForDisplayed({ timeout: 30_000 })
      await setPassword(PASSWORD)
      await enableAutoSync()
      await closeSettings()

      const meta = userDataPath('sync', 'meta', 'keyboard-names.json')
      await pollUntil(() => existsSync(meta), 'the poll did not download the keyboard names')
      const favorites = await vialApi<{ entries: { label: string }[] }>('favoriteStoreList', 'tapDance')
      expect(favorites.entries.map((entry) => entry.label)).toContain(FAVORITE_LABEL)
      expect(existsSync(userDataPath('sync', 'keyboards', uid))).toBe(false)

      await openDataModal()
      await expandBranch('nav-sync', 'nav-sync-keyboards', 30_000)
      await expandBranch('nav-sync-keyboards', `nav-sync-kb-${uid}`)
      expect(String(await $(tid(`nav-sync-kb-${uid}`)).getProperty('textContent'))).toContain(VIRTUAL_DEVICE_NAME)
      await clickInPage(tid('nav-sync-cloud-data'))
      await $(tid('cloud-data-content')).waitForDisplayed({ timeout: 30_000 })
      await closeDataModal()

      // A connect's download does nothing while another pass runs.
      await waitForQuietSync()
      expect(await connectAndFindUid()).toBe(uid)
      await browser.waitUntil(() => readSettings(uid)?.autoAdvance === autoAdvanceOnDrive, {
        timeout: 30_000,
        timeoutMsg: "the connect did not download A's settings",
      })
      await $(EDITOR_SELECTOR).waitForDisplayed()
      await disconnect()
    })

    it('moves a duplicate on Drive to the trash and deletes it from the trash screen', async () => {
      const [original] = driveFilesNamed(META_FILE)
      fakeDrive().state.create(META_FILE, Buffer.from(original.content), original.mimeType)
      const trashed = (): string[] => driveFileNames().filter((name) => name.startsWith(`${META_FILE}.trash.`))
      await pollUntil(() => trashed().length === 1 && driveFilesNamed(META_FILE).length === 1, 'the duplicate was not moved to the trash')
      const [trashFile] = fakeDrive().state.files.filter((file) => file.name.startsWith(`${META_FILE}.trash.`))

      await openDataModal()
      await expandBranch('nav-sync', 'nav-sync-trash', 30_000)
      await clickInPage(tid('nav-sync-trash'))
      await $(tid(`trash-row-${trashFile.id}`)).waitForDisplayed({ timeout: 30_000 })
      await clickInPage(tid(`trash-delete-${trashFile.id}`))
      await clickInPage(tid(`trash-delete-confirm-${trashFile.id}`))
      await $(tid('trash-empty')).waitForDisplayed({ timeout: 30_000 })
      expect(trashed()).toEqual([])
      expect(driveFilesNamed(META_FILE)).toHaveLength(1)
      await closeDataModal()
    })

    it('resumes a password change that a quit interrupted', async () => {
      const statePath = userDataPath('local', 'auth', 'sync-password-change.json')
      const clockBefore = driveClock()
      await openSyncSettings()
      await clickInPage(tid('sync-password-change-btn'))
      const requestsBefore = fakeDrive().requests.length
      // The re-encryption's first write waits out a rate limit; the quit
      // cuts the wait.
      await injectDriveFault({ status: 429, retryAfter: '30', count: 1, only: 'update' })
      await submitPassword(NEW_PASSWORD)
      await browser.waitUntil(
        () =>
          existsSync(statePath) &&
          fakeDrive().requests.slice(requestsBefore).some((r) => r.method === 'PATCH' && r.path.startsWith('/upload/')),
        { timeout: 60_000, timeoutMsg: 'the re-encryption did not start' },
      )
      expect(JSON.parse(readFileSync(statePath, 'utf8')).step).toBe('reencrypting')
      expect(driveFilesNamed(PASSWORD_CHANGE_LOCK)).toHaveLength(1)

      await restartApp(async () => {
        // Days typed on B, for the next test: the Data modal lists the other
        // devices' typing of the keyboards B has typing of, once a local
        // typing page has been emptied.
        for (const typingUid of [TYPING_UID, SCRATCH_UID]) {
          const dir = userDataPath('sync', 'keyboards', typingUid, 'devices', hashB)
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, `${ownTypingDay}.jsonl`), deviceDayContent(typingUid, hashB, `${typingUid}-b`, ownTypingDay))
        }
        rmSync(userDataPath('local', 'typing-analytics', 'sync_state.json'), { force: true })
      })
      expect(existsSync(statePath)).toBe(true)
      await openSyncSettings()
      await $(tid('sync-password-change-panel')).waitForDisplayed({ timeout: 30_000 })
      await clickInPage(tid('sync-password-change-resume'))
      await $(tid('sync-password-set')).waitForDisplayed({ timeout: 90_000 })
      expect(existsSync(statePath)).toBe(false)
      expect(driveFilesNamed(PASSWORD_CHANGE_LOCK)).toHaveLength(0)
      // Every data file was written again under the new password.
      const data = fakeDrive().state.files.filter((file) => file.name.endsWith('.enc') && !file.name.includes('.trash.'))
      expect(data.length).toBeGreaterThan(0)
      for (const file of data) expect([file.name, file.modifiedTime > clockBefore]).toEqual([file.name, true])
      await closeSettings()
    })

    it("fetches another device's typing days when they are opened, and deletes one", async () => {
      const remoteDir = userDataPath('sync', 'keyboards', TYPING_UID, 'devices', hashA)
      expect(existsSync(remoteDir)).toBe(false)

      await openDataModal()
      // The Sync side's typing branch shows once a local typing page has
      // been emptied, which refreshes the typing lists; it lists the
      // keyboards B has local typing of.
      await expandBranch('nav-local', 'nav-local-typing')
      await expandBranch('nav-local-typing', `nav-typing-${SCRATCH_UID}`)
      await clickInPage(tid(`nav-typing-${SCRATCH_UID}`))
      await $(tid(`typing-row-${ownTypingDay}`)).waitForDisplayed({ timeout: 30_000 })
      await clickInPage(tid('typing-delete-all'))
      await clickInPage(tid('typing-delete-all-confirm'))
      await $(tid('typing-empty')).waitForDisplayed({ timeout: 30_000 })

      await expandBranch('nav-sync', 'nav-sync-typing', 30_000)
      await expandBranch('nav-sync-typing', `nav-sync-typing-${TYPING_UID}`)
      await expandBranch(`nav-sync-typing-${TYPING_UID}`, `nav-sync-typing-${TYPING_UID}-${hashA}`, 30_000)
      await clickInPage(tid(`nav-sync-typing-${TYPING_UID}-${hashA}`))
      await $(tid('typing-list')).waitForDisplayed({ timeout: 30_000 })
      const listed = (): Promise<{ date: string }[]> => vialApi('typingAnalyticsListItemsForHash', TYPING_UID, hashA)
      await browser.waitUntil(async () => (await listed()).length === typingDays.length, {
        timeoutMsg: "A's typing days were not fetched",
      })
      expect(readdirSync(remoteDir).filter((name) => name.endsWith('.jsonl')).sort()).toEqual(
        typingDays.map((day) => `${day}.jsonl`),
      )

      const [first] = await listed()
      await deleteDay(first.date)
      await browser.waitUntil(async () => (await listed()).length === typingDays.length - 1, {
        timeoutMsg: 'the day was not deleted',
      })
      await closeDataModal()
    })

    it('resets a cloud target from the Cloud Data screen', async () => {
      expect(driveFilesNamed(FAVORITE_FILE)).toHaveLength(1)
      await openDataModal()
      // The local favorites stay.
      const before = await vialApi<{ entries: unknown[] }>('favoriteStoreList', 'tapDance')
      await expandBranch('nav-sync', 'nav-sync-cloud-data', 30_000)
      await clickInPage(tid('nav-sync-cloud-data'))
      await clickInPage(tid('cloud-data-reset-favorites'))
      await clickInPage(tid('cloud-data-confirm-favorites'))
      await browser.waitUntil(() => driveFilesNamed(FAVORITE_FILE).length === 0, {
        timeout: 30_000,
        timeoutMsg: 'the favorites stayed on Drive',
      })
      expect(await vialApi('favoriteStoreList', 'tapDance')).toEqual(before)
      await closeDataModal()
    })

    it("deletes all of a keyboard's data", async () => {
      const prefix = `keyboards_${uid}_`
      expect(driveFileNames().some((name) => name.startsWith(prefix))).toBe(true)
      await openDataModal()
      await expandBranch('nav-local', 'nav-local-keyboards')
      await expandBranch('nav-local-keyboards', `nav-kb-${uid}`)
      await clickInPage(tid(`nav-kb-${uid}`))
      await clickInPage(tid('kb-saves-delete-all'))
      await clickInPage(tid('kb-saves-delete-all-confirm'))
      await browser.waitUntil(() => !driveFileNames().some((name) => name.startsWith(prefix)), {
        timeout: 30_000,
        timeoutMsg: "the keyboard's files stayed on Drive",
      })
      expect(existsSync(userDataPath('sync', 'keyboards', uid))).toBe(false)
      await closeDataModal()
    })

    it('stops at a sync-format marker newer than its own', async () => {
      fakeDrive().state.create('sync-format-v3.json', Buffer.from('{}'), 'application/json')
      await invokeCommand('dev_sync_run_poll_now')
      await $(tid('sync-update-banner')).waitForDisplayed({ timeout: 30_000 })
      expect(await vialApi<{ updateRequired: boolean }>('syncFormatStatus')).toEqual(
        expect.objectContaining({ updateRequired: true }),
      )
      // A manual upload stops before it writes anything.
      const clock = driveClock()
      await vialApi('favoriteStoreSave', 'tapDance', JSON.stringify({ type: 'tapDance', data: TAP_DANCE }), FAVORITE_LABEL)
      expect(await vialApi('syncExecute', 'upload', 'favorites')).toEqual(
        expect.objectContaining({ status: 'skipped', skipReason: 'updateRequired' }),
      )
      expect(driveClock()).toBe(clock)
    })

    it("resets the app's settings, which signs out", async () => {
      await openDataModal()
      await expandBranch('nav-local', 'nav-local-application')
      await clickInPage(tid('nav-local-application'))
      await clickInPage(tid('app-reset-btn'))
      await clickInPage(tid('app-reset-confirm'))
      const authDir = userDataPath('local', 'auth')
      await browser.waitUntil(() => !existsSync(authDir) || readdirSync(authDir).length === 0, {
        timeoutMsg: 'local/auth was not cleared',
      })
      await closeDataModal()
      expect(readAppConfig().autoSync).toBeFalsy()
      expect(await vialApi<{ authenticated: boolean }>('syncAuthStatus')).toEqual(
        expect.objectContaining({ authenticated: false }),
      )
    })
  })
})
