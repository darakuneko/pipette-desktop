// SPDX-License-Identifier: GPL-2.0-or-later
//
// The pack and label stores of the Tauri build, from the Tools tab of the
// device selector's settings, with the files of sample-packs/ given to the
// file dialogs: Key Labels (QWERTY listed, two files imported, one renamed,
// sorted, exported and deleted; the one left picked on the virtual
// keyboard's keymap, whose pack tabs show vertical labels), a theme pack
// (imported, applied, deleted) and a language pack (imported, switched to,
// still in use after a restart); the changes recorded in
// local/sync-pending.json; and no page errors on the way. The tests share
// one app session and run in order.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  clickIntoFileDialog,
  clickIntoFilesDialog,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  recordPageErrors,
  recordedPageErrors,
  restartApp,
  tid,
  vialApi,
  waitForGone,
  waitForUncovered,
} from '../helpers/app'
import { readAppConfig, readPendingUnits } from '../helpers/driver'

const SAMPLE_PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '../../sample-packs')
/** WebDriver's code of the Enter key. */
const KEY_ENTER = ''

interface Meta {
  id: string
  name: string
}

/** Opens the device selector's settings on the Tools tab and clicks
 *  `button` there, which opens `modal`. */
async function openFromTools(button: string, modal: string): Promise<void> {
  await $('[data-testid="settings-button"]').click()
  await $('[data-testid="settings-modal"]').waitForDisplayed()
  await $('[data-testid="settings-tab-tools"]').click()
  await $(`[data-testid="${button}"]`).click()
  await $(`[data-testid="${modal}"]`).waitForDisplayed()
}

/** Closes `modal` with its close button, then the settings. */
async function closeToDeviceSelector(modalClose: string, modal: string): Promise<void> {
  await $(`[data-testid="${modalClose}"]`).click()
  await waitForGone(`[data-testid="${modal}"]`, `${modal} did not close`)
  await $('[data-testid="settings-close"]').click()
  await waitForGone('[data-testid="settings-modal"]', 'the settings did not close')
}

/** The live metas a store's list member answers (`{success, data}`). */
async function listed(member: string): Promise<Meta[]> {
  const answer = await vialApi<{ success: boolean; data?: Meta[] }>(member)
  if (!answer.success) throw new Error(`${member} failed: ${JSON.stringify(answer)}`)
  return answer.data ?? []
}

/** Waits until `member` lists a pack named `name`, and answers it. */
async function waitForListed(member: string, name: string): Promise<Meta> {
  let found: Meta | undefined
  await browser.waitUntil(
    async () => {
      found = (await listed(member)).find((meta) => meta.name === name)
      return found !== undefined
    },
    { timeoutMsg: `${member} does not list ${name}` },
  )
  return found as Meta
}

/** The `textContent` (or another string property) of the element
 *  `selector` finds now, or null when it finds none. A truncated name
 *  cell's rendered text can be empty, so the content is read. */
function textOf(selector: string, property: 'textContent' | 'value' = 'textContent'): Promise<string | null> {
  return browser.execute(
    (sel: string, prop: string) => {
      const element = document.querySelector(sel) as unknown as Record<string, unknown> | null
      return element ? String(element[prop] ?? '') : null
    },
    selector,
    property,
  )
}

/** The ids of the rows `prefix` shows, top to bottom. */
function shownRowIds(prefix: string): Promise<string[]> {
  return browser.execute(
    (p: string) =>
      [...document.querySelectorAll(`[data-testid^="${p}"]`)].map((row) => row.getAttribute('data-testid')!.slice(p.length)),
    prefix,
  )
}

