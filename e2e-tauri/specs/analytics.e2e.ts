// SPDX-License-Identifier: GPL-2.0-or-later
//
// The typing analytics in the Tauri build: a keyboard's data seeded as day
// files under this device's machine hash (the seed of the Electron build's
// Analyze e2e, helpers/analyze-seed.ts) and another device's day file,
// rebuilt into the cache at launch, and every Analyze tab drawn from it; an
// Analyze filter saved, loaded, renamed and deleted; a restart that keeps
// the cache, and one without sync_state.json and the cache that rebuilds
// it; the Data modal's typing operations (a day exported into a folder
// and the exported file imported, through the file dialogs; a local day
// deleted; every local day deleted) and the delete of the other device's
// data; the virtual keyboard recorded with REC on, into its day file and a
// sync unit; a Typing Test run and its run log; keys typed right before a
// quit, whose minute the quit writes; the recorded keyboard in Analyze;
// and no page errors on the way. The tests share one app session and run
// in order.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  clickInPage,
  clickIntoFileDialog,
  clickIntoFilesDialog,
  connectVirtualKeyboard,
  EDITOR_SELECTOR,
  invokeCommand,
  recordPageErrors,
  recordedPageErrors,
  restartApp,
  textContentOf,
  tid,
  unlockIfAsked,
  vialApi,
  virtualDevice,
  waitForGone,
} from '../helpers/app'
import { readPendingUnits, userDataPath } from '../helpers/driver'
import { DUMMY_TA_UID, seedDummyTypingAnalytics } from '../helpers/analyze-seed'

const REMOTE_HASH = 'e2e-remote-device-hash'
const REMOTE_SCOPE = 'e2e-remote-scope'
const OWN_OLD_SCOPE = 'e2e-own-old-scope'
const FILTER_LABEL = 'E2E filter'
const FILTER_RENAMED = 'E2E filter renamed'
/** WebDriver's code of the Enter key. */
const KEY_ENTER = '\uE007'
/** WebDriver's code of the Control key. */
const KEY_CONTROL = '\uE009'
const MINUTE_MS = 60_000
/** More words than a Typing Test run of 15 words takes. */
const MAX_TYPED_WORDS = 40
/** Keys of the virtual keyboard's alpha rows (the unlock combo is row 0). */
const TYPED_KEYS: [number, number][] = [[2, 1], [2, 2], [2, 3], [3, 4]]
const DAY_MS = 86_400_000

/** The Analyze tabs and an element each draws from the seeded data. */
const ANALYZE_TABS: [string, string | null][] = [
  ['summary', null],
  ['wpm', 'analyze-wpm-chart'],
  ['interval', 'analyze-interval-chart'],
  ['activity', 'analyze-activity-chart'],
  ['byApp', null],
  ['keyHeatmap', 'analyze-keyheatmap-ranking'],
  ['ergonomics', 'analyze-ergonomics-finger'],
  ['bigrams', null],
  ['layer', null],
  ['layoutComparison', null],
]

interface DaySummary {
  date: string
  keystrokes: number
}

interface TypingSyncState {
  my_device_id: string
  uploaded: Record<string, unknown>
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function syncStatePath(): string {
  return userDataPath('local', 'typing-analytics', 'sync_state.json')
}

function readSyncState(): TypingSyncState {
  return JSON.parse(readFileSync(syncStatePath(), 'utf8')) as TypingSyncState
}

function deviceDir(uid: string, hash: string): string {
  return userDataPath('sync', 'keyboards', uid, 'devices', hash)
}

/** The day files of `uid` recorded under `hash`. */
function dayFiles(uid: string, hash: string): string[] {
  const dir = deviceDir(uid, hash)
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort() : []
}

/** The rows of a day file. */
function readRows(path: string): { id: string; kind: string; payload: Record<string, unknown> }[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { id: string; kind: string; payload: Record<string, unknown> })
}

/** A day file of `hash`'s data of the seeded keyboard: its scope and ten
 *  minutes from noon (UTC) of the UTC day `day`, one local day in every
 *  time zone. Returns the file's name. */
