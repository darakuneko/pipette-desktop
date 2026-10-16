// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Typing Test's text and word list stores in the Tauri build, from the
// Mode modal of the typing test on the virtual keyboard: a text file
// imported, imported again under the same name and confirmed over the
// first; the Tatoeba dataset updated from the Hub and a word list of it
// downloaded; the Aozora Bunko catalog updated and a work imported; the
// changes recorded in local/sync-pending.json; and no page errors on the
// way. Every Hub and download response is recorded with dev_http_respond,
// and the app's Hub address is one nothing listens on (E2E_HUB_URL), so no
// request reaches the network. The tests share one app session and run in
// order.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import {
  clickIntoFileDialog,
  connectVirtualKeyboard,
  queuedHttpResponses,
  recordPageErrors,
  recordedPageErrors,
  respondHttp,
  unlockIfAsked,
  vialApi,
  virtualDevice,
  waitForGone,
  waitForHttpResponsesTaken,
} from '../helpers/app'
import { E2E_HUB_URL, readPendingUnits, userDataPath } from '../helpers/driver'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DOWNLOADS = 'https://e2e.invalid/downloads'

interface TextMeta {
  id: string
  name: string
  source?: { provider: string; workId: string }
}

async function listedTexts(): Promise<TextMeta[]> {
  const answer = await vialApi<{ success: boolean; data?: TextMeta[] }>('typingTestTextStoreList')
  if (!answer.success) throw new Error(`typingTestTextStoreList failed: ${JSON.stringify(answer)}`)
  return answer.data ?? []
}

/** Records the Hub's answers for one check and one update of `provider`'s
 *  dataset to `dataset`. */
async function respondDataset(provider: string, dataset: { version: string; [key: string]: unknown }): Promise<void> {
  const route = `${E2E_HUB_URL}/api/typing-test/datasets/${provider}`
  const version = JSON.stringify({ ok: true, data: { provider, version: dataset.version } })
  // The modal's check, then the update's own check.
  await respondHttp(`${route}/version`, version)
  await respondHttp(`${route}/version`, version)
  await respondHttp(route, JSON.stringify({ ok: true, data: dataset }))
}

/** The zip of an Aozora Bunko work and its catalog entry, from the first
 *  import of the crate's recorded scenarios. */
function recordedWork(): { zip: Uint8Array; entry: { name: string; title: string } } {
  const path = join(REPO_ROOT, 'src-tauri/crates/pipette-typing-datasets/tests/fixtures/ts_aozora_import_scenarios.json')
  const [scenario] = JSON.parse(readFileSync(path, 'utf8')) as {
    tree: Record<string, string>
    steps: { workId: string; replies: { hex: string }[] }[]
  }[]
  const overrides = JSON.parse(scenario.tree['local/typing-test-dataset.json']) as {
    aozora: { languages: { name: string; title: string }[] }
  }
  const [entry] = overrides.aozora.languages
  const [step] = scenario.steps
  if (step.workId !== entry.name) throw new Error('the recorded import is not of the first catalog entry')
  return { zip: Uint8Array.from(Buffer.from(step.replies[0].hex, 'hex')), entry }
}

/** Opens the typing test's Mode modal on `tab`. */
async function openModeTab(tab: 'tatoeba' | 'aozora' | 'import'): Promise<void> {
  if (!(await $('[data-testid="language-modal-close"]').isExisting())) {
    const collapsed = $('[data-testid="typing-settings-panel-collapsed"]')
    if (await collapsed.isExisting()) await $('[data-testid="typing-settings-panel-toggle"]').click()
    await $('[data-testid="language-selector"]').click()
  }
  await $(`[data-testid="language-tab-${tab}"]`).click()
}

/** Applies the dataset update the open tab's banner offers. */
async function applyDatasetUpdate(): Promise<void> {
  await $('[data-testid="typing-dataset-update-banner"]').waitForDisplayed()
  await $('[data-testid="typing-dataset-update-button"]').click()
  await waitForGone('[data-testid="typing-dataset-update-banner"]', 'the dataset update did not apply')
}

