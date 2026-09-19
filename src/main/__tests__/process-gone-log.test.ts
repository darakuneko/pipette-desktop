// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLog, appHandlers } = vi.hoisted(() => ({
  mockLog: vi.fn(),
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
}))

vi.mock('../logger', () => ({
  log: mockLog,
}))

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      appHandlers.set(event, cb)
    }),
  },
}))

import {
  formatRenderProcessGone,
  formatChildProcessGone,
  describeMainFrameState,
  registerProcessGoneLogging,
  registerChildProcessGoneLogging,
} from '../process-gone-log'

/** Minimal EventEmitter stand-in: register with `on`, trigger with `emit`. */
class FakeEmitter {
  private handlers = new Map<string, Array<(...args: never[]) => void>>()

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      ;(cb as (...args: unknown[]) => void)(...args)
    }
  }
}

type FakeWebContents = FakeEmitter & { mainFrame: unknown }

type FakeWin = FakeEmitter & {
  webContents: FakeWebContents
  isVisible: () => boolean
  isMinimized: () => boolean
}

/** Builds a `FakeWin` whose `isVisible`/`isMinimized` throw, simulating a
 * window torn down mid-quit. */
function registeredWinWithThrowingVisibility(): FakeWin {
  const win = new FakeEmitter() as FakeWin
  win.webContents = makeWebContents()
  win.isVisible = () => {
    throw new Error('Object has been destroyed')
  }
  win.isMinimized = () => {
    throw new Error('Object has been destroyed')
  }
  registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
  return win
}

/** Builds a `FakeWin` whose `webContents` getter throws once read after
 * registration, simulating a window destroyed between setup and a later
 * `show` event. Registration itself needs a working `webContents` to attach
 * the render-process-gone/unresponsive/responsive listeners. */
function registeredWinWithThrowingWebContents(): FakeWin {
  const win = new FakeEmitter() as FakeWin
  win.webContents = makeWebContents()
  registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
  Object.defineProperty(win, 'webContents', {
    get: () => {
      throw new Error('Object has been destroyed')
    },
  })
  return win
}

function makeMainFrame(opts: { destroyed?: boolean; detached?: boolean } = {}): unknown {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    detached: opts.detached ?? false,
  }
}

/** Pass an `Error` as `mainFrame` to make the getter throw. */
function makeWebContents(mainFrame: unknown = makeMainFrame()): FakeWebContents {
  const wc = new FakeEmitter() as FakeWebContents
  Object.defineProperty(wc, 'mainFrame', {
    get: () => {
      if (mainFrame instanceof Error) throw mainFrame
      return mainFrame
    },
  })
  return wc
}

function frameStateOf(mainFrame: unknown): string {
  const webContents = makeWebContents(mainFrame) as unknown as Electron.WebContents
  return describeMainFrameState(() => webContents)
}

/** Fake window with the module's window handlers already registered on it. */
function registeredWin(mainFrame?: unknown): FakeWin {
  const win = new FakeEmitter() as FakeWin
  win.webContents = makeWebContents(mainFrame)
  win.isVisible = () => true
  win.isMinimized = () => false
  registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
  return win
}

/** Registers the app-wide handler and returns it. */
function registeredChildHandler(): (...args: unknown[]) => void {
  registerChildProcessGoneLogging()
  const handler = appHandlers.get('child-process-gone')
  expect(handler).toBeDefined()
  return handler!
}

describe('formatRenderProcessGone', () => {
  it('includes reason, exitCode, visible, minimized and uptime', () => {
    const line = formatRenderProcessGone(
      { reason: 'crashed', exitCode: 1 } as Electron.RenderProcessGoneDetails,
      { visible: true, minimized: false, uptimeSec: 42 },
    )
    expect(line).toContain('crashed')
    expect(line).toContain('1')
    expect(line).toContain('visible=true')
    expect(line).toContain('minimized=false')
    expect(line).toContain('42')
  })
})

