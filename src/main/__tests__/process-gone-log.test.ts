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

/** Minimal EventEmitter-style fake — enough to register a handler with
 * `on` and trigger it with `emit`, without pulling in node's EventEmitter
 * (whose extra surface isn't needed here). */
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

function makeMainFrame(opts: { destroyed?: boolean; detached?: boolean; throwMessage?: string } = {}): {
  isDestroyed: () => boolean
  detached: boolean
} {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    detached: opts.detached ?? false,
  }
}

function makeWebContents(mainFrame: unknown = makeMainFrame()): FakeEmitter & { mainFrame: unknown } {
  const wc = new FakeEmitter() as FakeEmitter & { mainFrame: unknown }
  Object.defineProperty(wc, 'mainFrame', {
    get: () => {
      if (mainFrame instanceof Error) throw mainFrame
      return mainFrame
    },
  })
  return wc
}

function makeWin(opts: { visible?: boolean; minimized?: boolean; mainFrame?: unknown } = {}): FakeEmitter & {
  webContents: FakeEmitter & { mainFrame: unknown }
  isVisible: () => boolean
  isMinimized: () => boolean
} {
  const win = new FakeEmitter() as FakeEmitter & {
    webContents: FakeEmitter & { mainFrame: unknown }
    isVisible: () => boolean
    isMinimized: () => boolean
  }
  win.webContents = makeWebContents(opts.mainFrame)
  win.isVisible = () => opts.visible ?? true
  win.isMinimized = () => opts.minimized ?? false
  return win
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
    const wc = makeWebContents(makeMainFrame({ destroyed: true }))
    expect(describeMainFrameState(wc as unknown as Electron.WebContents)).toBe('destroyed')
  })

  it('returns "detached" when the frame is detached but not destroyed', () => {
    const wc = makeWebContents(makeMainFrame({ detached: true }))
    expect(describeMainFrameState(wc as unknown as Electron.WebContents)).toBe('detached')
  })

  it('returns "available" when the frame is neither destroyed nor detached', () => {
    const wc = makeWebContents(makeMainFrame())
    expect(describeMainFrameState(wc as unknown as Electron.WebContents)).toBe('available')
  })

  it('returns "threw: <message>" when accessing mainFrame throws', () => {
    const wc = makeWebContents(new Error('Render frame was disposed'))
    expect(describeMainFrameState(wc as unknown as Electron.WebContents)).toBe('threw: Render frame was disposed')
  })
})

describe('registerProcessGoneLogging', () => {
  beforeEach(() => {
    mockLog.mockClear()
  })

  it('logs render-process-gone at error level for a non-clean-exit reason', () => {
    const win = makeWin()
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('crashed'))
  })

  it('logs render-process-gone at info level for a clean-exit reason', () => {
    const win = makeWin()
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(mockLog).toHaveBeenCalledWith('info', expect.stringContaining('clean-exit'))
  })

  it('logs unresponsive at warn level', () => {
    const win = makeWin()
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    win.webContents.emit('unresponsive')
    expect(mockLog).toHaveBeenCalledWith('warn', expect.any(String))
  })

  it('logs responsive at info level', () => {
    const win = makeWin()
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    win.webContents.emit('responsive')
    expect(mockLog).toHaveBeenCalledWith('info', expect.any(String))
  })

  it('logs a warn line on show when the main frame is not available', () => {
    const win = makeWin({ mainFrame: makeMainFrame({ destroyed: true }) })
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    win.emit('show')
    expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('destroyed'))
  })

  it('does not log on show when the main frame is available', () => {
    const win = makeWin()
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    win.emit('show')
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('never throws out of the render-process-gone handler when the logger throws', () => {
    mockLog.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const win = makeWin()
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    expect(() => win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })).not.toThrow()
  })

  it('never throws out of the show handler when the logger throws', () => {
    mockLog.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const win = makeWin({ mainFrame: makeMainFrame({ destroyed: true }) })
    registerProcessGoneLogging(win as unknown as Electron.BrowserWindow)
    expect(() => win.emit('show')).not.toThrow()
  })
})

describe('registerChildProcessGoneLogging', () => {
  beforeEach(() => {
    mockLog.mockClear()
    appHandlers.clear()
  })

  it('registers a child-process-gone handler that logs via the shared logger', () => {
    registerChildProcessGoneLogging()
    const handler = appHandlers.get('child-process-gone')
    expect(handler).toBeDefined()
    handler!({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(mockLog).toHaveBeenCalledWith('error', expect.stringContaining('GPU'))
  })

  it('logs at info level for a clean-exit child process reason', () => {
    registerChildProcessGoneLogging()
    const handler = appHandlers.get('child-process-gone')
    handler!({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 })
    expect(mockLog).toHaveBeenCalledWith('info', expect.any(String))
  })

  it('never throws when the logger throws', () => {
    mockLog.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    registerChildProcessGoneLogging()
    const handler = appHandlers.get('child-process-gone')
    expect(() => handler!({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })).not.toThrow()
  })
})
