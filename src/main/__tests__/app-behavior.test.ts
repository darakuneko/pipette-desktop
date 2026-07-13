// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// vi.mock factories are hoisted above this file's own top-level statements
// (ESM evaluates static imports before the importer's body runs), so every
// value a factory closes over must come from vi.hoisted().
const {
  state,
  trayInstances,
  mockSetLoginItemSettings,
  mockQuit,
  mockCreateFromPath,
  mockBuildFromTemplate,
} = vi.hoisted(() => ({
  state: { homedir: '', isPackaged: true },
  trayInstances: [] as Array<{
    setToolTip: ReturnType<typeof vi.fn>
    setContextMenu: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    handlers: Map<string, () => void>
  }>,
  mockSetLoginItemSettings: vi.fn(),
  mockQuit: vi.fn(),
  mockCreateFromPath: vi.fn((path: string) => ({ __icon: path })),
  mockBuildFromTemplate: vi.fn((template: Array<{ type?: string; label?: string; enabled?: boolean; click?: () => void }>) => ({ __template: template })),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => state.homedir,
  }
})

vi.mock('electron', () => {
  const Tray = vi.fn().mockImplementation(() => {
    const handlers = new Map<string, () => void>()
    const instance = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        handlers.set(event, cb)
      }),
      destroy: vi.fn(),
      handlers,
    }
    trayInstances.push(instance)
    return instance
  })
  return {
    app: {
      get isPackaged() {
        return state.isPackaged
      },
      setLoginItemSettings: mockSetLoginItemSettings,
      quit: mockQuit,
    },
    Tray,
    Menu: {
      buildFromTemplate: mockBuildFromTemplate,
    },
    nativeImage: {
      createFromPath: mockCreateFromPath,
    },
  }
})

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

import { log } from '../logger'
import {
  applyAutoLaunch,
  autostartDesktopPath,
  setupTray,
  destroyTray,
  isTrayActive,
  showWindow,
  hideWindow,
  setWindowStartedHidden,
  getWindowStartedHidden,
  updateTrayStatus,
} from '../app-behavior'
import type { TrayStatus } from '../app-behavior'

const DISCONNECTED_STATUS: TrayStatus = { keyboardName: null, recording: false, count: 0, kpm: 0 }

/** Maps a captured menu template to its labels, using a stand-in string
 * for separator items (which carry no label) so assertions can compare
 * against a plain array. */
function templateLabels(template: Array<{ type?: string; label?: string }>): string[] {
  return template.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '')))
}

const mockLog = vi.mocked(log)

