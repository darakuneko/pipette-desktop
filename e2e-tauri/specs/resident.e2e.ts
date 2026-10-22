// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Tauri build's resident behaviour on the virtual keyboard: the startup
// notices from the fake notice server of scripts/fake-notification (the
// modal newest first, marked seen when closed, the Settings modal's three
// newest, nothing after a 500, the request's body), the tray's rows (the
// keyboard's name and REC's count, dropped on a disconnect with REC on and
// counted from zero on the reconnect), the close button hiding the window
// into the tray, starting hidden in the tray, a login autostart entry in
// the session's own autostart directory, Reset Local Data › App Settings
// turning the autostart entry, the tray icon and the zoom back to the
// defaults, the Typing View's compact window (minimum size, aspect ratio,
// always on top), and Quit from the tray. The
// tests share one session (helpers/resident-harness.ts) and run in order;
// each restart quits the app and launches it again on the same userData
// directory.
//
// The tests' X server runs no window manager: what the app applied to the
// window is read with dev_window_state, not from the window system.

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  closeSettings,
  connectVirtualKeyboard,
  countIn,
  EDITOR_SELECTOR,
  invokeCommand,
  localDays,
  pageZoom,
  readAppLog,
  restartApp,
  tid,
  totalKeystrokes,
  UNLOCK_KEYS,
  unlockIfAsked,
  vialApi,
  VIRTUAL_DEVICE_NAME,
  virtualDevice,
  waitForGone,
  waitForUncovered,
  ZOOM_PERCENT,
} from '../helpers/app'
import { APP_BINARY, quitApp, readAppConfig, sessionAppPid, userDataPath, waitForAppExit } from '../helpers/driver'
import {
  assertTrayActive,
  clickTrayMenu,
  isWindowVisible,
  openSettings,
  readUntil,
  readUntilSettled,
  recordVisibility,
  setSettingsToggle,
  trayRows,
  trayState,
  waitForVisibilityEvents,
  waitForPage,
  waitForTray,
  waitForSettledWindow,
  waitForVisible,
  waitForWindow,
  windowState,
  type WindowSize,
  type WindowState,
} from '../helpers/resident'
import { fakeNotices, firstLaunchAt, startupNotices } from '../helpers/resident-harness'
import { closeDataModal, fillInput, resetAppSettings } from '../helpers/sync'
import { requestWindowClose, viewableWindowCount } from '../helpers/x11-window'
import { firestoreTimestamp, notice } from '../../scripts/fake-notification/server'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DAY_MS = 24 * 60 * 60 * 1000
/** How long a launch is watched for a modal that must not come up, after
 *  the app has fetched its notices. */
const NO_MODAL_WAIT_MS = 2_000
/** How long the window state is sampled after a move. */
const MOVE_SAMPLE_MS = 1_500
// Longer than the deadline of the app's own quit sequence (30 s).
const QUIT_TIMEOUT_MS = 40_000
const MODAL = tid('notification-modal-backdrop')
const TYPED_KEYS: [number, number][] = [[2, 3], [2, 4], [2, 5]]
const KEY_HOLD_MS = 120
const KEY_GAP_MS = 60
/** Longer than the renderer's throttle of the tray's count updates (1 s),
 *  so a count that stays this long is the last one sent. */
const TRAY_COUNT_SETTLED_MS = 1_500
/** How long the hidden launch may take to fetch its notices. */
const HIDDEN_LAUNCH_TIMEOUT_MS = 60_000
/** Under Wayland the app neither reads nor sets its window's position. */
const positionsKnown = !process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND === 'x11'

/** The request body of the recorded golden of the notice fetch with the
 *  time `now`. */
function goldenNoticeBody(now: number): string {
  const golden = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src-tauri/crates/pipette-notification/tests/fixtures/notification.json'), 'utf8'),
  ) as { requests: { now: number; request: { body: string } }[] }
  const [first] = golden.requests
  return first.request.body.replace(`"value":${first.now}`, `"value":${now}`)
}

