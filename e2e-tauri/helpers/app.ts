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
const CONNECT_TIMEOUT_MS = 20_000
// Longer than the deadline of the app's own quit sequence (30 s).
const QUIT_TIMEOUT_MS = 40_000

type ChainablePromiseElement = ReturnType<typeof $>

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

export const virtualDevice = {
  setUnlockCounterMax: (n: number) => invokeCommand('virtual_device_set_unlock_counter_max', { n }),
  holdKeys: (pairs: [number, number][]) => invokeCommand('virtual_device_hold_keys', { pairs }),
  pressKey: (row: number, col: number) => invokeCommand('virtual_device_press_key', { row, col }),
  releaseKey: (row: number, col: number) => invokeCommand('virtual_device_release_key', { row, col }),
  releaseAll: () => invokeCommand('virtual_device_release_all'),
  getState: () => invokeCommand<VirtualDeviceControllerState>('virtual_device_get_state'),
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

export async function closeKeyPopover(): Promise<void> {
  // A keycode applied from the popover re-renders it, which can replace the
  // close button while it is being found or clicked; each try finds it
  // afresh.
  await browser.waitUntil(
    async () => {
      try {
        await $('[data-testid="popover-close"]').click()
        return true
      } catch (err) {
        if (isStaleElement(err)) return false
        throw err
      }
    },
    { timeoutMsg: 'the close button of the key popover could not be clicked' },
  )
  await $('[data-testid="key-popover"]').waitForDisplayed({ reverse: true })
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

/** Opens the `tab` tab of the keycodes overlay (`tools`, or `data` for the
 *  Import / Save tab) and waits until the overlay has stopped sliding. With
 *  one tab the panel draws no tab bar, and that tab is already showing. */
export async function openOverlayTab(tab: 'tools' | 'data'): Promise<void> {
  const toggle = $('button[aria-controls="keycodes-overlay-panel"]')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
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
export async function clickIntoFileDialog(selector: string, path: string): Promise<void> {
  const queued = () => invokeCommand<number>('dev_dialog_queued')
  if ((await queued()) !== 0) throw new Error('a file dialog answer from an earlier step is still queued')
  await invokeCommand('dev_dialog_respond', { path })
  await $(selector).click()
  await browser.waitUntil(async () => (await queued()) === 0, {
    timeoutMsg: `clicking ${selector} opened no file dialog`,
  })
}

/** Quits the app and starts it again in a new WebDriver session, with the
 *  same userData directory. Linux only, as {@link quitApp}. */
export async function restartApp(): Promise<void> {
  await quitApp(QUIT_TIMEOUT_MS)
  await browser.reloadSession()
}