describe('applyAutoLaunch', () => {
  let testHome: string
  const originalAppImage = process.env.APPIMAGE

  beforeEach(async () => {
    vi.clearAllMocks()
    state.isPackaged = true
    testHome = await mkdtemp(join(tmpdir(), 'app-behavior-test-'))
    state.homedir = testHome
    delete process.env.APPIMAGE
  })

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true })
    if (originalAppImage === undefined) {
      delete process.env.APPIMAGE
    } else {
      process.env.APPIMAGE = originalAppImage
    }
  })

  it('is a no-op when unpackaged', () => {
    state.isPackaged = false
    applyAutoLaunch(true, 'linux')
    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()
    expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('unpackaged'))
  })

  it('calls setLoginItemSettings on win32', () => {
    applyAutoLaunch(true, 'win32')
    expect(mockSetLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  it('calls setLoginItemSettings on darwin', () => {
    applyAutoLaunch(false, 'darwin')
    expect(mockSetLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })

  it('does not write files on win32/darwin', async () => {
    applyAutoLaunch(true, 'win32')
    await expect(access(autostartDesktopPath())).rejects.toThrow()
  })

  it('writes an XDG autostart entry on linux using process.execPath by default', async () => {
    applyAutoLaunch(true, 'linux')
    const contents = await readFile(autostartDesktopPath(), 'utf-8')
    expect(contents).toContain('[Desktop Entry]')
    expect(contents).toContain('Name=Pipette')
    expect(contents).toContain(`Exec="${process.execPath}"`)
    expect(contents).toContain('X-GNOME-Autostart-enabled=true')
    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()
  })

  it('prefers APPIMAGE over process.execPath when set', async () => {
    process.env.APPIMAGE = '/opt/Pipette.AppImage'
    applyAutoLaunch(true, 'linux')
    const contents = await readFile(autostartDesktopPath(), 'utf-8')
    expect(contents).toContain('Exec="/opt/Pipette.AppImage"')
  })

  it('removes the autostart entry when disabled', async () => {
    applyAutoLaunch(true, 'linux')
    await expect(access(autostartDesktopPath())).resolves.toBeUndefined()

    applyAutoLaunch(false, 'linux')
    await expect(access(autostartDesktopPath())).rejects.toThrow()
  })

  it('does not throw when disabling an entry that never existed', () => {
    expect(() => applyAutoLaunch(false, 'linux')).not.toThrow()
    expect(mockLog).not.toHaveBeenCalledWith('error', expect.anything())
  })
})

describe('tray', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trayInstances.length = 0
    destroyTray()
    updateTrayStatus(DISCONNECTED_STATUS, () => null)
  })

  afterEach(() => {
    destroyTray()
    updateTrayStatus(DISCONNECTED_STATUS, () => null)
  })

  it('is inactive before setup', () => {
    expect(isTrayActive()).toBe(false)
  })

  it('creates a single Tray instance and marks it active', () => {
    setupTray(() => null)
    expect(trayInstances).toHaveLength(1)
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Pipette')
    expect(isTrayActive()).toBe(true)
  })

  it('is idempotent — calling setupTray again does not recreate the tray', () => {
    setupTray(() => null)
    setupTray(() => null)
    expect(trayInstances).toHaveLength(1)
  })

  it('destroy clears the singleton and is idempotent', () => {
    setupTray(() => null)
    destroyTray()
    expect(trayInstances[0].destroy).toHaveBeenCalled()
    expect(isTrayActive()).toBe(false)
    expect(() => destroyTray()).not.toThrow()
  })

  it('Show menu item shows and focuses the window', () => {
    const win = { show: vi.fn(), focus: vi.fn() }
    setupTray(() => win as unknown as Electron.BrowserWindow)

    const template = mockBuildFromTemplate.mock.calls[0][0]
    const showItem = template.find((item) => item.label === 'Show')
    expect(showItem).toBeDefined()
    showItem!.click!()

    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('Show menu item is a no-op when there is no window', () => {
    setupTray(() => null)
    const template = mockBuildFromTemplate.mock.calls[0][0]
    const showItem = template.find((item) => item.label === 'Show')
    expect(() => showItem!.click!()).not.toThrow()
  })

  it('Quit menu item calls app.quit', () => {
    setupTray(() => null)
    const template = mockBuildFromTemplate.mock.calls[0][0]
    const quitItem = template.find((item) => item.label === 'Quit')
    expect(quitItem).toBeDefined()
    quitItem!.click!()
    expect(mockQuit).toHaveBeenCalled()
  })

  it('tray click event shows and focuses the window, same as Show', () => {
    const win = { show: vi.fn(), focus: vi.fn() }
    setupTray(() => win as unknown as Electron.BrowserWindow)

    const clickHandler = trayInstances[0].handlers.get('click')
    expect(clickHandler).toBeDefined()
    clickHandler!()

    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })
})

describe('updateTrayStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trayInstances.length = 0
    destroyTray()
    updateTrayStatus(DISCONNECTED_STATUS, () => null)
  })

  afterEach(() => {
    destroyTray()
    updateTrayStatus(DISCONNECTED_STATUS, () => null)
  })

  it('is a no-op with no tray active, but still caches the status', () => {
    expect(() => updateTrayStatus({ keyboardName: 'GPK-63R', recording: false, count: 0, kpm: 0 }, () => null)).not.toThrow()
    expect(trayInstances).toHaveLength(0)

    // setupTray afterwards applies the cached status immediately.
    setupTray(() => null)
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Pipette — GPK-63R')
  })

  it('setupTray applies a status cached before the tray existed', () => {
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: true, count: 1234, kpm: 45 }, () => null)
    setupTray(() => null)
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Pipette — GPK-63R — Cnt 1,234 · KPM 45')
  })

  it('updates the tooltip to just "Pipette" when disconnected', () => {
    setupTray(() => null)
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: false, count: 0, kpm: 0 }, () => null)
    updateTrayStatus(DISCONNECTED_STATUS, () => null)
    expect(trayInstances[0].setToolTip).toHaveBeenLastCalledWith('Pipette')
  })

  it('formats the tooltip with the keyboard name when connected but not recording', () => {
    setupTray(() => null)
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: false, count: 0, kpm: 0 }, () => null)
    expect(trayInstances[0].setToolTip).toHaveBeenLastCalledWith('Pipette — GPK-63R')
  })

  it('formats the tooltip with Cnt/KPM and en-US thousands-separated numbers while recording', () => {
    setupTray(() => null)
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: true, count: 12345, kpm: 1234 }, () => null)
    expect(trayInstances[0].setToolTip).toHaveBeenLastCalledWith('Pipette — GPK-63R — Cnt 12,345 · KPM 1,234')
  })

  it('rebuilds the menu as Show / separator / Quit when disconnected', () => {
    setupTray(() => null)
    updateTrayStatus(DISCONNECTED_STATUS, () => null)
    const template = mockBuildFromTemplate.mock.calls.at(-1)![0]
    expect(templateLabels(template)).toEqual(['Show', '---', 'Quit'])
  })

  it('rebuilds the menu with a disabled name row between two separators when connected but not recording', () => {
    setupTray(() => null)
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: false, count: 0, kpm: 0 }, () => null)
    const template = mockBuildFromTemplate.mock.calls.at(-1)![0]
    expect(templateLabels(template)).toEqual(['Show', '---', 'GPK-63R', '---', 'Quit'])
    expect(template.find((item) => item.label === 'GPK-63R')?.enabled).toBe(false)
  })

  it('rebuilds the menu with disabled name, Recording, Cnt and KPM rows while recording', () => {
    setupTray(() => null)
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: true, count: 42, kpm: 20 }, () => null)
    const template = mockBuildFromTemplate.mock.calls.at(-1)![0]
    expect(templateLabels(template)).toEqual(['Show', '---', 'GPK-63R', 'Recording', 'Cnt 42', 'KPM 20', '---', 'Quit'])
    expect(template.find((item) => item.label === 'Recording')?.enabled).toBe(false)
    expect(template.find((item) => item.label === 'Cnt 42')?.enabled).toBe(false)
    expect(template.find((item) => item.label === 'KPM 20')?.enabled).toBe(false)
  })

  it('the rebuilt Show item still shows and focuses the window', () => {
    const win = { show: vi.fn(), focus: vi.fn() }
    const getWindow = () => win as unknown as Electron.BrowserWindow
    setupTray(getWindow)
    updateTrayStatus({ keyboardName: 'GPK-63R', recording: true, count: 1, kpm: 1 }, getWindow)

    const template = mockBuildFromTemplate.mock.calls.at(-1)![0]
    const showItem = template.find((item) => item.label === 'Show')
    showItem!.click!()

    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })
})

