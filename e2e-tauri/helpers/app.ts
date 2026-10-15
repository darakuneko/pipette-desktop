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
        if (err instanceof Error && /stale element/i.test(err.message)) return false
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
  await $('[data-testid="popover-close"]').click()
  await $('[data-testid="key-popover"]').waitForDisplayed({ reverse: true })
}

/** Opens the Tools tab of the keycodes overlay. With Tools as its only tab
 *  the panel draws no tab bar, and Tools is already showing. */
export async function openToolsOverlay(): Promise<void> {
  const toggle = $('button[aria-controls="keycodes-overlay-panel"]')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await $('[data-testid="keycodes-overlay-panel"]').waitForDisplayed()
  const tab = $('[data-testid="overlay-tab-tools"]')
  if ((await tab.isExisting()) && (await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

/** Quits the app and starts it again in a new WebDriver session, with the
 *  same userData directory. Linux only, as {@link quitApp}. */
export async function restartApp(): Promise<void> {
  await quitApp(QUIT_TIMEOUT_MS)
  await browser.reloadSession()
}
