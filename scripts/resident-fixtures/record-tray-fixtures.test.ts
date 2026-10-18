// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the tray of the Tauri app (src-tauri/tests): boots
// Electron's src/main/index.ts on the harness and records, through the
// TRAY_STATUS_UPDATE handler and the config listener, what the tray shows —
// the tooltip and the context-menu template — for a sequence of statuses,
// the trayResident toggles, the menu's clicks, the close / quit paths, the
// number format of the Cnt / KPM rows (`toLocaleString('en-US')`) and which
// JSON values pass `isValidTrayStatus`.
//
// Run: pnpm run generate:resident-fixtures

import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { writeJsonFixture } from '../fixture-files'
import { random32 } from '../fixture-random'
import { boot } from './boot'
import { emitAppEvent } from './electron-mock'
import { changeConfig, harnessState, invoke, type RecordedCall } from './harness'
import { residentFixturePath, step, takeRecorded, type Scenario, type Step } from './steps'

const OUT = residentFixturePath('tray.json')

interface Status {
  keyboardName: string | null
  recording: boolean
  count: number
  kpm: number
}

const status = (keyboardName: string | null, recording: boolean, count = 0, kpm = 0): Status => ({ keyboardName, recording, count, kpm })

const update = (value: unknown): Promise<Step> =>
  step({ trayStatusUpdate: value }, () => invoke(IpcChannels.TRAY_STATUS_UPDATE, value))

const configChange = (key: string, value: unknown): Promise<Step> =>
  step({ configChange: { key, value } }, () => changeConfig(key, value))

function liveTray(): NonNullable<ReturnType<typeof harnessState>['trays'][number]> {
  const tray = harnessState().trays.at(-1)
  if (tray === undefined || tray.destroyed) throw new Error('no live tray')
  return tray
}

const clickMenu = (label: string): Promise<Step> =>
  step({ menuClick: label }, () => {
    const item = liveTray().menu?.find((i) => i.label === label)
    if (item?.click === undefined) throw new Error(`no clickable ${label}`)
    item.click()
  })

const trayClick = (): Promise<Step> => step({ trayClick: true }, () => liveTray().emit('click'))

/** The window's `close` event; `prevented` tells whether the handler kept
 *  the window. */
const closeWindow = (): Promise<Step> =>
  step({ windowClose: true }, () => {
    let prevented = false
    harnessState().windows[0].emit('close', { preventDefault: () => (prevented = true) })
    return { prevented }
  })

const appEvent = (event: string): Promise<Step> => step({ appEvent: event }, () => emitAppEvent(event))

async function scenario(name: string, config: Record<string, unknown>, steps: () => Promise<Step[]>): Promise<Scenario> {
  await boot({ config })
  const bootCalls = takeRecorded().calls
  // The saved state is the boot default (no saved position): the window's
  // first bounds come from the mock centring it on the display's work area,
  // and the bounds saved on close follow from them.
  const state = harnessState()
  const bootInfo = {
    config,
    windowState: state.windowState,
    displays: state.displays,
    initialBounds: state.windows[0].getBounds(),
  }
  return { name, boot: bootInfo, bootCalls, steps: await steps() }
}

const KB = 'GPK60-63R'

