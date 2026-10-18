// SPDX-License-Identifier: GPL-2.0-or-later
//
// The key popover's state on the virtual keyboard. Auto Move mounts the
// popover afresh on the key it lands on (`popoverInstanceKey`,
// keymap-editor-popover.tsx), so the wrapper mode comes again from that
// key's own keycode; the popover's layer sidebar keeps the same popover, so
// its active tab stays. The displayed keycode resolves from the target key
// either way, so the tests look at the mode strip and the tab instead. The
// tests share one session and run in order.

import { $, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  closeKeyPopover,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  editorKey,
  HEX_INPUT_SELECTOR,
  setToolsToggle,
  tid,
  waitForGone,
  waitForUncovered,
} from '../helpers/app'

const POPOVER = tid('key-popover')
const MODIFIER_STRIP = tid('modifier-checkbox-strip')
/** WebDriver's code of the Enter key. */
const KEY_ENTER = ''

/** Opens the key popover of the first key, on its default tab. */
async function openPopoverOnFirstKey(): Promise<void> {
  const key = editorKey(0, 0)
  await key.waitForExist()
  // The keys are SVG groups; a synthetic double click reaches React's
  // handler without depending on where the key sits in the viewport.
  await key.execute((el: Element) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await $(POPOVER).waitForDisplayed()
}

/** The attribute `name` of the key popover, read in the page: the popover
 *  is mounted again when Auto Move moves it, which would leave an element
 *  found before stale. Null while no popover is open. */
function popoverAttribute(name: string): Promise<string | null> {
  return browser.execute(
    (sel: string, attr: string) => document.querySelector(sel)?.getAttribute(attr) ?? null,
    POPOVER,
    name,
  )
}

describe('Key popover behaviour', () => {
  before(async () => {
    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
  })

  it("does not carry the previous key's wrapper mode onto the key Auto Move lands on", async () => {
    await setToolsToggle('overlay-auto-advance-toggle', true)
    await openPopoverOnFirstKey()
    const startKey = await popoverAttribute('data-popover-target-key')

    // Switching the mode writes nothing, so the popover stays on the key
    // and shows the modifier strip.
    await clickInPage(tid('popover-mode-mod-mask'))
    await $(MODIFIER_STRIP).waitForDisplayed()

    // A keycode picked and confirmed in Mod-Mask mode is written wrapped,
    // and Auto Move goes on to the next key.
    await clickInPage('[data-testid^="popover-result-"]')
    await browser.keys(KEY_ENTER)
    await browser.waitUntil(async () => {
      const target = await popoverAttribute('data-popover-target-key')
      return target !== null && target !== startKey
    }, { timeoutMsg: 'Auto Move did not move the popover to the next key' })

    // The landed key's keycode is a plain one, so the popover mounted on it
    // shows no modifier strip; a mode kept from the first key would.
    await waitForGone(MODIFIER_STRIP, "the landed key's popover kept the first key's Mod-Mask mode")
    await closeKeyPopover()
  })

  it('keeps the Code tab while the layer sidebar changes the target layer', async () => {
    await openPopoverOnFirstKey()
    const startLayer = await popoverAttribute('data-popover-target-layer')
    expect(startLayer).not.toBe('1')

    await clickInPage(tid('popover-tab-code'))
    await $(HEX_INPUT_SELECTOR).waitForDisplayed()

    await clickInPage(tid('popover-layer-1'))
    await browser.waitUntil(async () => (await popoverAttribute('data-popover-target-layer')) === '1', {
      timeoutMsg: 'the layer sidebar did not move the popover to layer 1',
    })
    await expect($(HEX_INPUT_SELECTOR)).toBeDisplayed()
    await closeKeyPopover()
  })
})