function writeDeviceDay(hash: string, scopeId: string, day: string): string {
  const noon = Date.parse(`${day}T12:00:00.000Z`)
  const row = (kind: string, id: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ id, kind, updated_at: noon, payload }) + '\n'
  let content = row('scope', `scope|${scopeId}`, {
    id: scopeId,
    machineHash: hash,
    osPlatform: 'linux',
    osRelease: '6.8.0-e2e',
    osArch: 'x64',
    keyboardUid: DUMMY_TA_UID,
    keyboardVendorId: 0x4153,
    keyboardProductId: 0x4d47,
    keyboardProductName: 'GPK60-63R (docs)',
  })
  for (let minute = 0; minute < 10; minute += 1) {
    const minuteTs = noon + minute * MINUTE_MS
    content += row('minute-stats', `minute-stats|${scopeId}|${minuteTs}`, {
      scopeId,
      minuteTs,
      keystrokes: 120,
      activeMs: 40_000,
      intervalAvgMs: 180,
      intervalMinMs: 60,
      intervalP25Ms: 120,
      intervalP50Ms: 170,
      intervalP75Ms: 220,
      intervalMaxMs: 600,
    })
  }
  const dir = deviceDir(DUMMY_TA_UID, hash)
  mkdirSync(dir, { recursive: true })
  const name = `${day}.jsonl`
  writeFileSync(join(dir, name), content)
  return name
}

/** The local date (`YYYY-MM-DD`) of `ms`. */
function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const totalKeystrokes = (days: DaySummary[]): number => days.reduce((sum, day) => sum + day.keystrokes, 0)

const runLogs = async (uid: string): Promise<{ id: string }[]> =>
  (await vialApi<{ success: boolean; entries?: { id: string }[] }>('typingRunLogList', uid)).entries ?? []

const localDays = (uid: string): Promise<DaySummary[]> => vialApi<DaySummary[]>('typingAnalyticsListItemsLocal', uid)
const remoteDays = (uid: string, hash: string): Promise<DaySummary[]> =>
  vialApi<DaySummary[]>('typingAnalyticsListItemsForHash', uid, hash)

async function openAnalyze(uid: string): Promise<void> {
  await clickInPage(tid('tab-analyze'))
  await $(tid('analyze-page')).waitForDisplayed()
  await clickInPage(tid('analyze-filter-chip'))
  await $(tid('analyze-filter-modal')).waitForDisplayed()
  await $(tid(`analyze-kb-${uid}`)).waitForExist()
  await $(tid('analyze-filter-keyboard')).selectByAttribute('value', uid)
  await $(tid('analyze-filter-modal-apply')).click()
  await waitForGone(tid('analyze-filter-modal'), 'the Analyze filter modal did not close')
}

/** Shows the Analyze tab `key` and waits until it is selected. */
async function selectAnalyzeTab(key: string): Promise<void> {
  await clickInPage(tid(`analyze-tab-${key}`))
  await browser.waitUntil(async () => (await $(tid(`analyze-tab-${key}`)).getAttribute('aria-selected')) === 'true', {
    timeoutMsg: `the ${key} tab was not selected`,
  })
}

async function leaveAnalyze(): Promise<void> {
  await $(tid('analyze-back')).click()
  await $(tid('analyze-page')).waitForDisplayed({ reverse: true })
}

async function openDataTyping(uid: string): Promise<void> {
  await $(tid('data-button')).click()
  await $(tid('data-modal')).waitForDisplayed()
  await expandBranch('nav-local', 'nav-local-typing')
  await expandBranch('nav-local-typing', `nav-typing-${uid}`)
  await $(tid(`nav-typing-${uid}`)).click()
  await $(`${tid('typing-list')}, ${tid('typing-empty')}`).waitForDisplayed()
}

/** Opens the Data modal's tree branch `branch` unless `child` already shows. */
async function expandBranch(branch: string, child: string): Promise<void> {
  if (await $(tid(child)).isDisplayed()) return
  await $(tid(branch)).click()
  await $(tid(child)).waitForDisplayed()
}

async function closeData(): Promise<void> {
  await $(tid('data-modal-close')).click()
  await waitForGone(tid('data-modal'), 'the Data modal did not close')
}

