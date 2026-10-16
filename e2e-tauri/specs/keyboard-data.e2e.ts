// SPDX-License-Identifier: GPL-2.0-or-later
//
// The keyboard's stored data in the Tauri build, on the virtual keyboard:
// a snapshot saved, overwritten, loaded, renamed and deleted from the
// Import / Save tab; a pipette setting kept across a restart; the keyboard
// listed under its name in the layout picker; the changes recorded in
// local/sync-pending.json; and no page errors on the way. The tests share
// one app session and run in order.

import { existsSync, readFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  HEX_INPUT_SELECTOR,
  UNLOCK_DIALOG_HEADING,
  VIRTUAL_DEVICE_NAME,
  closeKeyPopover,
  openKeycodeHexInput,
  openOverlayTab,
  openToolsOverlay,
  recordPageErrors,
  recordedPageErrors,
  restartApp,
  setKeycode,
  vialApi,
  virtualDevice,
  waitForGone,
} from '../helpers/app'
import { userDataPath } from '../helpers/driver'

const KC_X = '001B'
const KC_Z = '001D'
const UNLOCK_KEYS: [number, number][] = [[0, 0], [0, 1]]
const UNLOCK_TIMEOUT_MS = 15_000
const LABEL = 'E2E snapshot'
const RENAMED = 'E2E snapshot renamed'
/** WebDriver's code of the Enter key. */
const KEY_ENTER = '\uE007'
const ENTRY_LABEL = '[data-testid="layout-store-entry-label"]'

interface SnapshotEntry {
  id: string
  label: string
  filename: string
  deletedAt?: string
}

/** The snapshot index of `uid` on disk. */
function readSnapshotIndex(uid: string): { uid: string; entries: SnapshotEntry[] } {
  return JSON.parse(readFileSync(userDataPath('sync', 'keyboards', uid, 'snapshots', 'index.json'), 'utf8')) as {
    uid: string
    entries: SnapshotEntry[]
  }
}

function readSnapshotBody(uid: string, filename: string): string {
  return readFileSync(userDataPath('sync', 'keyboards', uid, 'snapshots', filename), 'utf8')
}

