// SPDX-License-Identifier: GPL-2.0-or-later
//
// The tray, the window and the app's log as the resident spec sees them:
// the dev-tools commands of the tray (src-tauri/src/dev_commands/tray.rs)
// and of the window (src-tauri/src/dev_commands/window_ops.rs), the
// window's visibility events recorded in the page, and the Settings modal
// of the device list.

import { existsSync, readFileSync } from 'node:fs'
import { $, browser } from '@wdio/globals'
import { clickInPage, invokeCommand, tid, vialApi, waitForGone } from './app'
import { appLogPath } from './driver'

export interface TrayItem {
  id: string
  label: string
  enabled: boolean
  kind: 'normal' | 'separator'
}

export interface TrayState {
  active: boolean
  tooltip: string | null
  items: TrayItem[]
}

export const trayState = (): Promise<TrayState> => invokeCommand<TrayState>('dev_tray_state')

/** The labels of the tray menu's items with an id the app gave them (the
 *  separators' ids are numbers of the menu library). */
export function trayRows(state: TrayState): Record<string, string> {
  return Object.fromEntries(state.items.filter((item) => item.kind === 'normal').map((item) => [item.id, item.label]))
}

/** Reads `read` until its answer satisfies `done` (within WebdriverIO's
 *  waitforTimeout), and answers that one. On a timeout the error tells the
 *  last answer. */
export async function readUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMsg: string): Promise<T> {
  const seen: { last?: { value: T } } = {}
  try {
    await browser.waitUntil(async () => {
      const value = await read()
      seen.last = { value }
      return done(value)
    })
  } catch (err) {
    throw new Error(`${timeoutMsg}; last seen: ${JSON.stringify(seen.last?.value)} (${String(err)})`)
  }
  if (!seen.last) throw new Error(timeoutMsg)
  return seen.last.value
}

/** Waits until the tray state satisfies `done`, and answers that state. */
export const waitForTray = (done: (state: TrayState) => boolean, timeoutMsg: string): Promise<TrayState> =>
  readUntil(trayState, done, timeoutMsg)

/** Throws unless the tray icon exists: the tray tests would otherwise pass
 *  on a window that does not hide because there is no tray. */
export async function assertTrayActive(): Promise<void> {
  const state = await trayState()
  if (!state.active) {
    throw new Error('the tray icon does not exist (libayatana-appindicator3 is needed); the tray tests stop here')
  }
}

/** Clicks the tray menu item labelled `label` through GTK, so the click
 *  reaches the app's menu listeners as a click in the desktop's tray does. */
export const clickTrayMenu = (label: string): Promise<void> => invokeCommand('dev_tray_menu_click', { label })

export const isWindowVisible = (): Promise<boolean> => vialApi<boolean>('windowIsVisible')

/** Starts recording the window's visibility events in the page, unless it
 *  already does, and empties the record. */
export async function recordVisibility(): Promise<void> {
  await browser.execute(() => {
    const page = window as unknown as {
      __e2eVisibility?: boolean[]
      vialAPI: { onWindowVisibilityChanged: (callback: (visible: boolean) => void) => () => void }
    }
    if (page.__e2eVisibility) {
      page.__e2eVisibility.length = 0
      return
    }
    const events: boolean[] = []
    page.__e2eVisibility = events
    page.vialAPI.onWindowVisibilityChanged((visible) => events.push(visible))
  })
}

/** The visibility events since {@link recordVisibility}. */
export function visibilityEvents(): Promise<boolean[]> {
  return browser.execute(() => [...((window as unknown as { __e2eVisibility?: boolean[] }).__e2eVisibility ?? [])])
}

export async function waitForVisible(visible: boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await isWindowVisible()) === visible, { timeoutMsg })
}

/** Waits until the page answers after a launch: a new WebDriver session can
 *  be up before the page has loaded the vialAPI. */
export async function waitForPage(): Promise<void> {
  await browser.waitUntil(
    () => browser.execute(() => typeof (window as unknown as { vialAPI?: unknown }).vialAPI === 'object').catch(() => false),
    { timeoutMsg: 'the page did not load' },
  )
}

export interface WindowSize {
  width: number
  height: number
}

export interface WindowState {
  size: WindowSize
  minSize: WindowSize | null
  aspectRatio: number | null
  hints: { mask: string[]; minSize: WindowSize | null; aspect: number | null }
  alwaysOnTop: boolean
  compact: boolean
  normalSize: WindowSize | null
}

export const windowState = (): Promise<WindowState> => invokeCommand<WindowState>('dev_window_state')

/** Waits until the window state satisfies `done`, and answers that state. */
export const waitForWindow = (done: (state: WindowState) => boolean, timeoutMsg: string): Promise<WindowState> =>
  readUntil(windowState, done, timeoutMsg)

/** How long the window state must stay the same to count as settled. */
const SETTLED_MS = 600

/** Waits until the window state satisfies `done` and has not changed for
 *  {@link SETTLED_MS}, and answers it. A mode change of the renderer can
 *  take several calls, each with its own animation, and a state between
 *  two of them can satisfy `done` for a moment. */
export function waitForSettledWindow(done: (state: WindowState) => boolean, timeoutMsg: string): Promise<WindowState> {
  let previous = ''
  let since = 0
  return readUntil(
    windowState,
    (state) => {
      const text = JSON.stringify(state)
      if (text !== previous) {
        previous = text
        since = Date.now()
      }
      return done(state) && Date.now() - since >= SETTLED_MS
    },
    timeoutMsg,
  )
}

/** The app's log, empty before its first line. */
export function readAppLog(): string {
  const path = appLogPath()
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** How many times `text` is in `log`. */
export function countIn(log: string, text: string): number {
  return log.split(text).length - 1
}

/** Opens the Settings modal from the device list on the tab `tab`. */
export async function openSettings(tab: 'tools' | 'notification'): Promise<void> {
  await clickInPage(tid('settings-button'))
  await $(tid('settings-modal')).waitForDisplayed()
  await clickInPage(tid(`settings-tab-${tab}`))
  await browser.waitUntil(async () => (await $(tid(`settings-tab-${tab}`)).getAttribute('aria-selected')) === 'true', {
    timeoutMsg: `the ${tab} tab of the Settings modal was not selected`,
  })
}

export async function closeSettings(): Promise<void> {
  await clickInPage(tid('settings-close'))
  await waitForGone(tid('settings-modal'), 'the Settings modal did not close')
}

/** Clicks the switch `toggle` of the Settings modal and waits until it
 *  shows `on`. */
export async function setSettingsToggle(toggle: string, on: boolean): Promise<void> {
  const element = $(tid(toggle))
  await element.waitForDisplayed()
  if ((await element.getAttribute('aria-checked')) === String(on)) return
  await clickInPage(tid(toggle))
  await browser.waitUntil(async () => (await element.getAttribute('aria-checked')) === String(on), {
    timeoutMsg: `${toggle} did not turn ${on ? 'on' : 'off'}`,
  })
}