/** Checks the row of `date` in the Data modal's typing list. */
async function selectDay(date: string): Promise<void> {
  const box = $(tid(`typing-row-${date}`)).$('input[type="checkbox"]')
  await box.click()
  await browser.waitUntil(() => box.isSelected(), { timeoutMsg: `the row of ${date} was not selected` })
}

/** Waits until the debounced flush and the quit leave no time before the
 *  current minute ends: at least `ms` of it left. */
async function waitForMinuteLeft(ms: number): Promise<void> {
  const left = MINUTE_MS - (Date.now() % MINUTE_MS)
  if (left < ms) await browser.pause(left + 500)
}

/** The keyboard (other than the seeded one) with a day file of this
 *  device, or null. */
function recordedUidOf(ownHash: string): string | null {
  const keyboards = userDataPath('sync', 'keyboards')
  for (const uid of existsSync(keyboards) ? readdirSync(keyboards) : []) {
    if (uid !== DUMMY_TA_UID && dayFiles(uid, ownHash).length > 0) return uid
  }
  return null
}

/** The keystrokes the minute-stats row of `minute` holds in `uid`'s day
 *  file `day` of this device; 0 when there is none. */
function minuteKeystrokesOf(ownHash: string, uid: string, day: string, minute: number): number {
  const path = join(deviceDir(uid, ownHash), `${day}.jsonl`)
  if (!existsSync(path)) return 0
  let keystrokes = 0
  for (const row of readRows(path)) {
    if (row.kind === 'minute-stats' && row.payload.minuteTs === minute) keystrokes = Number(row.payload.keystrokes)
  }
  return keystrokes
}

/** Waits until local/sync-pending.json lists `units`: the app writes it a
 *  moment after a change. */
async function waitForPendingUnits(units: string[]): Promise<void> {
  await browser.waitUntil(() => units.every((unit) => readPendingUnits().includes(unit)), {
    timeoutMsg: `local/sync-pending.json does not list ${units.join(', ')}`,
  })
}

/** Taps `row,col` of the virtual keyboard `times` times. */
async function tapKeys(keys: [number, number][], times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    for (const [row, col] of keys) {
      await virtualDevice.pressKey(row, col)
      await browser.pause(40)
      await virtualDevice.releaseKey(row, col)
      await browser.pause(40)
    }
  }
}

