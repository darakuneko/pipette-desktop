// SPDX-License-Identifier: GPL-2.0-or-later
// The resident fixture harness keeps Electron's main process away from the
// notice endpoint, the real HOME (and so the real autostart entry), the real
// userData and the browser.
//
// Run: pnpm run test:resident-fixtures-harness

import { mkdirSync, symlinkSync } from 'node:fs'
import { homedir as realHomedirOfTest } from 'node:os'
import { join } from 'node:path'
import { app, net, shell } from 'electron'
import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { boot } from './boot'
import { harnessState, invoke, realHome, useHome, useTemporaryHome, useUserData } from './harness'

describe('the resident fixture harness', () => {
  it('knows the real HOME and answers os.homedir() only with a temporary one', () => {
    expect(realHome()).not.toBe('')
    expect(() => realHomedirOfTest()).toThrow(/before useTemporaryHome/)
    const home = useTemporaryHome()
    expect(realHomedirOfTest()).toBe(home)
  })

  it('refuses the real HOME, a directory in it and a link to it', () => {
    for (const dir of [realHome(), join(realHome(), '.config'), join(realHome(), '.config', 'autostart')]) {
      useHome(dir)
      expect(() => realHomedirOfTest(), dir).toThrow(/refused the real HOME/)
    }
    const temp = useTemporaryHome()
    const link = join(temp, 'link')
    symlinkSync(realHome(), link)
    useHome(link)
    expect(() => realHomedirOfTest()).toThrow(/refused the real HOME/)
  })

  it('refuses the real userData of Pipette and of Electron', () => {
    for (const dir of ['pipette-desktop', 'Electron', 'Electron/sub']) {
      useUserData(join(realHome(), '.config', dir))
      expect(() => app.getPath('userData'), dir).toThrow(/refused the real userData/)
    }
    useUserData(null)
    expect(app.getPath('userData')).toMatch(/pipette-resident-userdata-/)
  })

  it('never sends a request', async () => {
    await expect(net.fetch('https://getnotifications-svtx62766a-uc.a.run.app', { method: 'POST' })).rejects.toThrow(
      /refused an unscripted request/,
    )
    for (const url of ['https://getnotifications-svtx62766a-uc.a.run.app', 'http://127.0.0.1:1/']) {
      await expect(fetch(url), url).rejects.toThrow(/refused a request/)
    }
    expect(harnessState().requests).toEqual([])
  })

  it('opens nothing in the browser', async () => {
    await expect(shell.openExternal('https://example.com/')).rejects.toThrow(/refused to open/)
  })

  it('stops the notice fetch of the booted app before it leaves', async () => {
    await boot()
    expect(await invoke(IpcChannels.NOTIFICATION_FETCH)).toEqual({
      success: false,
      error: 'Error: resident fixture harness: refused an unscripted request to https://getnotifications-svtx62766a-uc.a.run.app',
    })
  })

  it('stops the autostart entry of the booted app without a temporary HOME', async () => {
    await expect(boot({ isPackaged: true, config: { autoLaunch: true } })).rejects.toThrow(/before useTemporaryHome/)
    useHome(realHome())
    await expect(boot({ isPackaged: true, config: { autoLaunch: false } })).rejects.toThrow(/refused the real HOME/)
  })

  it('writes the autostart entry under the temporary HOME', async () => {
    const home = useTemporaryHome()
    mkdirSync(join(home, '.config'))
    await boot({ isPackaged: true, config: { autoLaunch: true } })
    expect(harnessState().logs).toEqual([{ level: 'info', message: 'Pipette starting' }])
  })

  it('boots index.ts with every resident handler kept', async () => {
    await boot()
    const channels = [...harnessState().handlers.keys()]
    for (const channel of [
      IpcChannels.TRAY_STATUS_UPDATE,
      IpcChannels.NOTIFICATION_FETCH,
      IpcChannels.WINDOW_SET_COMPACT_MODE,
      IpcChannels.WINDOW_SET_ASPECT_RATIO,
      IpcChannels.WINDOW_SET_ALWAYS_ON_TOP,
      IpcChannels.WINDOW_SET_OPACITY,
      IpcChannels.WINDOW_SET_MIN_SIZE,
      IpcChannels.WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED,
    ]) {
      expect(channels).toContain(channel)
    }
    expect(harnessState().windows).toHaveLength(1)
  })
})