function readSettingsFile(uid: string): Record<string, unknown> | null {
  const path = userDataPath('sync', 'keyboards', uid, 'pipette_settings.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null
}

function readPendingUnits(): string[] {
  const path = userDataPath('local', 'sync-pending.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { units: string[] }).units : []
}

/** The labels of the snapshots the Import / Save tab shows. */
function shownLabels(): Promise<string[]> {
  return browser.execute(
    (selector: string) => [...document.querySelectorAll(selector)].map((label) => label.textContent ?? ''),
    ENTRY_LABEL,
  )
}

/** Types `label` in the save field of the Import / Save tab and submits it. */
async function submitSave(label: string): Promise<void> {
  await openOverlayTab('data')
  await $('[data-testid="layout-store-save-input"]').setValue(label)
  await $('[data-testid="layout-store-save-submit"]').click()
}

/** Holds the unlock combo while the unlock dialog is up, if it comes up
 *  within a few seconds. */
async function unlockIfAsked(): Promise<void> {
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

async function keycodeAt(row: number, col: number): Promise<string> {
  await openKeycodeHexInput(row, col)
  const value = (await $(HEX_INPUT_SELECTOR).getValue()).toUpperCase()
  await closeKeyPopover()
  return value
}

describe('Tauri build keyboard data', () => {
  let uid = ''
  /** Page errors of the page loads before the current one. */
  const earlierErrors: string[] = []

  before(async () => {
    await connectVirtualKeyboard()
    await recordPageErrors()
    // Connecting names the keyboard and creates its directory.
    await browser.waitUntil(
      async () => {
        const stored = await vialApi<{ uid: string; name: string }[]>('listStoredKeyboards')
        uid = stored.find((kb) => kb.name === VIRTUAL_DEVICE_NAME)?.uid ?? ''
        return uid !== ''
      },
      { timeoutMsg: 'the connected keyboard was not stored under its name' },
    )
  })

  it('saves a snapshot, overwrites it, loads it, renames it and deletes it', async () => {
    await virtualDevice.setUnlockCounterMax(3)
    await setKeycode(0, 0, KC_Z)

    // Save.
    await submitSave(LABEL)
    await browser.waitUntil(async () => (await shownLabels()).includes(LABEL), {
      timeoutMsg: 'the saved snapshot is not listed',
    })
    const [saved] = readSnapshotIndex(uid).entries
    expect(readSnapshotIndex(uid).entries).toHaveLength(1)
    expect(saved.label).toBe(LABEL)

    // Overwrite: saving under the same label asks to, then replaces the
    // entry with a new one (the old one stays as a tombstone).
    await setKeycode(0, 0, KC_X)
    await submitSave(LABEL)
    await $('[data-testid="layout-store-overwrite-confirm"]').click()
    await browser.waitUntil(() => readSnapshotIndex(uid).entries.length === 2, {
      timeoutMsg: 'the snapshot was not overwritten',
    })
    const [current, replaced] = readSnapshotIndex(uid).entries
    expect(replaced.id).toBe(saved.id)
    expect(typeof replaced.deletedAt).toBe('string')
    expect(current.label).toBe(LABEL)
    expect(current.deletedAt).toBeUndefined()

    // Update: the store writes the new body over the entry's file.
    const body = JSON.stringify(JSON.parse(readSnapshotBody(uid, current.filename)), null, 4)
    expect(await vialApi('snapshotStoreUpdate', uid, current.id, body, 2)).toEqual({ success: true })
    expect(readSnapshotBody(uid, current.filename)).toBe(body)

    // Load: the keymap goes back to the overwritten snapshot's.
    await setKeycode(0, 0, KC_Z)
    await openOverlayTab('data')
    await $('[data-testid="layout-store-load-btn"]').click()
    await $('[data-testid="layout-store-load-confirm"]').click()
    await unlockIfAsked()
    await browser.waitUntil(async () => (await keycodeAt(0, 0)) === KC_X, {
      timeoutMsg: 'loading the snapshot did not restore its keycode',
    })

    // Rename: the new label goes into the focused field as React reads an
    // edit (the element can be replaced while the list re-renders, and
    // typed keys reach WebKitGTK's field unreliably), then Enter commits it.
    await openOverlayTab('data')
    await $(ENTRY_LABEL).click()
    await browser.waitUntil(
      () => browser.execute(() => document.activeElement?.getAttribute('data-testid') === 'layout-store-rename-input'),
      { timeoutMsg: 'the rename field did not take the focus' },
    )
    await browser.execute((label: string) => {
      const input = document.activeElement as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, label)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, RENAMED)
    await browser.keys([KEY_ENTER])
    await browser.waitUntil(async () => (await shownLabels()).includes(RENAMED), {
      timeoutMsg: 'the renamed snapshot is not listed',
    })
    await browser.waitUntil(() => readSnapshotIndex(uid).entries[0]?.label === RENAMED, {
      timeoutMsg: 'the new label was not stored',
    })

    // Delete: the entry stays in the index as a tombstone.
    await $('[data-testid="layout-store-delete-btn"]').click()
    await $('[data-testid="layout-store-delete-confirm"]').click()
    await waitForGone('[data-testid="layout-store-entry"]', 'the deleted snapshot is still listed')
    const [deleted] = readSnapshotIndex(uid).entries
    expect(deleted.id).toBe(current.id)
    expect(typeof deleted.deletedAt).toBe('string')
    expect(await vialApi('snapshotStoreList', uid)).toEqual({ success: true, entries: [] })
  })

  it('keeps a pipette setting across a restart and records the changed sync units', async () => {
    await openToolsOverlay()
    const toggle = '[data-testid="overlay-auto-advance-toggle"]'
    const before = (await $(toggle).getAttribute('aria-checked')) === 'true'
    await $(toggle).click()
    await browser.waitUntil(async () => (await $(toggle).getAttribute('aria-checked')) === String(!before), {
      timeoutMsg: 'Auto Move did not toggle',
    })
    await browser.waitUntil(() => readSettingsFile(uid)?.autoAdvance === !before, {
      timeoutMsg: 'Auto Move was not stored in the pipette settings',
    })

    const expectedUnits = [`keyboards/${uid}/snapshots`, `keyboards/${uid}/settings`, 'meta/keyboard-names']
    await browser.waitUntil(() => expectedUnits.every((unit) => readPendingUnits().includes(unit)), {
      timeoutMsg: `local/sync-pending.json does not list ${expectedUnits.join(', ')}`,
    })

    earlierErrors.push(...(await recordedPageErrors()))
    await restartApp()
    // The app reopens the keyboard of the last session.
    await $(EDITOR_SELECTOR).waitForDisplayed({ timeout: 20_000 })
    await recordPageErrors()

    await openToolsOverlay()
    expect(await $(toggle).getAttribute('aria-checked')).toBe(String(!before))
    expect(readSettingsFile(uid)?.autoAdvance).toBe(!before)
    // Nothing was uploaded, so the restart keeps every unit pending.
    expect(readPendingUnits()).toEqual(expect.arrayContaining(expectedUnits))
  })

  it('lists the keyboard under its name in the saved files of the layout picker', async () => {
    const keycodes = $('[data-testid="tabbed-keycodes-root"]')
    await keycodes.$('button=Keyboard').click()
    await keycodes.$('button=File').click()
    await expect(keycodes.$(`span=${VIRTUAL_DEVICE_NAME}`)).toBeDisplayed()
    await keycodes.$('button=Basic').click()
  })

  it('logged no page errors', async () => {
    expect([...earlierErrors, ...(await recordedPageErrors())]).toEqual([])
  })
})
