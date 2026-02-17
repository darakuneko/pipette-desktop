// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
const mockHandlers = new Map<string, (...args: unknown[]) => unknown>()
const mockListeners = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mockHandlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mockListeners.set(channel, handler)
    }),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

import { isAllowedOrigin, secureHandle, secureOn } from '../ipc-guard'

describe('isAllowedOrigin', () => {
  it('allows file:// origin', () => {
    expect(isAllowedOrigin('file://')).toBe(true)
  })

  it('rejects null origin', () => {
    expect(isAllowedOrigin(null)).toBe(false)
  })

  it('rejects undefined origin', () => {
    expect(isAllowedOrigin(undefined)).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isAllowedOrigin('')).toBe(false)
  })

  it('rejects string "null"', () => {
    expect(isAllowedOrigin('null')).toBe(false)
  })

  it('rejects http://example.com', () => {
    expect(isAllowedOrigin('http://example.com')).toBe(false)
  })

  describe('dev mode', () => {
    it('allows http://localhost:5173', () => {
      expect(isAllowedOrigin('http://localhost:5173', true)).toBe(true)
    })

    it('allows http://localhost', () => {
      expect(isAllowedOrigin('http://localhost', true)).toBe(true)
    })

    it('rejects http://localhost.evil.com', () => {
      expect(isAllowedOrigin('http://localhost.evil.com', true)).toBe(false)
    })

    it('rejects https://localhost:5173', () => {
      expect(isAllowedOrigin('https://localhost:5173', true)).toBe(false)
    })
  })

  describe('prod mode', () => {
    it('rejects http://localhost:5173', () => {
      expect(isAllowedOrigin('http://localhost:5173', false)).toBe(false)
    })

    it('rejects http://localhost', () => {
      expect(isAllowedOrigin('http://localhost', false)).toBe(false)
    })
  })
})

describe('secureHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHandlers.clear()
  })

  it('calls handler when origin is valid', async () => {
    const handler = vi.fn(() => 'result')
    secureHandle('test-channel', handler)

    const wrappedHandler = mockHandlers.get('test-channel')!
    const event = { senderFrame: { origin: 'file://' } }
    const result = await wrappedHandler(event, 'arg1', 'arg2')

    expect(handler).toHaveBeenCalledWith(event, 'arg1', 'arg2')
    expect(result).toBe('result')
  })

  it('throws when origin is invalid', () => {
    const handler = vi.fn()
    secureHandle('test-channel', handler)

    const wrappedHandler = mockHandlers.get('test-channel')!
    const event = { senderFrame: { origin: 'http://evil.com' } }

    expect(() => wrappedHandler(event)).toThrow('IPC origin rejected')
    expect(handler).not.toHaveBeenCalled()
  })

  it('throws when senderFrame is null', () => {
    const handler = vi.fn()
    secureHandle('test-channel', handler)

    const wrappedHandler = mockHandlers.get('test-channel')!
    const event = { senderFrame: null }

    expect(() => wrappedHandler(event)).toThrow('IPC origin rejected')
    expect(handler).not.toHaveBeenCalled()
  })

  it('throws when event has no senderFrame', () => {
    const handler = vi.fn()
    secureHandle('test-channel', handler)

    const wrappedHandler = mockHandlers.get('test-channel')!

    expect(() => wrappedHandler({})).toThrow('IPC origin rejected')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('secureOn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListeners.clear()
  })

  it('calls handler when origin is valid', () => {
    const handler = vi.fn()
    secureOn('test-channel', handler)

    const wrappedHandler = mockListeners.get('test-channel')!
    const event = { senderFrame: { origin: 'file://' } }
    wrappedHandler(event, 'arg1')

    expect(handler).toHaveBeenCalledWith(event, 'arg1')
  })

  it('silently ignores when origin is invalid', () => {
    const handler = vi.fn()
    secureOn('test-channel', handler)

    const wrappedHandler = mockListeners.get('test-channel')!
    const event = { senderFrame: { origin: 'http://evil.com' } }
    wrappedHandler(event)

    expect(handler).not.toHaveBeenCalled()
  })

  it('silently ignores when senderFrame is null', () => {
    const handler = vi.fn()
    secureOn('test-channel', handler)

    const wrappedHandler = mockListeners.get('test-channel')!
    wrappedHandler({ senderFrame: null })

    expect(handler).not.toHaveBeenCalled()
  })
})