describe('Tauri build typing test data', () => {
  let dir = ''

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipette-e2e-typing-'))
    await connectVirtualKeyboard()
    await recordPageErrors()
    await virtualDevice.setUnlockCounterMax(3)
    await $('[data-testid="typing-test-button"]').click()
    await unlockIfAsked()
    await $('[data-testid="typing-test-view"]').waitForDisplayed()
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports a text file, and confirms a second import of the same name over it', async () => {
    const file = join(dir, 'E2E text.txt')
    writeFileSync(file, 'first words here')
    await openModeTab('import')
    await clickIntoFileDialog('[data-testid="typing-text-import"]', file)
    await browser.waitUntil(async () => (await listedTexts()).some((meta) => meta.name === 'E2E text'), {
      timeoutMsg: 'the imported text is not listed',
    })
    const [first] = await listedTexts()

    writeFileSync(file, 'second words here now')
    await clickIntoFileDialog('[data-testid="typing-text-import"]', file)
    await $('[data-testid="typing-text-import-overwrite"]').waitForDisplayed()
    await $('[data-testid="typing-text-import-overwrite-confirm"]').click()
    await waitForGone('[data-testid="typing-text-import-overwrite"]', 'the overwrite prompt did not close')
    await browser.waitUntil(
      async () => {
        const got = await vialApi<{ success: boolean; data?: { data: { text: string } } }>('typingTestTextStoreGet', first.id)
        return got.data?.data.text === 'second words here now'
      },
      { timeoutMsg: 'the confirmed import did not replace the text' },
    )
    expect((await listedTexts()).map((meta) => meta.id)).toEqual([first.id])
  })

  it('updates the Tatoeba dataset and downloads one of its word lists', async () => {
    const words = JSON.stringify({ name: 'japanese', words: ['ねこがいる。', 'いぬがいる。', 'とりがいる。'] })
    await respondDataset('tatoeba', {
      provider: 'tatoeba',
      version: 'e2e-tatoeba',
      downloadUrlBase: `${DOWNLOADS}/tatoeba`,
      model: 'pack',
      languages: [{ name: 'japanese', wordCount: 3, rightToLeft: false, fileSize: Buffer.byteLength(words) }],
    })
    await respondHttp(`${DOWNLOADS}/tatoeba/japanese.json`, words)

    await openModeTab('tatoeba')
    await applyDatasetUpdate()
    await $('[data-testid="language-download-japanese"]').click()
    await $('[data-testid="language-delete-japanese"]').waitForDisplayed()
    expect(readFileSync(userDataPath('local', 'downloads', 'languages', 'tatoeba', 'japanese.json'), 'utf8')).toBe(words)
    expect(JSON.parse(readFileSync(userDataPath('local', 'typing-test-dataset.json'), 'utf8')).tatoeba.version).toBe('e2e-tatoeba')
  })

  it('updates the Aozora Bunko catalog and imports a work of it', async () => {
    const { zip, entry } = recordedWork()
    await respondDataset('aozora', {
      provider: 'aozora',
      version: 'e2e-aozora',
      downloadUrlBase: `${DOWNLOADS}/aozora`,
      model: 'catalog',
      languages: [entry],
    })
    await respondHttp(`${DOWNLOADS}/aozora/${entry.name}`, zip)

    await openModeTab('aozora')
    await applyDatasetUpdate()
    await $(`[data-testid="aozora-import-${entry.name}"]`).click()
    await browser.waitUntil(
      async () => (await listedTexts()).some((meta) => meta.source?.provider === 'aozora' && meta.source.workId === entry.name),
      { timeoutMsg: 'the imported work is not listed' },
    )
    expect(await $(`[data-testid="aozora-error-${entry.name}"]`).isExisting()).toBe(false)
  })

  it('took every recorded response and recorded the changed sync units', async () => {
    await waitForHttpResponsesTaken('a recorded Hub or download response was not asked for')
    expect(await queuedHttpResponses()).toBe(0)
    expect(readPendingUnits()).toEqual(expect.arrayContaining(['typing-test-texts']))
  })

  it('logged no page errors', async () => {
    expect(await recordedPageErrors()).toEqual([])
  })
})