describe('Tauri build typing analytics', () => {
  let ownHash = ''
  let remoteDay = ''
  let ownOldDay = ''
  let exportDir = ''
  let virtualUid = ''
  const recordedUid = (): string | null => recordedUidOf(ownHash)
  const minuteKeystrokes = (uid: string, day: string, minute: number): number =>
    minuteKeystrokesOf(ownHash, uid, day, minute)

  after(() => {
    if (exportDir) rmSync(exportDir, { recursive: true, force: true })
  })

  it('seeds this device and another device, and rebuilds the cache from them at launch', async () => {
    ownHash = await invokeCommand<string>('dev_typing_analytics_machine_hash')
    expect(ownHash).toMatch(/^[0-9a-f]{64}$/)
    await browser.waitUntil(() => existsSync(syncStatePath()), { timeoutMsg: 'sync_state.json was not written' })
    expect(readSyncState().my_device_id).toBe(ownHash)

    await restartApp(async () => {
      // Removes sync_state.json, so the launch rebuilds the cache.
      await seedDummyTypingAnalytics(userDataPath(), Date.now())
      remoteDay = writeDeviceDay(REMOTE_HASH, REMOTE_SCOPE, utcDay(Date.now() - DAY_MS))
      // Before the seeded data, and inside one UTC day, as an import takes it.
      ownOldDay = writeDeviceDay(ownHash, OWN_OLD_SCOPE, utcDay(Date.now() - 120 * DAY_MS))
    })
    await recordPageErrors()

    expect(await invokeCommand<string>('dev_typing_analytics_machine_hash')).toBe(ownHash)
    await browser.waitUntil(async () => (await localDays(DUMMY_TA_UID)).length > 0, {
      timeoutMsg: 'the seeded days are not in the cache',
    })
    expect(readSyncState()).toEqual(expect.objectContaining({ my_device_id: ownHash, uploaded: {} }))
    expect((await localDays(DUMMY_TA_UID)).length).toBeGreaterThanOrEqual(21)
    expect((await remoteDays(DUMMY_TA_UID, REMOTE_HASH)).length).toBe(1)
  })

  it('draws every Analyze tab from the seeded data', async () => {
    await openAnalyze(DUMMY_TA_UID)
    for (const [key, drawn] of ANALYZE_TABS) {
      await selectAnalyzeTab(key)
      await $(tid('analyze-chart')).waitForDisplayed()
      if (drawn) await $(tid(drawn)).waitForDisplayed({ timeoutMsg: `the ${key} tab drew no ${drawn}` })
    }

    // The Activity tab's sessions metric draws the session histogram.
    const metric = $(tid('analyze-filter-activity-metric'))
    await selectAnalyzeTab('activity')
    await metric.selectByAttribute('value', 'sessions')
    await $(tid('analyze-activity-sessions')).waitForDisplayed({ timeoutMsg: 'the sessions metric drew no histogram' })
    await metric.selectByAttribute('value', 'keystrokes')
    // The Layer tab's activations chart has the base-layer picker, as the
    // seeded snapshot has more than one layer.
    await selectAnalyzeTab('layer')
    await $(tid('analyze-filter-layer-base-layer')).waitForDisplayed({ timeoutMsg: 'the Layer tab has no base-layer picker' })
    expect(await recordedPageErrors()).toEqual([])
  })

  it('saves, loads, renames and deletes an Analyze filter', async () => {
    await $(tid('analyze-filter-store-toggle')).click()
    await $(tid('analyze-filter-store-panel')).waitForDisplayed()
    await $(tid('analyze-filter-store-save-input')).setValue(FILTER_LABEL)
    await $(tid('analyze-filter-store-save-submit')).click()
    await $(tid('analyze-filter-store-saved-flash')).waitForDisplayed()

    const listed = async () =>
      (await vialApi<{ success: boolean; entries?: { id: string; label: string }[] }>('analyzeFilterStoreList', DUMMY_TA_UID))
        .entries ?? []
    await browser.waitUntil(async () => (await listed()).length === 1, { timeoutMsg: 'the filter was not saved' })
    const [entry] = await listed()
    expect(entry.label).toBe(FILTER_LABEL)

    await $(tid(`analyze-filter-store-load-${entry.id}`)).click()
    await $(tid(`analyze-filter-store-entry-label-${entry.id}`)).click()
    const input = $(tid(`analyze-filter-store-rename-input-${entry.id}`))
    await input.waitForDisplayed()
    // The input takes the focus when it opens.
    await browser.keys([KEY_CONTROL, 'a'])
    await browser.keys(FILTER_RENAMED)
    await browser.keys(KEY_ENTER)
    await browser.waitUntil(async () => (await listed())[0]?.label === FILTER_RENAMED, {
      timeoutMsg: 'the filter was not renamed',
    })

    // The row shows the new label only after the panel re-reads the list,
    // and the longer label widens the panel. The delete click goes through
    // the page: a pointer click aimed before that re-layout, or one landing
    // on the label's tooltip (drawn outside the panel), reads as a click
    // outside the panel and closes it instead.
    await waitForGone(tid(`analyze-filter-store-rename-input-${entry.id}`), 'the rename input did not close')
    // The label is truncated, and the rendered text of a truncated element
    // can read empty, so its content is compared.
    await browser.waitUntil(
      async () => (await textContentOf(tid(`analyze-filter-store-entry-label-${entry.id}`))) === FILTER_RENAMED,
      { timeoutMsg: 'the panel did not show the renamed filter' },
    )
    const confirmDelete = tid(`analyze-filter-store-delete-confirm-${entry.id}`)
    await browser.waitUntil(
      async () => {
        if (await $(confirmDelete).isDisplayed()) return true
        await clickInPage(tid(`analyze-filter-store-delete-${entry.id}`))
        return $(confirmDelete).isDisplayed()
      },
      { interval: 1_000, timeoutMsg: 'the delete confirmation did not open' },
    )
    await clickInPage(confirmDelete)
    await browser.waitUntil(async () => (await listed()).length === 0, { timeoutMsg: 'the filter was not deleted' })
    await waitForPendingUnits([`keyboards/${DUMMY_TA_UID}/analyze_filters`])
    await $(tid('analyze-filter-store-toggle')).click()
    await leaveAnalyze()
  })

  it('keeps the cache across a restart, and rebuilds it without sync_state.json and the cache', async () => {
    const days = await localDays(DUMMY_TA_UID)
    const state = readFileSync(syncStatePath(), 'utf8')
    // A day file goes while the app is stopped: a cache that is kept still
    // counts its keystrokes, a rebuilt one does not.
    const files = dayFiles(DUMMY_TA_UID, ownHash)
    const removed = files[files.length - 3]
    await restartApp(() => unlinkSync(join(deviceDir(DUMMY_TA_UID, ownHash), removed)))
    await recordPageErrors()
    expect(await localDays(DUMMY_TA_UID)).toEqual(days)
    expect(readFileSync(syncStatePath(), 'utf8')).toBe(state)

    await restartApp(() => {
      unlinkSync(syncStatePath())
      rmSync(userDataPath('local', 'typing-analytics.db'), { force: true })
    })
    await recordPageErrors()
    await browser.waitUntil(async () => totalKeystrokes(await localDays(DUMMY_TA_UID)) < totalKeystrokes(days), {
      timeoutMsg: 'the cache was not rebuilt without the removed day file',
    })
    expect(readSyncState().my_device_id).toBe(ownHash)
    expect(await remoteDays(DUMMY_TA_UID, REMOTE_HASH)).toHaveLength(1)
  })

  it('exports a day into a folder and imports the exported file from the Data modal', async () => {
    const days = await localDays(DUMMY_TA_UID)
    const date = localDate(Date.parse(`${ownOldDay.slice(0, 10)}T12:00:00.000Z`))
    expect(days.map((day) => day.date)).toContain(date)
    const dayFile = join(deviceDir(DUMMY_TA_UID, ownHash), ownOldDay)
    const bytes = readFileSync(dayFile, 'utf8')
    exportDir = mkdtempSync(join(tmpdir(), 'pipette-e2e-analytics-'))
    await openDataTyping(DUMMY_TA_UID)
    await selectDay(date)
    await clickIntoFileDialog(tid('typing-export'), exportDir)
    await $(tid('typing-import-status-dismiss')).waitForDisplayed({ timeoutMsg: 'the export did not finish' })
    const exported = readdirSync(exportDir)
    expect(exported).toHaveLength(1)
    expect(readFileSync(join(exportDir, exported[0]), 'utf8')).toBe(bytes)
    await $(tid('typing-import-status-dismiss')).click()

    // The import replaces the local day with the file, so an edited file
    // shows: it drops the day's last minute.
    const lines = bytes.split('\n').filter((line) => line.length > 0)
    const dropped = JSON.parse(lines[lines.length - 1]) as { kind: string; payload: { keystrokes: number } }
    expect(dropped.kind).toBe('minute-stats')
    const edited = lines.slice(0, -1).join('\n') + '\n'
    writeFileSync(join(exportDir, exported[0]), edited)
    await clickIntoFilesDialog(tid('typing-import'), [join(exportDir, exported[0])])
    // The banner offers its dismiss button once the import has finished;
    // it lists the files it rejected.
    await $(tid('typing-import-status-dismiss')).waitForDisplayed({ timeoutMsg: 'the import did not finish' })
    expect(await $(tid('typing-import-status')).$$('li').length).toBe(0)
    expect(readFileSync(dayFile, 'utf8')).toBe(edited)
    const keystrokesOf = (list: DaySummary[]): number | undefined => list.find((day) => day.date === date)?.keystrokes
    await browser.waitUntil(async () => keystrokesOf(await localDays(DUMMY_TA_UID)) === (keystrokesOf(days) ?? 0) - dropped.payload.keystrokes, {
      timeoutMsg: 'the cache does not hold the imported day',
    })
    await $(tid('typing-import-status-dismiss')).click()
  })

  it('deletes a local day, then every local day, from the Data modal', async () => {
    const days = await localDays(DUMMY_TA_UID)
    const { date } = days[days.length - 2]
    await selectDay(date)
    await $(tid('typing-delete-selected')).click()
    await $(tid('typing-delete-selected-confirm')).click()
    await $(tid(`typing-row-${date}`)).waitForExist({ reverse: true })
    expect((await localDays(DUMMY_TA_UID)).map((d) => d.date)).not.toContain(date)

    await $(tid('typing-delete-all')).click()
    await $(tid('typing-delete-all-confirm')).click()
    await browser.waitUntil(async () => (await localDays(DUMMY_TA_UID)).length === 0, {
      timeoutMsg: 'the local days were not deleted',
    })
    await closeData()
    expect(dayFiles(DUMMY_TA_UID, ownHash)).toEqual([])
    expect(existsSync(join(deviceDir(DUMMY_TA_UID, ownHash), 'deleted-ranges.json'))).toBe(true)
    await waitForPendingUnits([`keyboards/${DUMMY_TA_UID}/devices/${ownHash}/deleted-ranges`])
  })

  it("deletes the other device's data", async () => {
    // The Data modal lists other devices under Sync, which needs a signed
    // in cloud sync; the delete itself is the member the Sync tab calls.
    expect(await remoteDays(DUMMY_TA_UID, REMOTE_HASH)).toHaveLength(1)
    await vialApi('typingAnalyticsDeleteDeviceData', DUMMY_TA_UID, REMOTE_HASH, 'all')
    expect(await remoteDays(DUMMY_TA_UID, REMOTE_HASH)).toEqual([])
    expect(existsSync(join(deviceDir(DUMMY_TA_UID, REMOTE_HASH), 'deleted-ranges.json'))).toBe(true)
    expect(existsSync(join(deviceDir(DUMMY_TA_UID, REMOTE_HASH), remoteDay))).toBe(true)
    await waitForPendingUnits([`keyboards/${DUMMY_TA_UID}/devices/${REMOTE_HASH}/deleted-ranges`])
    expect(await recordedPageErrors()).toEqual([])
  })

  it('records the virtual keyboard with REC on, into its day file and a sync unit', async function () {
    // Waiting for room in the minute alone can take 20 s on top of the
    // connect, the unlock and the file waits.
    this.timeout(3 * MINUTE_MS)
    await connectVirtualKeyboard()
    await recordPageErrors()
    await virtualDevice.setUnlockCounterMax(3)
    await $(tid('typing-record-button')).click()
    await $(tid('typing-record-modal')).waitForDisplayed()
    await $(tid('typing-record-toggle')).click()
    await $(tid('typing-consent-modal')).waitForDisplayed()
    await $(tid('typing-consent-accept')).click()
    await unlockIfAsked()
    await browser.waitUntil(async () => (await $(tid('typing-record-toggle')).getAttribute('aria-checked')) === 'true', {
      timeoutMsg: 'REC did not start',
    })
    await $(tid('typing-record-close')).click()
    await waitForGone(tid('typing-record-modal'), 'the record modal did not close')

    await waitForMinuteLeft(20_000)
    const typedAt = Date.now()
    await tapKeys(TYPED_KEYS, 5)
    // Stopping REC flushes the keyboard's open minute.
    await $(tid('typing-record-button')).click()
    await $(tid('typing-record-toggle')).click()
    await browser.waitUntil(async () => (await $(tid('typing-record-toggle')).getAttribute('aria-checked')) === 'false', {
      timeoutMsg: 'REC did not stop',
    })
    await $(tid('typing-record-close')).click()

    await browser.waitUntil(() => recordedUid() !== null, { timeoutMsg: 'no day file of the virtual keyboard was written' })
    virtualUid = recordedUid() ?? ''
    const day = utcDay(typedAt)
    const minute = Math.floor(typedAt / MINUTE_MS) * MINUTE_MS
    await browser.waitUntil(() => minuteKeystrokes(virtualUid, day, minute) > 0, {
      timeoutMsg: 'the typed minute is not in the day file',
    })
    await waitForPendingUnits([`keyboards/${virtualUid}/devices/${ownHash}/days/${day}`])
    const keyboards = await vialApi<{ uid: string }[]>('typingAnalyticsListKeyboards')
    expect(keyboards.map((kb) => kb.uid)).toContain(virtualUid)
    expect(await recordedPageErrors()).toEqual([])
  })

  it('saves the run log of a Typing Test run', async () => {
    await $(tid('typing-test-button')).click()
    await unlockIfAsked()
    await $(tid('typing-test-view')).waitForDisplayed()
    if (await $(tid('typing-settings-panel-collapsed')).isExisting()) {
      await $(tid('typing-settings-panel-toggle')).click()
    }
    await $(tid('mode-words')).click()
    await $(tid('word-count-15')).click()

    for (let i = 0; i < MAX_TYPED_WORDS && (await $(tid('typing-test-words')).isExisting()); i += 1) {
      const word = await $(tid(`word-${i}`)).getText()
      await browser.keys(`${word} `)
    }
    await $(tid('typing-test-words')).waitForExist({ reverse: true, timeoutMsg: 'the run did not finish' })
    await browser.waitUntil(async () => (await runLogs(virtualUid)).length === 1, {
      timeoutMsg: 'the run log was not saved',
    })
    const [log] = await runLogs(virtualUid)
    const saved = await vialApi<{ success: boolean; data?: { runId: string } }>('typingRunLogGet', virtualUid, log.id)
    expect(saved.success).toBe(true)
    await waitForPendingUnits([`keyboards/${virtualUid}/runs`])
    await $(tid('typing-test-button')).click()
    await $(tid('typing-test-view')).waitForDisplayed({ reverse: true })
    expect(await recordedPageErrors()).toEqual([])
  })

  it('writes the minute typed right before a quit', async function () {
    // Waiting for the next minute alone can take a whole minute, on top of
    // the relaunch.
    this.timeout(3 * MINUTE_MS)
    await $(tid('typing-record-button')).click()
    await $(tid('typing-record-toggle')).click()
    await unlockIfAsked()
    await browser.waitUntil(async () => (await $(tid('typing-record-toggle')).getAttribute('aria-checked')) === 'true', {
      timeoutMsg: 'REC did not start',
    })
    await $(tid('typing-record-close')).click()
    await waitForGone(tid('typing-record-modal'), 'the record modal did not close')

    // A minute nothing was typed in yet, still open at the quit: a closed
    // minute is written by the debounced flush.
    await browser.pause(MINUTE_MS - (Date.now() % MINUTE_MS) + 500)
    const typedAt = Date.now()
    const day = utcDay(typedAt)
    const minute = Math.floor(typedAt / MINUTE_MS) * MINUTE_MS
    await tapKeys(TYPED_KEYS, 5)
    // Lets the renderer hand the last presses to the backend.
    await browser.pause(1_500)
    expect(minuteKeystrokes(virtualUid, day, minute)).toBe(0)
    await restartApp(() => {
      expect(minuteKeystrokes(virtualUid, day, minute)).toBeGreaterThan(0)
    })
    await recordPageErrors()
    await waitForPendingUnits([`keyboards/${virtualUid}/devices/${ownHash}/days/${day}`])
  })

  it('lists the recorded keyboard in Analyze', async () => {
    // The relaunched app reconnects the keyboard it had open, and REC asks
    // for the unlock again.
    await $(EDITOR_SELECTOR).waitForDisplayed()
    await unlockIfAsked()
    await clickInPage(tid('status-analyze-button'))
    await $(tid('analyze-page')).waitForDisplayed()
    await clickInPage(tid('analyze-filter-chip'))
    await $(tid(`analyze-kb-${virtualUid}`)).waitForExist()
    expect(await $(tid('analyze-filter-keyboard')).getValue()).toBe(virtualUid)
    await $(tid('analyze-filter-modal-close')).click()
    await waitForGone(tid('analyze-filter-modal'), 'the Analyze filter modal did not close')
    await leaveAnalyze()
    expect(await recordedPageErrors()).toEqual([])
  })
})