describe('showWindow', () => {
  it('shows and focuses the window when one exists', () => {
    const win = { show: vi.fn(), focus: vi.fn() }
    showWindow(() => win as unknown as Electron.BrowserWindow)
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('is a no-op when there is no window', () => {
    expect(() => showWindow(() => null)).not.toThrow()
  })
})

describe('hideWindow', () => {
  beforeEach(() => {
    destroyTray()
  })

  afterEach(() => {
    destroyTray()
  })

  it('is a no-op when the tray is inactive', () => {
    const win = { hide: vi.fn() }
    hideWindow(() => win as unknown as Electron.BrowserWindow)
    expect(win.hide).not.toHaveBeenCalled()
  })

  it('hides the window when the tray is active', () => {
    setupTray(() => null)
    const win = { hide: vi.fn() }
    hideWindow(() => win as unknown as Electron.BrowserWindow)
    expect(win.hide).toHaveBeenCalled()
  })

  it('is a no-op when the tray is active but there is no window', () => {
    setupTray(() => null)
    expect(() => hideWindow(() => null)).not.toThrow()
  })
})

describe('window started-hidden flag', () => {
  afterEach(() => {
    setWindowStartedHidden(false)
  })

  it('defaults to false', () => {
    expect(getWindowStartedHidden()).toBe(false)
  })

  it('reflects the value recorded at window creation', () => {
    setWindowStartedHidden(true)
    expect(getWindowStartedHidden()).toBe(true)
    setWindowStartedHidden(false)
    expect(getWindowStartedHidden()).toBe(false)
  })
})
