// SPDX-License-Identifier: GPL-2.0-or-later
//
// The keymap editor's modal editors on the virtual keyboard, which has
// VialRGB lighting and sample entries in combo, key override and alt repeat
// key slot 0: the Lighting modal from its tab's footer button, and each
// entry editor from tile 0 of its tab, closed with the close button and
// with a click on the backdrop; and the status bar's keyboard name and
// Disconnect button. Opening the editors writes nothing to the keyboard.
// The tests share one session and run in order.

import { $, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  tid,
  VIRTUAL_DEVICE_NAME,
  waitForGone,
  waitForUncovered,
} from '../helpers/app'

/** Shows the keycode tab `id` of the editor's picker. */
async function openKeycodeTab(id: string): Promise<void> {
  const tab = `[data-keycode-tab="${id}"]`
  await $(tab).waitForExist()
  await clickInPage(tab)
}

/** Clicks the backdrop `backdrop` beside its modal, as a click outside the
 *  modal lands: the element at the window's top-left corner, which must be
 *  the backdrop itself. */
async function clickBackdrop(backdrop: string): Promise<void> {
  const clicked = await browser.execute((sel: string) => {
    const element = document.elementFromPoint(10, 10)
    if (element === null || element !== document.querySelector(sel)) return false
    ;(element as HTMLElement).click()
    return true
  }, backdrop)
  if (!clicked) throw new Error(`the window's top-left corner is not on ${backdrop}`)
}

interface EntryEditor {
  name: string
  /** The keycode tab with the tile grid. */
  tab: string
  /** The prefix of the tiles' test ids. */
  tilePrefix: string
  /** The prefix of the modal's test ids. */
  modalPrefix: string
  /** The test id of the modal's body. */
  body: string
}

const ENTRY_EDITORS: EntryEditor[] = [
  { name: 'Combo', tab: 'combo', tilePrefix: 'combo', modalPrefix: 'combo', body: 'editor-combo' },
  { name: 'Key Override', tab: 'keyOverride', tilePrefix: 'ko', modalPrefix: 'ko', body: 'editor-key-override' },
  { name: 'Alt Repeat Key', tab: 'altRepeatKey', tilePrefix: 'arep', modalPrefix: 'ar', body: 'editor-alt-repeat-key' },
]

/** Opens the entry editor of tile 0 of `editor`'s tab. */
async function openEntryEditor(editor: EntryEditor): Promise<void> {
  await openKeycodeTab(editor.tab)
  await clickInPage(tid(`${editor.tilePrefix}-tile-0`))
  await $(tid(`${editor.modalPrefix}-modal-backdrop`)).waitForDisplayed()
}

describe('Tauri build editors', () => {
  before(async () => {
    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
  })

  describe('Lighting', () => {
    const openLighting = async (): Promise<void> => {
      await openKeycodeTab('lighting')
      await clickInPage(tid('lighting-settings-btn'))
      await $(tid('editor-lighting')).waitForDisplayed()
    }

    it('opens the Lighting modal from the footer button, with a Save button, and closes it', async () => {
      await openLighting()
      await expect($(tid('lighting-save'))).toBeDisplayed()
      await clickInPage(tid('lighting-modal-close'))
      await waitForGone(tid('editor-lighting'), 'the Lighting modal did not close')
    })

    it('closes the Lighting modal on a click on the backdrop', async () => {
      await openLighting()
      await clickBackdrop(tid('lighting-modal-backdrop'))
      await waitForGone(tid('editor-lighting'), 'the Lighting modal did not close on the backdrop')
    })
  })

  for (const editor of ENTRY_EDITORS) {
    describe(editor.name, () => {
      it(`shows the tile grid and opens the editor of tile 0 with a Save button`, async () => {
        await openEntryEditor(editor)
        await expect($(tid(editor.body))).toBeDisplayed()
        await expect($(tid(`${editor.modalPrefix}-modal-save`))).toBeDisplayed()
        await clickInPage(tid(`${editor.modalPrefix}-modal-close`))
        await waitForGone(tid(editor.body), `the ${editor.name} editor did not close`)
      })

      it('closes the editor on a click on the backdrop', async () => {
        await openEntryEditor(editor)
        await clickBackdrop(tid(`${editor.modalPrefix}-modal-backdrop`))
        await waitForGone(tid(editor.body), `the ${editor.name} editor did not close on the backdrop`)
      })
    })
  }

  describe('Status bar', () => {
    it("shows the keyboard's name and the Disconnect button, and no sideload button", async () => {
      const statusBar = $(tid('status-bar'))
      await statusBar.waitForDisplayed()
      await browser.waitUntil(async () => (await statusBar.getText()).includes(VIRTUAL_DEVICE_NAME), {
        timeoutMsg: "the status bar does not show the keyboard's name",
      })
      await expect(statusBar.$(tid('disconnect-button'))).toBeDisplayed()
      // Sideloading a JSON definition belongs to the Data modal.
      expect(await statusBar.$(tid('sideload-json-btn')).isExisting()).toBe(false)
    })
  })
})
