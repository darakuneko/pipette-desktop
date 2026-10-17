// SPDX-License-Identifier: GPL-2.0-or-later
//
// Driving the Tauri build's window: the dev-tools commands of the backend
// (src-tauri/src/dev_commands/tools.rs) and the UI steps the specs share.

import { $, $$, browser } from '@wdio/globals'
import type { VirtualDeviceControllerState } from '../../src/tauri-shim/generated/VirtualDeviceControllerState'
import { quitApp } from './driver'

export const VIRTUAL_DEVICE_NAME = 'Virtual Keyboard'
export const EDITOR_SELECTOR = '[data-testid="editor-content"]'
export const UNLOCK_DIALOG_HEADING = 'h2=Unlock Keyboard'
/** The unlock combo of the virtual keyboard's definition. */
export const UNLOCK_KEYS: [number, number][] = [[0, 0], [0, 1]]
const UNLOCK_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 20_000
// Longer than the deadline of the app's own quit sequence (30 s).
const QUIT_TIMEOUT_MS = 40_000

type ChainablePromiseElement = ReturnType<typeof $>

export const tid = (id: string): string => `[data-testid="${id}"]`

/** Clicks `selector` from the page: a tooltip of the previous control can
 *  still cover it, which a WebDriver click reports as intercepted. */
export async function clickInPage(selector: string): Promise<void> {
  await $(selector).waitForExist()
  await browser.execute((sel: string) => {
    ;(document.querySelector(sel) as HTMLElement).click()
  }, selector)
}

/** Calls a backend command from the page through the IPC entry Tauri
 *  injects into every window (`window.__TAURI_INTERNALS__`, present with
 *  `withGlobalTauri: false` too), the same entry `@tauri-apps/api` uses. The
 *  dev-tools commands are granted to the main window only in builds with the
 *  dev-tools feature (src-tauri/capabilities/dev/). */
export async function invokeCommand<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return browser.execute(
    (cmd: string, cmdArgs: Record<string, unknown>) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      return internals.invoke(cmd, cmdArgs)
    },
    command,
    args,
  ) as Promise<T>
}

/** Calls the vialAPI member `member` of the page with `args`. The answer
 *  crosses as JSON text: WebDriver takes an answer with an `error` field
 *  for an error of its own. */
export async function vialApi<T>(member: string, ...args: unknown[]): Promise<T> {
  const text = await browser.execute(
    async (name: string, memberArgs: unknown[]) => {
      const api = (window as unknown as { vialAPI: Record<string, (...a: unknown[]) => Promise<unknown>> }).vialAPI
      return JSON.stringify(await api[name](...memberArgs))
    },
    member,
    args,
  )
  return JSON.parse(text) as T
}

/** Starts recording the page's errors (console.error calls, uncaught
 *  errors and unhandled rejections) until the page loads again. */
export async function recordPageErrors(): Promise<void> {
  await browser.execute(() => {
    const page = window as unknown as { __e2eErrors?: string[] }
    if (page.__e2eErrors) return
    const errors: string[] = []
    page.__e2eErrors = errors
    const consoleError = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
      consoleError(...args)
    }
    window.addEventListener('error', (event) => errors.push(`uncaught: ${event.message}`))
    window.addEventListener('unhandledrejection', (event) => errors.push(`unhandled rejection: ${String(event.reason)}`))
  })
}

/** The errors recorded since {@link recordPageErrors} on this page load. */
export async function recordedPageErrors(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __e2eErrors?: string[] }).__e2eErrors ?? [])
}

export const virtualDevice = {
  setUnlockCounterMax: (n: number) => invokeCommand('virtual_device_set_unlock_counter_max', { n }),
  holdKeys: (pairs: [number, number][]) => invokeCommand('virtual_device_hold_keys', { pairs }),
  pressKey: (row: number, col: number) => invokeCommand('virtual_device_press_key', { row, col }),
  releaseKey: (row: number, col: number) => invokeCommand('virtual_device_release_key', { row, col }),
  releaseAll: () => invokeCommand('virtual_device_release_all'),
  getState: () => invokeCommand<VirtualDeviceControllerState>('virtual_device_get_state'),
}

/** Holds the unlock combo while the unlock dialog is up, if it comes up
 *  within a few seconds. */