/** The autostart entry in the session's own autostart directory, null
 *  while there is none. */
function autostartEntry(): string | null {
  const path = userDataPath('autostart', 'pipette.desktop')
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** The autostart entry of the recorded golden of the autostart, for the
 *  executable `exec`. */
function goldenAutostartEntry(exec: string): string {
  const golden = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src-tauri/crates/pipette-autostart/tests/fixtures/autostart.json'), 'utf8'),
  ) as { execPath: string; scenarios: { boot: { autostart: Record<string, string> | 'missing' } }[] }
  const entry = golden.scenarios.map((s) => s.boot.autostart).find((files) => files !== 'missing')?.['pipette.desktop']
  if (entry === undefined) throw new Error('the autostart golden has no entry')
  return entry.replace(`Exec="${golden.execPath}"`, `Exec="${exec}"`)
}

/** Checks the notice requests from index `from` on: each is the golden
 *  body with a `value` taken between `after` and its arrival. Answers how
 *  many there were. */
function checkNoticeRequests(from: number, after: number): number {
  const requests = fakeNotices().requests.slice(from)
  for (const request of requests) {
    expect(request.method).toBe('POST')
    expect(request.contentType).toBe('application/json')
    const value = (request.json as { filters: { value: number }[] }).filters[0].value
    expect(value).toBeGreaterThanOrEqual(after)
    expect(value).toBeLessThanOrEqual(request.receivedAt)
    expect(request.bodyText).toBe(goldenNoticeBody(value))
  }
  return requests.length
}

/** Waits until the app has fetched its notices past index `from`, then
 *  watches for a while that no notice modal comes up. */
async function expectNoModalAfterFetch(from: number): Promise<void> {
  await browser.waitUntil(() => fakeNotices().requests.length > from, { timeoutMsg: 'the app did not fetch its notices' })
  await browser.pause(NO_MODAL_WAIT_MS)
  expect(await $(MODAL).isExisting()).toBe(false)
}

async function modalTitles(): Promise<string[]> {
  return Promise.all(await $$(`${MODAL} span.font-medium`).map((title) => title.getText()))
}

async function tapKeys(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    for (const [row, col] of TYPED_KEYS) {
      // Held across several of the renderer's matrix polls: the virtual
      // keyboard reports the matrix as it is, with no latched presses.
      await virtualDevice.pressKey(row, col)
      await browser.pause(KEY_HOLD_MS)
      await virtualDevice.releaseKey(row, col)
      await browser.pause(KEY_GAP_MS)
    }
  }
}

/** The number a tray row such as `Cnt: 1,234` shows. */
function rowNumber(label: string | undefined): number {
  return Number((label ?? '').replace(/^[^:]*:\s*/, '').replaceAll(',', ''))
}

async function setRec(on: boolean): Promise<void> {
  await clickInPage(tid('typing-record-button'))
  await $(tid('typing-record-modal')).waitForDisplayed()
  await clickInPage(tid('typing-record-toggle'))
  if (on) {
    const consent = $(tid('typing-consent-modal'))
    if (await consent.waitForDisplayed({ timeout: 3_000 }).then(() => true, () => false)) {
      await clickInPage(tid('typing-consent-accept'))
    }
    await unlockIfAsked()
  }
  await browser.waitUntil(async () => (await $(tid('typing-record-toggle')).getAttribute('aria-checked')) === String(on), {
    timeoutMsg: `REC did not turn ${on ? 'on' : 'off'}`,
  })
  await clickInPage(tid('typing-record-close'))
  await waitForGone(tid('typing-record-modal'), 'the record modal did not close')
}

/** Waits for the tray's count to reach `least` and settle, and answers
 *  the count. */
async function settledTrayCount(least: number, timeoutMsg: string): Promise<number> {
  const state = await readUntilSettled(
    trayState,
    (tray) => rowNumber(trayRows(tray).count) >= least,
    timeoutMsg,
    TRAY_COUNT_SETTLED_MS,
  )
  return rowNumber(trayRows(state).count)
}

