// SPDX-License-Identifier: GPL-2.0-or-later
// The `electron` module of the resident fixture generators (harness.ts):
// windows, the tray, menus, the screen and the app as far as
// src/main/index.ts and app-behavior.ts use them, recording every call that
// changes something. Nothing here reaches the OS.
//
// The windows model an obedient window manager: `setBounds` applies exactly
// what it is given, a window built without a position is centred on the
// primary display's work area, and the content area is the bounds minus the
// harness frame (`frame`), with the frame on the top and left.

import { vi } from 'vitest'
import { relative } from 'node:path'
import { REPO_ROOT } from '../fixture-vitest-config'
import {
  harnessPath,
  harnessState,
  record,
  scriptedFetch,
  type Display,
  type HarnessTray,
  type HarnessWindow,
  type MenuItem,
  type Rect,
} from './harness'

type Listener = (...args: unknown[]) => void

function addListener(map: Map<string, Listener[]>, event: string, listener: Listener): void {
  map.set(event, [...(map.get(event) ?? []), listener])
}

function emitTo(map: Map<string, Listener[]>, event: string, args: unknown[]): void {
  for (const listener of map.get(event) ?? []) listener(...args)
}

// --- app ---

export const app = {
  get isPackaged(): boolean {
    return harnessState().isPackaged
  },
  setDesktopName: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  exit: vi.fn((code: number) => record('app.exit', code)),
  quit: vi.fn(() => record('app.quit')),
  isReady: vi.fn(() => true),
  on: vi.fn((event: string, listener: Listener) => {
    addListener(harnessState().appListeners, event, listener)
  }),
  whenReady: vi.fn(() => ({
    then: (callback: () => void) => {
      harnessState().readyCallbacks.push(callback)
      return Promise.resolve()
    },
  })),
  setLoginItemSettings: vi.fn((settings: unknown) => record('app.setLoginItemSettings', settings)),
  getPath: vi.fn((name: string) => harnessPath(name)),
  getName: vi.fn(() => 'pipette-desktop'),
  getVersion: vi.fn(() => '0.0.0-fixture'),
  commandLine: { appendSwitch: vi.fn() },
}

/** Emits an app event (`second-instance`, `activate`, `window-all-closed`,
 *  `before-quit`) to the listeners index.ts registered. */
export function emitAppEvent(event: string, ...args: unknown[]): void {
  emitTo(harnessState().appListeners, event, args)
}

// --- screen ---

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

export const screen = {
  getPrimaryDisplay: vi.fn((): Display => harnessState().displays[0]),
  getAllDisplays: vi.fn((): Display[] => harnessState().displays),
  /** The display the rect overlaps most; the primary one when it overlaps
   *  none. */
  getDisplayMatching: vi.fn((rect: Rect): Display => {
    const displays = harnessState().displays
    let best = displays[0]
    let bestArea = 0
    for (const display of displays) {
      const area = overlap(rect, display.bounds)
      if (area > bestArea) {
        best = display
        bestArea = area
      }
    }
    return best
  }),
  on: vi.fn((event: string, listener: Listener) => {
    addListener(harnessState().screenListeners, event, listener)
  }),
  removeListener: vi.fn((event: string, listener: Listener) => {
    const map = harnessState().screenListeners
    map.set(event, (map.get(event) ?? []).filter((l) => l !== listener))
  }),
}

/** Changes the displays and emits `display-metrics-changed`. */
export function changeDisplays(displays: Display[]): void {
  harnessState().displays = displays
  emitTo(harnessState().screenListeners, 'display-metrics-changed', [{}, displays[0], ['workArea']])
}

// --- BrowserWindow ---

class FakeWebContents {
  readonly window: FakeWindow
  constructor(window: FakeWindow) {
    this.window = window
  }
  send(channel: string, ...args: unknown[]): void {
    record('webContents.send', channel, ...args)
  }
  on(): void {}
  setWindowOpenHandler(): void {}
  openDevTools(): void {}
  setZoomFactor(factor: number): void {
    record('webContents.setZoomFactor', factor)
  }
}

class FakeWindow implements HarnessWindow {
  readonly webContents: FakeWebContents
  readonly frame: { width: number; height: number }
  bounds: Rect
  visible: boolean
  minimized = false
  maximized = false
  fullScreen = false
  destroyed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(options: Record<string, unknown>) {
    const state = harnessState()
    const { webPreferences: _webPreferences, icon, ...rest } = options
    record('BrowserWindow.new', { ...rest, icon: typeof icon === 'string' ? relative(REPO_ROOT, icon) : icon })
    this.webContents = new FakeWebContents(this)
    this.frame = { ...state.frame }
    const width = options.width as number
    const height = options.height as number
    const workArea = state.displays[0].workArea
    this.bounds = {
      x: typeof options.x === 'number' ? options.x : workArea.x + Math.round((workArea.width - width) / 2),
      y: typeof options.y === 'number' ? options.y : workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    }
    this.visible = options.show !== false
    state.windows.push(this)
  }