async function recordScenarios(): Promise<Scenario[]> {
  const out: Scenario[] = []
  out.push(
    await scenario('statuses on a tray created at boot', { trayResident: true }, async () => [
      await update(status(KB, false)),
      await update(status(KB, true, 1234, 56)),
      await update(status(KB, true, 1235, 57.5)),
      await update(status('Other keyboard', true, 1235, 57.5)),
      await update(status('Other keyboard', false, 1235, 57.5)),
      await update(status('', true, 10, 2)),
      await update(status('', false, 10, 2)),
      await update(status(null, true, 3, 1)),
      await update(status(null, false, 0, 0)),
      await update(status(KB, true, 7, 8)),
      // Dropped by isValidTrayStatus: the tray keeps the last status.
      await update({ keyboardName: 1, recording: true, count: 0, kpm: 0 }),
      await update(null),
      await update(status('  spaced  name  ', true, 0, 0)),
    ]),
  )
  out.push(
    await scenario('trayResident toggled while statuses arrive', { trayResident: false }, async () => [
      await update(status(KB, true, 99, 12)),
      await configChange('trayResident', true),
      await update(status(KB, true, 100, 13)),
      await configChange('trayResident', true),
      await configChange('trayResident', false),
      await update(status('After destroy', false)),
      await configChange('trayResident', false),
      await configChange('trayResident', true),
      await update({ keyboardName: 'x' }),
      await configChange('trayResident', false),
      await configChange('trayResident', true),
    ]),
  )
  out.push(
    await scenario('menu and tray clicks, close and quit with the tray', { trayResident: true }, async () => [
      await update(status(KB, false)),
      await closeWindow(),
      await step({ ipc: 'WINDOW_IS_VISIBLE' }, () => invoke(IpcChannels.WINDOW_IS_VISIBLE)),
      await clickMenu('Show'),
      await closeWindow(),
      await trayClick(),
      await step({ ipc: 'WINDOW_HIDE' }, () => invoke(IpcChannels.WINDOW_HIDE)),
      await step({ ipc: 'WINDOW_SHOW' }, () => invoke(IpcChannels.WINDOW_SHOW)),
      await step({ ipc: 'WINDOW_SHOW' }, () => invoke(IpcChannels.WINDOW_SHOW)),
      await appEvent('second-instance'),
      await appEvent('window-all-closed'),
      await clickMenu('Quit'),
      await appEvent('before-quit'),
      await closeWindow(),
    ]),
  )
  out.push(
    await scenario('close and quit without the tray', { trayResident: false }, async () => [
      await closeWindow(),
      await step({ ipc: 'WINDOW_HIDE' }, () => invoke(IpcChannels.WINDOW_HIDE)),
      await appEvent('window-all-closed'),
    ]),
  )
  for (const config of [
    { startInTray: true, trayResident: true },
    { startInTray: true, trayResident: false },
    { startInTray: false, trayResident: true },
  ]) {
    out.push(
      await scenario(`start in tray: ${JSON.stringify(config)}`, config, async () => [
        await step({ ipc: 'WINDOW_STARTED_HIDDEN' }, () => invoke(IpcChannels.WINDOW_STARTED_HIDDEN)),
        await step({ ipc: 'WINDOW_IS_VISIBLE' }, () => invoke(IpcChannels.WINDOW_IS_VISIBLE)),
        await step({ ipc: 'WINDOW_SHOW' }, () => invoke(IpcChannels.WINDOW_SHOW)),
        await step({ ipc: 'WINDOW_STARTED_HIDDEN' }, () => invoke(IpcChannels.WINDOW_STARTED_HIDDEN)),
      ]),
    )
  }
  return out
}

/** Numbers for the Cnt / KPM rows: integers around the group separator,
 *  decimals around the third fractional digit (where `toLocaleString`
 *  rounds), negatives, and the ends of the double range. */
const FIXED_NUMBERS = [
  0, 1, 9, 10, 99, 100, 999, 1000, 1001, 9999, 10000, 99999, 100000, 999999, 1000000, 1234567, 12345678, 123456789,
  2147483647, 4294967296, 9007199254740991, 9007199254740992, 1e15, 1e16, 1e20, 1e21, 1.5e21, 1e22, 1e100, 1.7976931348623157e308,
  0.1, 0.5, 1.5, 2.5, 12.3456, 12.3454, 12.3455, 0.0005, 0.0004, 0.0006, 0.0015, 0.0025, 1.0005, 1.0004, 2.0005, 0.9995, 0.9994,
  9.9995, 999.9995, 999.9994, 1234.5678, 0.001, 0.0001, 1e-7, 5e-324, 1.23e-10, 123456.7891, 0.30000000000000004, 1 / 3, 2 / 3,
  -1, -999, -1000, -1234567, -12.3456, -0.0004, -0.0005, -0.0006, -0.5, -1e21, -1.7976931348623157e308, 57.5, 56.25, 60.125,
]