/** The pid of the session's app, or null while there is not exactly one. */
function appPidOrNull(): number | null {
  try {
    return sessionAppPid()
  } catch {
    return null
  }
}

/** Quits the app and starts it again in a new WebDriver session. Until the
 *  new launch has fetched its notices (its renderer runs), the X server is
 *  asked how many windows of the new app are on screen; answers the most
 *  seen at once. */
async function relaunchWatchingWindows(): Promise<number> {
  await quitApp(QUIT_TIMEOUT_MS)
  const from = fakeNotices().requests.length
  const reload = browser.reloadSession()
  // Awaited after the loop; marked handled so that a rejection while the
  // loop runs is not reported as unhandled.
  reload.catch(() => undefined)
  let most = 0
  const deadline = Date.now() + HIDDEN_LAUNCH_TIMEOUT_MS
  for (;;) {
    const fetched = fakeNotices().requests.length > from
    const pid = appPidOrNull()
    if (pid !== null) most = Math.max(most, await viewableWindowCount(pid))
    if (fetched && pid !== null) break
    if (Date.now() > deadline) throw new Error('the relaunched app did not fetch its notices')
    await new Promise((r) => setTimeout(r, 100))
  }
  await reload
  return most
}

async function disconnectKeyboard(): Promise<void> {
  await clickInPage(tid('disconnect-button'))
  await $(tid('settings-button')).waitForDisplayed()
}

/** Turns the tray off and on again through the config, waiting for each. */
async function cycleTray(): Promise<void> {
  await invokeCommand('app_config_set', { key: 'trayResident', value: 'false' })
  await waitForTray((state) => !state.active, 'the tray icon stayed after trayResident turned off')
  await invokeCommand('app_config_set', { key: 'trayResident', value: 'true' })
  await waitForTray((state) => state.active, 'the tray icon did not come back after trayResident turned on')
}

const sameSize = (a: WindowSize | null, b: WindowSize | null): boolean =>
  a !== null && b !== null && a.width === b.width && a.height === b.height
const MIN_COMPACT = { width: 300, height: 100 }

/** Whether the window is compact with the aspect ratio the renderer asks
 *  for once compact, which the window has once the animation has ended. */
const settledCompact = (state: WindowState): boolean => state.compact && state.hints.mask.includes('ASPECT')