  static getAllWindows(): FakeWindow[] {
    return harnessState().windows.filter((w): w is FakeWindow => w instanceof FakeWindow && !w.destroyed)
  }

  static fromWebContents(contents: unknown): FakeWindow | null {
    return contents instanceof FakeWebContents && !contents.window.destroyed ? contents.window : null
  }

  on(event: string, listener: Listener): this {
    addListener(this.listeners, event, listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    emitTo(this.listeners, event, args)
  }

  getBounds(): Rect {
    return { ...this.bounds }
  }

  getContentBounds(): Rect {
    const { x, y, width, height } = this.bounds
    return { x: x + this.frame.width, y: y + this.frame.height, width: width - this.frame.width, height: height - this.frame.height }
  }

  getSize(): [number, number] {
    return [this.bounds.width, this.bounds.height]
  }

  setBounds(bounds: Partial<Rect>): void {
    record('window.setBounds', bounds)
    this.bounds = { ...this.bounds, ...bounds }
  }

  setMinimumSize(width: number, height: number): void {
    record('window.setMinimumSize', width, height)
  }

  setAspectRatio(ratio: number, extraSize?: { width: number; height: number }): void {
    if (extraSize === undefined) record('window.setAspectRatio', ratio)
    else record('window.setAspectRatio', ratio, extraSize)
  }

  setAlwaysOnTop(flag: boolean): void {
    record('window.setAlwaysOnTop', flag)
  }

  setOpacity(opacity: number): void {
    record('window.setOpacity', opacity)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    record('window.destroy')
    this.destroyed = true
    this.emit('closed')
  }

  isMaximized(): boolean {
    return this.maximized
  }

  isFullScreen(): boolean {
    return this.fullScreen
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  show(): void {
    record('window.show')
    const wasVisible = this.visible
    this.visible = true
    if (!wasVisible) this.emit('show')
  }

  hide(): void {
    record('window.hide')
    const wasVisible = this.visible
    this.visible = false
    if (wasVisible) this.emit('hide')
  }

  focus(): void {
    record('window.focus')
  }

  restore(): void {
    record('window.restore')
    this.minimized = false
  }

  loadURL(): void {}
  loadFile(): void {}
}

export const BrowserWindow = FakeWindow

// --- Tray, Menu, nativeImage ---

interface FakeMenu {
  items: MenuItem[]
  popup(): void
}

export const Menu = {
  setApplicationMenu: vi.fn((menu: unknown) => record('Menu.setApplicationMenu', menu)),
  buildFromTemplate: vi.fn((items: MenuItem[]): FakeMenu => ({ items, popup: () => undefined })),
}

export const nativeImage = {
  createFromPath: vi.fn((path: string) => ({ path: relative(REPO_ROOT, path) })),
}

/** A menu item as the golden files hold it: what is shown, and whether a
 *  click does something. */
export function describeMenuItem(item: MenuItem): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (item.type !== undefined) out.type = item.type
  if (item.label !== undefined) out.label = item.label
  if (item.enabled !== undefined) out.enabled = item.enabled
  if (item.click !== undefined) out.click = true
  return out
}

class FakeTray implements HarnessTray {
  destroyed = false
  menu: MenuItem[] | null = null
  private readonly listeners = new Map<string, Listener[]>()
  private readonly index: number

  constructor(image: { path: string }) {
    const state = harnessState()
    this.index = state.trays.length
    record('Tray.new', this.index, image)
    state.trays.push(this)
  }

  setToolTip(text: string): void {
    record('tray.setToolTip', this.index, text)
  }

  setContextMenu(menu: FakeMenu): void {
    this.menu = menu.items
    record('tray.setContextMenu', this.index, menu.items.map(describeMenuItem))
  }

  on(event: string, listener: Listener): void {
    addListener(this.listeners, event, listener)
  }

  emit(event: string): void {
    emitTo(this.listeners, event, [])
  }

  destroy(): void {
    record('tray.destroy', this.index)
    this.destroyed = true
  }
}

export const Tray = FakeTray

// --- The rest index.ts touches ---

export const session = {
  defaultSession: { webRequest: { onHeadersReceived: vi.fn() } },
}

export const shell = {
  openExternal: vi.fn(async (url: string) => {
    throw new Error(`resident fixture harness: refused to open ${url}`)
  }),
}

export const net = {
  fetch: vi.fn((input: string | URL | Request, init?: RequestInit) => scriptedFetch(input, init)),
}

export const ipcMain = {
  handle: vi.fn(() => {
    throw new Error('resident fixture harness: ipcMain is reached only through ipc-guard')
  }),
  on: vi.fn(() => {
    throw new Error('resident fixture harness: ipcMain is reached only through ipc-guard')
  }),
}
