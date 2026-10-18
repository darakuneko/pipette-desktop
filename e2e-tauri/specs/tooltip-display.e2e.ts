// SPDX-License-Identifier: GPL-2.0-or-later
//
// Tooltips in the keymap editor on the virtual keyboard: the layer panel's
// collapse / expand button names its tooltip with aria-describedby, and the
// tooltip fades in (opacity 1) on hover and on keyboard focus; the undo
// button names a role="tooltip" element the same way. The tests share one
// session and run in order.

import { $, browser } from '@wdio/globals'
import { connectVirtualKeyboard, EDITOR_SELECTOR, waitForUncovered } from '../helpers/app'

const LAYER_PANEL_TOGGLE = '[data-testid="layer-panel-collapse-btn"], [data-testid="layer-panel-expand-btn"]'
const UNDO_BUTTON = '[data-testid="undo-button"]'
/** Longer than the tooltip's open delay and fade. */
const FADE_TIMEOUT_MS = 5_000

/** The id of the tooltip `selector` names with aria-describedby. React's
 *  ids are not valid CSS ids, so the tooltip is found by id in the page. */
async function describedBy(selector: string): Promise<string> {
  const button = $(selector)
  await button.waitForDisplayed()
  const id = await button.getAttribute('aria-describedby')
  if (!id) throw new Error(`${selector} names no tooltip`)
  return id
}

/** The tooltip's role and computed opacity, null when there is no element
 *  of that id. */
function tooltipState(id: string): Promise<{ role: string | null; opacity: number } | null> {
  return browser.execute((tooltipId: string) => {
    const el = document.getElementById(tooltipId)
    return el ? { role: el.getAttribute('role'), opacity: parseFloat(getComputedStyle(el).opacity) } : null
  }, id)
}

/** Waits until the element `id` exists with role="tooltip": the tooltip is
 *  portalled into the page by an effect after the button first renders. */
async function waitForTooltipRole(id: string): Promise<void> {
  await browser.waitUntil(async () => (await tooltipState(id))?.role === 'tooltip', {
    timeoutMsg: `no role="tooltip" element has the id ${id}`,
  })
}

async function waitForOpacity(id: string, opacity: number, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await tooltipState(id))?.opacity === opacity, {
    timeout: FADE_TIMEOUT_MS,
    timeoutMsg,
  })
}

describe('Tauri build tooltips', () => {
  before(async () => {
    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
  })

  it("shows the layer panel toggle's tooltip on hover", async () => {
    const id = await describedBy(LAYER_PANEL_TOGGLE)
    await waitForTooltipRole(id)
    await $(LAYER_PANEL_TOGGLE).moveTo()
    await waitForOpacity(id, 1, 'the tooltip did not fade in on hover')
  })

  it("shows the layer panel toggle's tooltip on focus", async () => {
    const id = await describedBy(LAYER_PANEL_TOGGLE)
    // Leaves the button so the hover of the previous test closes it.
    await $(EDITOR_SELECTOR).moveTo()
    await waitForOpacity(id, 0, 'the tooltip did not close when the pointer left')

    await browser.execute((sel: string) => (document.querySelector(sel) as HTMLElement).focus(), LAYER_PANEL_TOGGLE)
    try {
      await waitForOpacity(id, 1, 'the tooltip did not fade in on focus')
    } finally {
      await browser.execute((sel: string) => (document.querySelector(sel) as HTMLElement).blur(), LAYER_PANEL_TOGGLE)
    }
  })

  it('names a role="tooltip" element from the undo button', async () => {
    const id = await describedBy(UNDO_BUTTON)
    await waitForTooltipRole(id)
  })
})