describe('Tauri build packs and labels', () => {
  let dir = ''
  /** Page errors of the page loads before the current one. */
  const earlierErrors: string[] = []
  const expectedUnits: string[] = []

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipette-e2e-packs-'))
    await recordPageErrors()
    await $('[data-testid="settings-button"]').waitForDisplayed({ timeout: 20_000 })
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports, renames, sorts, exports and deletes key labels', async () => {
    await openFromTools('settings-key-labels-button', 'key-labels-modal')
    // QWERTY has no rename trigger: its name is plain text in its row.
    await expect($('[data-testid="key-labels-row-qwerty"]')).toHaveText(expect.stringContaining('QWERTY'))
    // QWERTY is built in: nothing to upload, rename or delete.
    for (const action of ['upload', 'rename', 'delete']) {
      expect(await $(`[data-testid="key-labels-${action}-qwerty"]`).isExisting()).toBe(false)
    }

    await clickIntoFilesDialog('[data-testid="key-labels-import-button"]', [
      join(SAMPLE_PACKS, 'key-labels/astarte.json'),
      join(SAMPLE_PACKS, 'key-labels/eucalyn.json'),
    ])
    const astarte = await waitForListed('keyLabelStoreList', 'Astarte')
    const eucalyn = await waitForListed('keyLabelStoreList', 'Eucalyn')
    await $(`[data-testid="key-labels-name-${eucalyn.id}"]`).waitForDisplayed()
    // The rows are drawn again until the import has finished; the import
    // button is disabled until then.
    await browser.waitUntil(() => $('[data-testid="key-labels-import-button"]').isEnabled(), {
      timeoutMsg: 'the key label import did not finish',
    })

    await $(`[data-testid="key-labels-name-${astarte.id}"]`).click()
    // The rename input starts focused with the name selected; typing
    // replaces it.
    const input = `[data-testid="key-labels-rename-input-${astarte.id}"]`
    await $(input).waitForDisplayed()
    await browser.keys(['Control', 'a'])
    await browser.keys('Astarte E2E')
    await browser.waitUntil(async () => (await textOf(input, 'value')) === 'Astarte E2E', {
      timeoutMsg: 'the new name was not typed into the rename input',
    })
    await browser.keys(KEY_ENTER)
    await waitForListed('keyLabelStoreList', 'Astarte E2E')
    await browser.waitUntil(
      async () => (await textOf(`[data-testid="key-labels-name-${astarte.id}"]`)) === 'Astarte E2E',
      { timeoutMsg: 'the row does not show the new name' },
    )

    // Sorting by name stores the new order.
    const before = (await listed('keyLabelStoreList')).map((meta) => meta.id)
    expect(before).toEqual(['qwerty', astarte.id, eucalyn.id])
    await $('[data-testid="key-labels-sort-button"]').click()
    await browser.waitUntil(
      async () => (await listed('keyLabelStoreList')).map((meta) => meta.id).join() !== before.join(),
      { timeoutMsg: 'sorting did not store a new order' },
    )
    const sorted = (await listed('keyLabelStoreList')).map((meta) => meta.id)
    expect([...sorted].sort()).toEqual([...before].sort())
    // The list is drawn again after the stored order changes.
    await browser.waitUntil(async () => (await shownRowIds('key-labels-row-')).join() === sorted.join(), {
      timeoutMsg: 'the rows are not shown in the sorted order',
    })

    const exported = join(dir, 'eucalyn.json')
    await clickIntoFileDialog(`[data-testid="key-labels-export-${eucalyn.id}"]`, exported)
    await browser.waitUntil(() => existsSync(exported), { timeoutMsg: 'the key label was not exported' })
    const sample = JSON.parse(readFileSync(join(SAMPLE_PACKS, 'key-labels/eucalyn.json'), 'utf8')) as {
      map: Record<string, string>
    }
    expect(JSON.parse(readFileSync(exported, 'utf8'))).toEqual({
      name: 'Eucalyn',
      map: sample.map,
      composite_labels: null,
      keymap_applicable: true,
    })

    await $(`[data-testid="key-labels-delete-${astarte.id}"]`).click()
    await $(`[data-testid="key-labels-confirm-delete-${astarte.id}"]`).click()
    await waitForGone(`[data-testid="key-labels-row-${astarte.id}"]`, 'the deleted key label is still listed')
    expect((await listed('keyLabelStoreList')).map((meta) => meta.id)).not.toContain(astarte.id)

    // The Hub tab's search runs and ends; this session's Hub address has
    // nothing listening, so it finds nothing.
    await $('[data-testid="key-labels-tab-hub"]').click()
    await $('[data-testid="key-labels-search-input"]').setValue('french')
    await expect($('[data-testid="key-labels-search-input"]')).toHaveValue('french')
    await $('[data-testid="key-labels-search-button"]').click()
    await browser.waitUntil(() => $('[data-testid="key-labels-search-button"]').isEnabled(), {
      timeoutMsg: 'the Hub search did not end',
    })

    await closeToDeviceSelector('key-labels-modal-close', 'key-labels-modal')
    expectedUnits.push('key-labels')
  })

  it("draws the keymap's Key Label tabs with vertical labels", async () => {
    await connectVirtualKeyboard()
    await waitForUncovered(EDITOR_SELECTOR)
    await clickInPage('button[aria-label="Key Labels"]')
    await $('[role="listbox"][aria-label="Key Labels"]').waitForDisplayed()
    // The select's options act on mousedown, not on click.
    const picked = await browser.execute(() => {
      const option = [...document.querySelectorAll('[role="listbox"][aria-label="Key Labels"] [role="option"]')].find(
        (element) => element.textContent?.includes('Eucalyn'),
      ) as HTMLElement | undefined
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return option !== undefined
    })
    expect(picked).toBe(true)
    await $(tid('keymap-pack-tab-simulation')).waitForDisplayed()

    // WebKit lays a <button> out horizontally whatever its writing-mode, so
    // the vertical label is a span inside each tab: it must be vertical,
    // taller than wide, and inside its 28px tab rather than clipped by it.
    for (const tab of ['keymap-pack-tab-base', 'keymap-pack-tab-simulation']) {
      const label = await browser.execute((sel: string) => {
        const button = document.querySelector(sel)
        const span = button?.querySelector('span')
        if (!button || !span) return null
        const outer = button.getBoundingClientRect()
        const inner = span.getBoundingClientRect()
        return {
          writingMode: getComputedStyle(span).writingMode,
          width: inner.width,
          height: inner.height,
          inside:
            inner.left >= outer.left - 0.5 &&
            inner.right <= outer.right + 0.5 &&
            inner.top >= outer.top - 0.5 &&
            inner.bottom <= outer.bottom + 0.5,
        }
      }, tid(tab))
      expect(label).not.toBeNull()
      expect(label?.writingMode).toBe('vertical-rl')
      expect(label?.height).toBeGreaterThan(label?.width ?? Infinity)
      expect(label?.inside).toBe(true)
    }

    await clickInPage(tid('disconnect-button'))
    await $('[data-testid="settings-button"]').waitForDisplayed()
  })

  it('imports a theme pack, applies it and deletes it', async () => {
    await openFromTools('settings-theme-packs-button', 'theme-packs-modal')
    await clickIntoFilesDialog('[data-testid="theme-packs-import-button"]', [
      join(SAMPLE_PACKS, 'themes/catppuccin-mocha.json'),
    ])
    const mocha = await waitForListed('themePackList', 'Catppuccin Mocha')

    await $(`[data-testid="theme-packs-select-${mocha.id}"]`).click()
    await browser.waitUntil(() => readAppConfig().theme === `pack:${mocha.id}`, {
      timeoutMsg: 'the applied theme pack was not stored in the config',
    })

    await $(`[data-testid="theme-packs-delete-${mocha.id}"]`).click()
    await $(`[data-testid="theme-packs-confirm-delete-${mocha.id}"]`).click()
    await waitForGone(`[data-testid="theme-packs-row-${mocha.id}"]`, 'the deleted theme pack is still listed')
    expect(await listed('themePackList')).toEqual([])
    // Deleting the theme in use falls back to a built-in one.
    await browser.waitUntil(() => readAppConfig().theme !== `pack:${mocha.id}`, {
      timeoutMsg: 'the deleted theme pack is still the theme in use',
    })

    await closeToDeviceSelector('theme-packs-close', 'theme-packs-modal')
    expectedUnits.push('themes/index', `themes/packs/${mocha.id}`)
  })

  it('imports a language pack and keeps using it after a restart', async () => {
    await openFromTools('settings-language-packs-button', 'language-packs-modal')
    await clickIntoFilesDialog('[data-testid="language-packs-import-button"]', [
      join(SAMPLE_PACKS, 'i18n/i18n-packs-Japanese.json'),
    ])
    const japanese = await waitForListed('i18nPackList', 'Japanese')

    await $(`[data-testid="language-packs-select-${japanese.id}"]`).click()
    await browser.waitUntil(() => readAppConfig().language === `pack:${japanese.id}`, {
      timeoutMsg: 'the language switched to was not stored in the config',
    })
    await closeToDeviceSelector('language-packs-modal-close', 'language-packs-modal')
    // The settings button reads 設定 in the Japanese pack.
    await expect($('[data-testid="settings-button"]')).toHaveText(expect.stringContaining('設定'))

    earlierErrors.push(...(await recordedPageErrors()))
    await restartApp()
    await $('[data-testid="settings-button"]').waitForDisplayed({ timeout: 20_000 })
    await recordPageErrors()
    expect(readAppConfig().language).toBe(`pack:${japanese.id}`)
    // The device selector registers no pack bundle of its own: the pack
    // store the settings' Tools tab (or the editor's status bar) mounts
    // registers it, and what renders after that is in Japanese, as in the
    // Electron build (i18next is not bound to its store's changes).
    // Opened again until a render after the registration shows it.
    await browser.waitUntil(
      async () => {
        await $('[data-testid="settings-button"]').click()
        await $('[data-testid="settings-tab-tools"]').click()
        const tools = await textOf('[data-testid="settings-tab-tools"]')
        await $('[data-testid="settings-close"]').click()
        await waitForGone('[data-testid="settings-modal"]', 'the settings did not close')
        return tools === 'ツール'
      },
      { timeoutMsg: 'the settings are not in Japanese after the restart' },
    )
    await expect($('[data-testid="settings-button"]')).toHaveText(expect.stringContaining('設定'))
    expectedUnits.push('i18n/index', `i18n/packs/${japanese.id}`)
  })

  it('records the changed sync units', () => {
    expect(readPendingUnits()).toEqual(expect.arrayContaining(expectedUnits))
  })

  it('logged no page errors', async () => {
    expect([...earlierErrors, ...(await recordedPageErrors())]).toEqual([])
  })
})