export async function unlockIfAsked(): Promise<void> {
  const asked = await $(UNLOCK_DIALOG_HEADING)
    .waitForDisplayed({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (!asked) return
  await virtualDevice.holdKeys(UNLOCK_KEYS)
  try {
    await $(UNLOCK_DIALOG_HEADING).waitForDisplayed({ reverse: true, timeout: UNLOCK_TIMEOUT_MS })
  } finally {
    await virtualDevice.releaseAll()
  }
}

/** The device-list button whose name is exactly `name` (a substring match
 *  could pick a device whose name merely contains it). */
async function findDeviceButton(name: string): Promise<WebdriverIO.Element> {
  let found: WebdriverIO.Element | undefined
  await browser.waitUntil(
    async () => {
      for (const button of await $$('[data-testid="device-button"]')) {
        const label = button.$('.font-semibold')
        if ((await label.isExisting()) && (await label.getText()) === name) {
          found = button
          return true
        }
      }
      return false
    },
    { timeout: CONNECT_TIMEOUT_MS, timeoutMsg: `"${name}" did not appear in the device list` },
  )
  if (!found) throw new Error(`"${name}" did not appear in the device list`)
  return found
}

/** Whether `err` is WebKitWebDriver's report of an element that left the
 *  page between being found and being used. */
function isStaleElement(err: unknown): boolean {
  return err instanceof Error && /stale element/i.test(err.message)
}

/** Waits until no element matching `selector` is displayed. Each poll
 *  queries the selector afresh: an element that is removed between being
 *  found and being checked (WebKitWebDriver then reports a stale element)
 *  only ends that poll, and the next query no longer finds it. */
export async function waitForGone(selector: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        for (const element of await $$(selector)) {
          if (await element.isDisplayed()) return false
        }
        return true
      } catch (err) {
        if (isStaleElement(err)) return false
        throw err
      }
    },
    { timeoutMsg },
  )
}

/** Connects the virtual keyboard from the device list and waits for its
 *  keymap editor. */
export async function connectVirtualKeyboard(): Promise<void> {
  const button = await findDeviceButton(VIRTUAL_DEVICE_NAME)
  await button.click()
  await $(EDITOR_SELECTOR).waitForDisplayed({ timeout: CONNECT_TIMEOUT_MS })
}

/** The key at matrix position `row,col` in the keymap editor (the unlock
 *  dialog draws a keyboard of its own). */
export function editorKey(row: number, col: number): ChainablePromiseElement {
  return $(EDITOR_SELECTOR).$(`[data-key-pos="${row},${col}"]`)
}

/** The Code tab's hex input of the key popover: the key's current keycode. */
export const HEX_INPUT_SELECTOR = '[data-testid="popover-hex-input"]'

/** Opens the key popover of `row,col` on its Code tab. */
export async function openKeycodeHexInput(row: number, col: number): Promise<void> {
  const key = editorKey(row, col)
  await key.waitForExist()
  // The keys are SVG groups; a synthetic double click reaches React's
  // handler without depending on where the key sits in the viewport.
  await key.execute((el: Element) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await $('[data-testid="key-popover"]').waitForDisplayed()
  await $('[data-testid="popover-tab-code"]').click()
  await $(HEX_INPUT_SELECTOR).waitForDisplayed()
}

const KEY_POPOVER_SELECTOR = '[data-testid="key-popover"]'

/** Applies the keycode typed in the Code tab and waits until the keymap
 *  editor has written it. When the write finishes, the editor closes the
 *  popover, or with Auto Move moves it on to the next key, so the popover
 *  of the key being written is gone then. Closing it before that races
 *  the move: the next key's popover opens where the close click lands.
 *  Apply is disabled when the key already has the keycode; nothing is
 *  written then. */
export async function applyHexKeycode(): Promise<void> {
  const target = await $(KEY_POPOVER_SELECTOR).getAttribute('data-popover-target-key')
  if (!target) throw new Error('no key popover is open')
  const apply = $('[data-testid="popover-code-apply"]')
  if (!(await apply.isEnabled())) return
  await apply.click()
  await waitForGone(
    `${KEY_POPOVER_SELECTOR}[data-popover-target-key="${target}"]`,
    `the keycode for ${target} was not written`,
  )
}

/** Closes the key popover, whichever key it is on, and waits until none is
 *  displayed. A click that a re-render of the popover swallows (the close
 *  button replaced while it is found or clicked, or the popover moved to
 *  the next key) is tried again on the next poll. */
export async function closeKeyPopover(): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const popover = $(KEY_POPOVER_SELECTOR)
        if (!(await popover.isExisting()) || !(await popover.isDisplayed())) return true
        // Found without waiting: a popover gone by now ends this poll.
        const [close] = await popover.$$('[data-testid="popover-close"]')
        if (close) await close.click()
        return false
      } catch (err) {
        if (isStaleElement(err)) return false
        throw err
      }
    },
    { interval: 300, timeoutMsg: 'the key popover could not be closed' },
  )
}

/** Writes `keycode` (hex) to the key at `row,col` from the key popover. */
export async function setKeycode(row: number, col: number, keycode: string): Promise<void> {
  await openKeycodeHexInput(row, col)
  await $(HEX_INPUT_SELECTOR).setValue(keycode)
  await applyHexKeycode()
  await closeKeyPopover()
}