function randomNumbers(count: number): number[] {
  const next = random32(0x7a4c)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const magnitude = 10 ** ((next() % 13) - 4)
    const value = (next() / 0x100000000) * magnitude
    const kind = next() % 4
    const n = kind === 0 ? Math.round(value) : kind === 1 ? Math.round(value * 1000) / 1000 : kind === 2 ? -value : value
    out.push(n)
  }
  return out
}

/** The Cnt row the tray shows for `count`, read back from the booted tray. */
async function formatThroughTray(count: number): Promise<{ value: number; text: string }> {
  takeRecorded()
  await invoke(IpcChannels.TRAY_STATUS_UPDATE, status(KB, true, count, 0))
  const menu = takeRecorded().calls.find((c: RecordedCall) => c.call === 'tray.setContextMenu')
  const rows = (menu?.args[1] ?? []) as { label?: string }[]
  const label = rows.find((r) => r.label?.startsWith('Cnt: '))?.label
  if (label === undefined) throw new Error(`no Cnt row for ${count}`)
  const text = label.slice('Cnt: '.length)
  expect(text).toBe(count.toLocaleString('en-US'))
  return { value: count, text }
}

/** JSON values sent as the status: the shape check either takes them (the
 *  tray is rebuilt) or drops them (nothing happens). */
const VALIDITY_INPUTS: unknown[] = [
  null, true, 0, 'status', [], [null, false, 0, 0], {},
  { keyboardName: null, recording: false, count: 0, kpm: 0 },
  { keyboardName: 'K', recording: true, count: 1, kpm: 2 },
  { keyboardName: '', recording: false, count: -1, kpm: 0.5 },
  { keyboardName: 'K', recording: false, count: 0, kpm: 0, extra: 'ignored' },
  { recording: false, count: 0, kpm: 0 },
  { keyboardName: 'K', count: 0, kpm: 0 },
  { keyboardName: 'K', recording: false, kpm: 0 },
  { keyboardName: 'K', recording: false, count: 0 },
  { keyboardName: 1, recording: false, count: 0, kpm: 0 },
  { keyboardName: false, recording: false, count: 0, kpm: 0 },
  { keyboardName: {}, recording: false, count: 0, kpm: 0 },
  { keyboardName: 'K', recording: 'true', count: 0, kpm: 0 },
  { keyboardName: 'K', recording: 1, count: 0, kpm: 0 },
  { keyboardName: 'K', recording: null, count: 0, kpm: 0 },
  { keyboardName: 'K', recording: false, count: '1', kpm: 0 },
  { keyboardName: 'K', recording: false, count: null, kpm: 0 },
  { keyboardName: 'K', recording: false, count: 0, kpm: '0' },
  { keyboardName: 'K', recording: false, count: 0, kpm: null },
  { keyboardName: 'K', recording: false, count: [1], kpm: 0 },
  { keyboardName: 'K', recording: false, count: 1e308, kpm: -1e308 },
]

async function validity(input: unknown): Promise<{ input: unknown; valid: boolean }> {
  await invoke(IpcChannels.TRAY_STATUS_UPDATE, status('baseline', false))
  takeRecorded()
  await invoke(IpcChannels.TRAY_STATUS_UPDATE, input)
  const valid = takeRecorded().calls.some((c) => c.call === 'tray.setContextMenu')
  return { input, valid }
}

describe('tray', () => {
  it('records the tray of index.ts', async () => {
    const scenarios = await recordScenarios()

    await boot({ config: { trayResident: true } })
    const formatCount: { value: number; text: string }[] = []
    for (const n of [...FIXED_NUMBERS, ...randomNumbers(200)]) formatCount.push(await formatThroughTray(n))
    const isValidTrayStatus: { input: unknown; valid: boolean }[] = []
    for (const input of VALIDITY_INPUTS) isValidTrayStatus.push(await validity(input))

    writeJsonFixture(OUT, {
      source: 'src/main/index.ts and app-behavior.ts booted on scripts/resident-fixtures; calls of the Electron Tray, Menu and BrowserWindow',
      scenarios,
      formatCount,
      isValidTrayStatus,
    })
  })
})
