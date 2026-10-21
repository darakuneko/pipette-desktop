// SPDX-License-Identifier: GPL-2.0-or-later
//
// Debug Mode (Settings › Tools) and the app's log files
// (`<userData>/logs/pipette-0.log` … `pipette-4.log`): off by default, with
// no file written; turned on, the app writes the file without a restart and
// starts with its version; turned off, every generation is removed and
// nothing more is written; Reset Local Data › App Settings turns it off.
// The tests share one app session and run in order.

import { existsSync, writeFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { closeSettings, readAppLog, vialApi } from '../helpers/app'
import { readAppConfig, userDataPath } from '../helpers/driver'
import { openSettings, setSettingsToggle, waitForPage } from '../helpers/resident'

const TOGGLE = 'settings-debug-mode-toggle'
const GENERATIONS = [0, 1, 2, 3, 4]
/** The line the app logs first once the files are enabled. */
const VERSION_LINE = /\[INFO\] Pipette \S+ on \S+/
/** How long a test waits to see that no file comes back. */
const QUIET_MS = 2_000

function logFile(generation: number): string {
  return userDataPath('logs', `pipette-${generation}.log`)
}

function existingGenerations(): number[] {
  return GENERATIONS.filter((generation) => existsSync(logFile(generation)))
}

async function waitForNoLogFiles(timeoutMsg: string): Promise<void> {
  await browser.waitUntil(() => existingGenerations().length === 0, { timeoutMsg })
}

async function waitForVersionLine(): Promise<void> {
  await browser.waitUntil(() => VERSION_LINE.test(readAppLog()), {
    timeoutMsg: 'the log file did not get the version line',
  })
}

/** Waits `QUIET_MS` while the app runs, then checks that it wrote no file. */
async function expectNoFileWritten(): Promise<void> {
  await browser.pause(QUIET_MS)
  expect(existingGenerations()).toEqual([])
}

describe('Debug Mode and the log files', () => {
  it('is off by default and writes no log file', async () => {
    await waitForPage()
    await $('h1=Pipette').waitForDisplayed()
    expect(readAppConfig().debugMode).toBeUndefined()
    await openSettings('tools')
    expect(await $(`[data-testid="${TOGGLE}"]`).getAttribute('aria-checked')).toBe('false')
    await expectNoFileWritten()
  })

  it('writes the log without a restart once turned on, starting with the version and the OS', async () => {
    await setSettingsToggle(TOGGLE, true)
    await waitForVersionLine()
    expect(readAppConfig().debugMode).toBe(true)
  })

  it('removes every generation once turned off and writes nothing more', async () => {
    for (const generation of GENERATIONS.slice(1)) writeFileSync(logFile(generation), `older ${generation}\n`)
    expect(existingGenerations()).toEqual(GENERATIONS)
    await setSettingsToggle(TOGGLE, false)
    await waitForNoLogFiles('the log files were not removed')
    expect(readAppConfig().debugMode).toBe(false)
    await expectNoFileWritten()
  })

  it('is turned off by Reset Local Data › App Settings', async () => {
    await setSettingsToggle(TOGGLE, true)
    await waitForVersionLine()
    await closeSettings()
    const result = await vialApi<{ success: boolean }>('resetLocalTargets', {
      keyboards: false,
      favorites: false,
      appSettings: true,
    })
    expect(result.success).toBe(true)
    await waitForNoLogFiles('the reset did not remove the log files')
    expect(readAppConfig().debugMode).toBeUndefined()
    await expectNoFileWritten()
  })
})