/** Whether the keycodes overlay is open and has stopped sliding. A click
 *  outside it (on a key, on the key popover) closes it, and it slides in
 *  over 200 ms when opened: a click on one of its controls while it slides
 *  can land beside the control. */
async function overlaySettledOpen(): Promise<boolean> {
  return browser.execute(() => {
    const toggle = document.querySelector('button[aria-controls="keycodes-overlay-panel"]')
    const panel = document.getElementById('keycodes-overlay-panel')
    return toggle?.getAttribute('aria-expanded') === 'true' && panel !== null && panel.getAnimations().length === 0
  })
}

const UNCOVERED_TIMEOUT_MS = 60_000

/** Waits until the element `selector` is the topmost element at its centre:
 *  nothing covers it (the connecting overlay, while the keyboard's data
 *  downloads on connect, covers the whole window), so a click reaches it. */
export async function waitForUncovered(selector: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((sel: string) => {
        const element = document.querySelector(sel)
        if (!element) return false
        const box = element.getBoundingClientRect()
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return top !== null && (top === element || element.contains(top))
      }, selector),
    { timeout: UNCOVERED_TIMEOUT_MS, timeoutMsg: `${selector} stayed covered by another element` },
  )
}

const OVERLAY_TOGGLE_SELECTOR = 'button[aria-controls="keycodes-overlay-panel"]'

/** Opens the `tab` tab of the keycodes overlay (`tools`, or `data` for the
 *  Import / Save tab) and waits until the overlay has stopped sliding. With
 *  one tab the panel draws no tab bar, and that tab is already showing. */
export async function openOverlayTab(tab: 'tools' | 'data'): Promise<void> {
  const toggle = $(OVERLAY_TOGGLE_SELECTOR)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await waitForUncovered(OVERLAY_TOGGLE_SELECTOR)
    await toggle.click()
  }
  await browser.waitUntil(overlaySettledOpen, { timeoutMsg: 'the keycodes overlay did not open' })
  const button = $(`[data-testid="overlay-tab-${tab}"]`)
  if ((await button.isExisting()) && (await button.getAttribute('aria-selected')) !== 'true') {
    await button.click()
    await browser.waitUntil(async () => (await button.getAttribute('aria-selected')) === 'true', {
      timeoutMsg: `the ${tab} tab of the keycodes overlay was not selected`,
    })
  }
}

export const openToolsOverlay = (): Promise<void> => openOverlayTab('tools')

/** Queues `path` as the answer of the next file dialog (`dev_dialog_respond`
 *  of the development tools), clicks `selector`, and waits until a file
 *  dialog has taken the answer, so a click that opened no dialog fails here
 *  rather than as a missing result later. */
export function clickIntoFileDialog(selector: string, path: string): Promise<void> {
  return clickIntoDialog(selector, { path })
}

/** Like {@link clickIntoFileDialog}, for a dialog that picks several files. */
export function clickIntoFilesDialog(selector: string, paths: string[]): Promise<void> {
  return clickIntoDialog(selector, { paths })
}

async function clickIntoDialog(selector: string, answer: { path: string } | { paths: string[] }): Promise<void> {
  const queued = () => invokeCommand<number>('dev_dialog_queued')
  if ((await queued()) !== 0) throw new Error('a file dialog answer from an earlier step is still queued')
  await invokeCommand('dev_dialog_respond', answer)
  await $(selector).click()
  await browser.waitUntil(async () => (await queued()) === 0, {
    timeoutMsg: `clicking ${selector} opened no file dialog`,
  })
}

/** Records `body` (UTF-8 text, or bytes) with `status` as the response of
 *  the next GET of `url` (`dev_http_respond` of the development tools), so
 *  the request never reaches the network. */
export async function respondHttp(url: string, body: string | Uint8Array, status = 200): Promise<void> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  await invokeCommand('dev_http_respond', { url, status, body: [...bytes] })
}

/** How many recorded responses no request has taken yet. */
export function queuedHttpResponses(): Promise<number> {
  return invokeCommand<number>('dev_http_queued')
}

/** Waits until every recorded response has been taken. */
export async function waitForHttpResponsesTaken(timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await queuedHttpResponses()) === 0, { timeoutMsg })
}

/** Quits the app and starts it again in a new WebDriver session, with the
 *  same userData directory. `whileStopped` runs between the two, when no
 *  app process has the userData directory open. Linux only, as
 *  {@link quitApp}. */
export async function restartApp(whileStopped?: () => void | Promise<void>): Promise<void> {
  await quitApp(QUIT_TIMEOUT_MS)
  await whileStopped?.()
  await browser.reloadSession()
}