describe('Tauri build resident behaviour', function () {
  this.timeout(180_000)

  /** The first failed test: every later test builds on the state the
   *  earlier ones left, so they are not run after it. */
  let firstFailure: string | null = null

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
    console.error(`notice requests: ${fakeNotices().requests.map((r) => `${r.method} ${r.path} ${r.bodyText}`).join(', ')}`)
  })

  it('shows the startup notices newest first and marks them seen when closed', async () => {
    const { older, newer } = startupNotices()
    await $(MODAL).waitForDisplayed({ timeout: 30_000 })
    expect(await modalTitles()).toEqual([newer.title, older.title])
    expect(checkNoticeRequests(0, firstLaunchAt())).toBe(1)

    await clickInPage(tid('notification-modal-close'))
    await waitForGone(MODAL, 'the notice modal did not close')
    await browser.waitUntil(() => readAppConfig().lastNotificationSeen === newer.publishedAt, {
      timeoutMsg: 'lastNotificationSeen was not saved',
    })
  })

  it('shows no seen notice after a restart, and the three newest in the Settings modal', async () => {
    const { older, newer } = startupNotices()
    const threeDaysBack = notice({ title: 'E2E third notice', publishedAt: firestoreTimestamp(Date.now() - 3 * DAY_MS) })
    const fourDaysBack = notice({ title: 'E2E fourth notice', publishedAt: new Date(Date.now() - 4 * DAY_MS).toISOString() })
    fakeNotices().setNotifications([fourDaysBack, older, threeDaysBack, newer])
    const from = fakeNotices().requests.length
    const before = Date.now()
    await restartApp()
    await waitForPage()
    await expectNoModalAfterFetch(from)

    await openSettings('notification')
    const items = `${tid('notification-tab-content')} li`
    await browser.waitUntil(async () => (await $$(items).length) === 3, {
      timeoutMsg: 'the Notification tab did not list three notices',
    })
    const titles = await Promise.all(await $$(`${items} span.font-medium`).map((title) => title.getText()))
    expect(titles).toEqual([newer.title, older.title, threeDaysBack.title])
    await closeSettings()
    expect(checkNoticeRequests(from, before)).toBe(2)
  })

  it('shows no notice when the notice server answers 500', async () => {
    const { older, newer } = startupNotices()
    const unseen = notice({ title: 'E2E unseen notice', publishedAt: new Date(Date.now() - 1_000).toISOString() })
    fakeNotices().setNotifications([older, newer, unseen])
    fakeNotices().inject({ kind: 'status', count: 1, status: 500 })
    const from = fakeNotices().requests.length
    const before = Date.now()
    try {
      await restartApp()
      await waitForPage()
      await expectNoModalAfterFetch(from)
      expect(checkNoticeRequests(from, before)).toBe(1)
    } finally {
      // Every later launch finds only seen notices.
      fakeNotices().setNotifications([older, newer])
    }
    expect(readAppConfig().lastNotificationSeen).toBe(newer.publishedAt)
  })

  it("shows the keyboard's name and REC's count in the tray menu, and drops them on disconnect", async () => {
    await openSettings('tools')
    await setSettingsToggle('settings-tray-resident-toggle', true)
    await closeSettings()
    const idle = await waitForTray((state) => state.active, 'the tray icon did not come up')
    expect(trayRows(idle)).toEqual({ show: 'Show', quit: 'Quit' })
    expect(idle.items.map((item) => item.kind)).toEqual(['normal', 'separator', 'normal'])
    expect(idle.items.every((item) => item.kind === 'separator' || item.enabled)).toBe(true)

    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
    await waitForTray((state) => trayRows(state).keyboard === VIRTUAL_DEVICE_NAME, 'the tray did not show the keyboard')

    const { uid } = await vialApi<{ uid: string }>('getKeyboardId')
    // The flush resolves once the open minute is written to the day file
    // and the cache the list reads.
    await vialApi('typingAnalyticsFlush', uid)
    const recordedBefore = totalKeystrokes(await localDays(uid))

    await virtualDevice.setUnlockCounterMax(3)
    await setRec(true)
    const recording = await waitForTray((state) => trayRows(state).recording === 'Recording', 'the tray did not show REC')
    expect(Object.keys(trayRows(recording))).toEqual(['show', 'keyboard', 'recording', 'count', 'kpm', 'quit'])
    expect(recording.items.filter((item) => ['keyboard', 'recording', 'count', 'kpm'].includes(item.id)).every((item) => !item.enabled)).toBe(true)

    await tapKeys(2)
    await waitForTray(
      (state) => rowNumber(trayRows(state).count) > 0 && rowNumber(trayRows(state).kpm) > 0,
      'the tray count did not move',
    )
    await tapKeys(2)
    const beforeDisconnect = await settledTrayCount(4 * TYPED_KEYS.length, 'the tray count did not go on counting')

    // REC stays on across the disconnect: the tray drops its REC rows while
    // no keyboard is connected, and counts from zero again on the reconnect.
    await disconnectKeyboard()
    await waitForTray(
      (state) => Object.keys(trayRows(state)).join() === 'show,quit' && state.tooltip === 'Pipette',
      'the REC rows stayed after disconnecting with REC on',
    )
    await connectVirtualKeyboard()
    // Read while the keyboard is still locked, so no key has been counted.
    const reconnected = await waitForTray(
      (state) => trayRows(state).recording === 'Recording',
      'the tray did not show REC again after reconnecting',
    )
    expect(Object.keys(trayRows(reconnected))).toEqual(['show', 'keyboard', 'recording', 'count', 'kpm', 'quit'])
    expect([rowNumber(trayRows(reconnected).count), rowNumber(trayRows(reconnected).kpm)]).toEqual([0, 0])
    await unlockIfAsked()
    await waitForUncovered(EDITOR_SELECTOR)

    await tapKeys(4)
    const afterReconnect = await settledTrayCount(4 * TYPED_KEYS.length, 'the tray count did not count after reconnecting')
    // The unlock combo's own presses count once the keyboard unlocks.
    expect(afterReconnect).toBeLessThanOrEqual(4 * TYPED_KEYS.length + UNLOCK_KEYS.length)
    // The analytics keep every key of both connections.
    await vialApi('typingAnalyticsFlush', uid)
    await readUntil(
      async () => totalKeystrokes(await localDays(uid)),
      (total) => total === recordedBefore + beforeDisconnect + afterReconnect,
      'the analytics did not record the keys of both connections',
    )

    await setRec(false)
    await waitForTray(
      (state) => Object.keys(trayRows(state)).join() === 'show,keyboard,quit',
      'the REC rows stayed after REC turned off',
    )
    await disconnectKeyboard()
    await waitForTray(
      (state) => Object.keys(trayRows(state)).join() === 'show,quit' && state.items.length === 3,
      'the keyboard row stayed after disconnecting',
    )
  })

  it('hides the window into the tray on close and shows it from the tray', async () => {
    await assertTrayActive()
    await recordVisibility()
    await requestWindowClose(sessionAppPid())
    await waitForVisible(false, 'the close did not hide the window')
    await invokeCommand('dev_tray_activate', { id: 'show' })
    await waitForVisible(true, 'Show did not show the window')
    await waitForVisibilityEvents([false, true], 'the close and Show did not send one event each')

    // The menu listener is the app's, added once: after the tray icon is
    // taken down and put up again, a click on Show runs it once.
    await cycleTray()
    await recordVisibility()
    await requestWindowClose(sessionAppPid())
    await waitForVisible(false, 'the close did not hide the window after the tray came back')
    await clickTrayMenu('show')
    await waitForVisible(true, "the tray menu's Show did not show the window")
    await waitForVisibilityEvents([false, true], "the close and the tray menu's Show did not send one event each")
  })

  it('starts hidden in the tray with startInTray on, and shows from the tray', async () => {
    await assertTrayActive()
    await openSettings('tools')
    await setSettingsToggle('settings-start-in-tray-toggle', true)
    await closeSettings()
    await browser.waitUntil(() => readAppConfig().startInTray === true, { timeoutMsg: 'startInTray was not saved' })

    try {
      // WebDriver's new session may bring the window forward itself, so the
      // hidden start is seen on the X server before the session is up.
      expect(await relaunchWatchingWindows()).toBe(0)
      await waitForPage()
      expect(await vialApi<boolean>('windowStartedHidden')).toBe(true)
      const visibleOnAttach = await isWindowVisible()
      console.log(`the window started hidden is ${visibleOnAttach ? 'visible' : 'hidden'} once the session is up`)
      await assertTrayActive()
      await recordVisibility()
      if (visibleOnAttach) {
        await requestWindowClose(sessionAppPid())
        await waitForVisible(false, 'the close did not hide the window started hidden')
      }
      await clickTrayMenu('show')
      await waitForVisible(true, "the tray menu's Show did not show the window started hidden")
      await waitForVisibilityEvents(visibleOnAttach ? [false, true] : [true], "the tray menu's Show did not send one event")
    } finally {
      await invokeCommand('app_config_set', { key: 'startInTray', value: 'false' })
    }
  })

  it('writes the autostart entry when Settings turns it on, removes it when off, and writes it at launch', async () => {
    const dir = userDataPath('autostart')
    const expected = goldenAutostartEntry(process.env.APPIMAGE ?? realpathSync(APP_BINARY))
    expect(autostartEntry()).toBeNull()

    await openSettings('tools')
    await setSettingsToggle('settings-auto-launch-toggle', true)
    await readUntil(async () => autostartEntry(), (text) => text === expected, 'the autostart entry is not the golden')
    await setSettingsToggle('settings-auto-launch-toggle', false)
    await readUntil(async () => autostartEntry(), (text) => text === null, 'the autostart entry was not removed')
    await setSettingsToggle('settings-auto-launch-toggle', true)
    await readUntil(async () => autostartEntry(), (text) => text === expected, 'the autostart entry was not written again')
    await closeSettings()

    try {
      await restartApp(() => rmSync(join(dir, 'pipette.desktop')))
      await waitForPage()
      await readUntil(async () => autostartEntry(), (text) => text === expected, 'the launch did not write the autostart entry')
      expect(readdirSync(dir)).toEqual(['pipette.desktop'])
    } finally {
      await invokeCommand('app_config_set', { key: 'autoLaunch', value: 'false' })
    }
    await readUntil(async () => autostartEntry(), (text) => text === null, 'the autostart entry stayed after autoLaunch turned off')
  })

  it('turns the autostart entry, the tray icon and the zoom back to the defaults on Reset Local Data › App Settings', async () => {
    await openSettings('tools')
    await setSettingsToggle('settings-auto-launch-toggle', true)
    await readUntil(async () => autostartEntry(), (text) => text !== null, 'the autostart entry was not written')
    // Set in the Settings modal, as the renderer then holds the zoom it
    // applies and reads the cleared one after the reset.
    await fillInput(tid('settings-zoom-factor-input'), String(ZOOM_PERCENT))
    await closeSettings()
    await invokeCommand('app_config_set', { key: 'trayResident', value: 'true' })
    await waitForTray((state) => state.active, 'the tray icon did not show')
    await browser.waitUntil(async () => Math.abs((await pageZoom()) - ZOOM_PERCENT / 100) < 0.01, {
      timeoutMsg: 'the zoom was not applied',
    })
    const debugMode = readAppConfig().debugMode

    try {
      await resetAppSettings()
      await closeDataModal()
      await readUntil(async () => autostartEntry(), (text) => text === null, 'the reset left the autostart entry')
      await waitForTray((state) => !state.active, 'the reset left the tray icon')
      await browser.waitUntil(async () => Math.abs((await pageZoom()) - 1) < 0.01, {
        timeoutMsg: 'the reset left the zoom',
      })
      const config = readAppConfig()
      expect([config.autoLaunch, config.trayResident, config.zoomFactor]).toEqual([false, false, 100])
      await openSettings('tools')
      expect(await $(tid('settings-auto-launch-toggle')).getAttribute('aria-checked')).toBe('false')
      await closeSettings()
    } finally {
      await invokeCommand('app_config_set', { key: 'autoLaunch', value: 'false' })
      await invokeCommand('app_config_set', { key: 'zoomFactor', value: '100' })
      // The reset turned the session's log files off; the later tests read the log.
      if (debugMode === true) await invokeCommand('app_config_set', { key: 'debugMode', value: 'true' })
    }
  })

  it("keeps the compact window's minimum size and aspect ratio across a move, and restores the window on leaving", async () => {
    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
    const normal = await windowState()
    expect(normal.compact).toBe(false)
    expect(normal.hints.mask).not.toContain('ASPECT')

    await virtualDevice.setUnlockCounterMax(3)
    await waitForUncovered(tid('view-only-button'))
    await clickInPage(tid('view-only-button'))
    await unlockIfAsked()
    const compact = await waitForSettledWindow(settledCompact, 'the Typing View did not settle in compact mode')
    expect(compact.normalSize).toEqual(normal.size)
    expect(compact.minSize).toEqual(MIN_COMPACT)
    expect(compact.hints.mask).toEqual(['MIN_SIZE', 'BASE_SIZE', 'ASPECT'])
    expect(compact.hints.minSize).toEqual(MIN_COMPACT)
    expect(compact.aspectRatio).toBeGreaterThan(0)
    expect(compact.hints.aspect).toBeCloseTo(compact.aspectRatio ?? 0, 3)
    expect(compact.size.width).toBeGreaterThanOrEqual(MIN_COMPACT.width)
    expect(compact.size.height).toBeGreaterThanOrEqual(MIN_COMPACT.height)
    expect(compact.size.width).toBeLessThan(normal.size.width)

    // A move makes the app look at the window's minimum size again, which
    // must not drop the aspect ratio of the same geometry hints.
    if (positionsKnown) {
      const rect = await browser.getWindowRect()
      const target = { x: rect.x + 40, y: rect.y + 30 }
      await browser.setWindowRect(target.x, target.y, null, null)
      await browser.waitUntil(async () => {
        const moved = await browser.getWindowRect()
        return moved.x === target.x && moved.y === target.y
      }, { timeoutMsg: 'the window did not move' })
      const until = Date.now() + MOVE_SAMPLE_MS
      while (Date.now() < until) {
        const state = await windowState()
        expect(state.hints.mask).toEqual(['MIN_SIZE', 'BASE_SIZE', 'ASPECT'])
        expect(state.hints.minSize).toEqual(MIN_COMPACT)
        expect(state.hints.aspect).toBeCloseTo(compact.aspectRatio ?? 0, 3)
        await browser.pause(100)
      }
    }

    // xvfb is X11, where always on top is offered.
    expect(await vialApi<boolean>('isAlwaysOnTopSupported')).toBe(!process.env.WAYLAND_DISPLAY)
    // The controls open on a click on the keyboard; the element on top at
    // its centre takes it, as a click of the user would land there.
    await browser.execute((sel: string) => {
      const box = (document.querySelector(sel) as HTMLElement).getBoundingClientRect()
      ;(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) as HTMLElement).click()
    }, EDITOR_SELECTOR)
    await browser.waitUntil(
      () => browser.execute(() => {
        const panel = document.getElementById('view-only-panel')
        return panel !== null && !panel.hasAttribute('inert') && panel.getAnimations().length === 0
      }),
      { timeoutMsg: 'the view-only controls did not open' },
    )
    await clickInPage(tid('always-on-top-toggle'))
    await waitForWindow((state) => state.alwaysOnTop, 'always on top was not applied')
    await clickInPage(tid('always-on-top-toggle'))
    await waitForWindow((state) => !state.alwaysOnTop, 'always on top was not taken off')

    await clickInPage(tid('view-only-toggle'))
    const left = await waitForSettledWindow(
      (state) => !state.compact && state.aspectRatio === null && sameSize(state.size, normal.size),
      'leaving the Typing View did not restore the window',
    )
    expect(left.minSize).toEqual(normal.minSize)
    expect(left.hints).toEqual(normal.hints)
    expect(left.normalSize).toBeNull()
    expect(left.alwaysOnTop).toBe(false)
    await $(EDITOR_SELECTOR).waitForDisplayed()
    await disconnectKeyboard()
  })

  it('quits from the tray menu through the quit sequence, after the tray icon came back', async () => {
    await cycleTray()
    const logBefore = readAppLog().length
    const pid = sessionAppPid()
    await clickTrayMenu('quit')
    await waitForAppExit(pid, QUIT_TIMEOUT_MS, "of the tray menu's Quit")

    const log = readAppLog().slice(logBefore)
    expect(countIn(log, '; starting the quit sequence')).toBe(1)
    expect(countIn(log, '[quit] sequence ended: Completed')).toBe(1)
    expect(countIn(log, 'while quitting during')).toBe(0)
    expect(countIn(log, '[quit] exiting (code')).toBe(1)
    expect(countIn(log, '[quit] exiting (code Some(0))')).toBe(1)
    expect(existsSync(userDataPath('quit-pending.json'))).toBe(false)

    // The session goes on with a new launch, which the session's end then
    // quits as usual.
    await browser.reloadSession()
    await waitForPage()
    expect(await isWindowVisible()).toBe(true)
  })
})