describe('formatChildProcessGone', () => {
  it('includes type, reason, exitCode, serviceName and name when present', () => {
    const line = formatChildProcessGone({
      type: 'Utility',
      reason: 'killed',
      exitCode: 9,
      serviceName: 'Network Service',
      name: 'network',
    } as Electron.Details)
    expect(line).toContain('Utility')
    expect(line).toContain('killed')
    expect(line).toContain('9')
    expect(line).toContain('Network Service')
    expect(line).toContain('network')
    expect(line).not.toContain('undefined')
  })

  it('omits serviceName and name when undefined, without printing "undefined"', () => {
    const line = formatChildProcessGone({
      type: 'GPU',
      reason: 'crashed',
      exitCode: 1,
    } as Electron.Details)
    expect(line).toContain('GPU')
    expect(line).not.toContain('undefined')
  })
})

describe('describeMainFrameState', () => {
  it('returns "destroyed" when the frame is destroyed', () => {
    expect(frameStateOf(makeMainFrame({ destroyed: true }))).toBe('destroyed')
  })

  it('returns "detached" when the frame is detached but not destroyed', () => {
    expect(frameStateOf(makeMainFrame({ detached: true }))).toBe('detached')
  })

  it('returns "available" when the frame is neither destroyed nor detached', () => {
    expect(frameStateOf(makeMainFrame())).toBe('available')
  })

  it('returns "threw: <message>" when accessing mainFrame throws', () => {
    expect(frameStateOf(new Error('Render frame was disposed'))).toBe('threw: Render frame was disposed')
  })
})

describe('registerProcessGoneLogging', () => {
  beforeEach(() => {
    mockLog.mockClear()
  })

  it('logs render-process-gone at error level for a non-clean-exit reason', () => {
    const win = registeredWin()
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('crashed'))
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('visible=true'))
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('minimized=false'))
  })

  it('logs render-process-gone at info level for a clean-exit reason', () => {
    const win = registeredWin()
    win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('info', expect.stringContaining('clean-exit'))
  })

  it('logs unresponsive at warn level', () => {
    const win = registeredWin()
    win.webContents.emit('unresponsive')
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('warn', expect.any(String))
  })

  it('logs responsive at info level', () => {
    const win = registeredWin()
    win.webContents.emit('responsive')
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('info', expect.any(String))
  })

  it('logs a warn line on show when the main frame is not available', () => {
    const win = registeredWin(makeMainFrame({ destroyed: true }))
    win.emit('show')
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('destroyed'))
  })

  it('does not log on show when the main frame is available', () => {
    const win = registeredWin()
    win.emit('show')
    expect(mockLog).not.toHaveBeenCalled()
  })

  it.each([
    ['render-process-gone', () => registeredWin(), [{}, { reason: 'crashed', exitCode: 1 }]] as const,
    ['unresponsive', () => registeredWin(), []] as const,
    ['responsive', () => registeredWin(), []] as const,
    ['show', () => registeredWin(makeMainFrame({ destroyed: true })), []] as const,
  ])('never throws out of the %s handler when the logger throws', (event, buildWin, args) => {
    mockLog.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const win = buildWin()
    const emitter = event === 'show' ? win : win.webContents
    expect(() => emitter.emit(event, ...args)).not.toThrow()
  })

  it('logs render-process-gone with an unknown window context when isVisible/isMinimized throw', () => {
    const win = registeredWinWithThrowingVisibility()
    expect(() => win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })).not.toThrow()
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/visible=unknown.*minimized=unknown|minimized=unknown.*visible=unknown/),
    )
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('crashed'))
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringMatching(/uptimeSec=\d+/))
  })

  it('logs a warn line on show when reading webContents throws', () => {
    const win = registeredWinWithThrowingWebContents()
    expect(() => win.emit('show')).not.toThrow()
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('threw:'))
  })
})

describe('registerChildProcessGoneLogging', () => {
  beforeEach(() => {
    mockLog.mockClear()
    appHandlers.clear()
  })

  it('registers a child-process-gone handler that logs via the shared logger', () => {
    const handler = registeredChildHandler()
    handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('GPU'))
  })

  it('logs at info level for a clean-exit child process reason', () => {
    const handler = registeredChildHandler()
    handler({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 })
    expect(mockLog).toHaveBeenCalledWith('info', expect.any(String))
  })

  it('never throws when the logger throws', () => {
    mockLog.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const handler = registeredChildHandler()
    expect(() => handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })).not.toThrow()
  })
})
