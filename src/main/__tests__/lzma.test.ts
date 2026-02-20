import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks ---

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mockHandlers.set(channel, handler)
    }),
  },
}))

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

// Mock xz-decompress — must use a regular function so it works with `new`
const mockXzReadableStream = vi.fn()
vi.mock('xz-decompress', () => {
  const XzReadableStream = function XzReadableStream(...args: unknown[]) {
    return mockXzReadableStream(...args)
  }
  return { default: { XzReadableStream }, XzReadableStream }
})

// Mock lzma package
const mockLzmaDecompress = vi.fn()
vi.mock('lzma', () => ({
  decompress: (...args: unknown[]) => mockLzmaDecompress(...args),
}))

import { IpcChannels } from '../../shared/ipc/channels'
import { log } from '../logger'
import {
  setupLzmaIpc,
  MAX_COMPRESSED_SIZE,
  MAX_DECOMPRESSED_SIZE,
} from '../lzma'

// XZ magic bytes prefix
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]

/** Helper: create a ReadableStream that yields the given chunks */
function mockStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('lzma', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHandlers.clear()
    setupLzmaIpc()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function getHandler(): (...args: unknown[]) => Promise<string | null> {
    const handler = mockHandlers.get(IpcChannels.LZMA_DECOMPRESS)
    expect(handler).toBeDefined()
    return handler as (...args: unknown[]) => Promise<string | null>
  }

  describe('input validation', () => {
    it('returns null for empty array', async () => {
      const result = await getHandler()({}, [])
      expect(result).toBeNull()
    })

    it('returns null for null data', async () => {
      const result = await getHandler()({}, null)
      expect(result).toBeNull()
    })

    it('returns null for non-array data', async () => {
      const result = await getHandler()({}, 'not-array')
      expect(result).toBeNull()
    })

    it('returns null for undefined data', async () => {
      const result = await getHandler()({}, undefined)
      expect(result).toBeNull()
    })
  })

  describe('input size limit', () => {
    it('rejects input exceeding MAX_COMPRESSED_SIZE', async () => {
      const oversized = new Array(MAX_COMPRESSED_SIZE + 1).fill(0)
      const result = await getHandler()({}, oversized)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('exceeds limit'),
      )
    })

    it('accepts input at exactly MAX_COMPRESSED_SIZE', async () => {
      const exactSize = new Array(MAX_COMPRESSED_SIZE).fill(0)
      // Non-XZ, non-LZMA data — will go to LZMA path
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: string | null) => void) => cb('ok'),
      )
      const result = await getHandler()({}, exactSize)
      expect(result).toBe('ok')
    })
  })

  describe('XZ decompression', () => {
    it('decompresses valid XZ data', async () => {
      const decompressed = new TextEncoder().encode('decompressed result')
      mockXzReadableStream.mockReturnValue(mockStream([decompressed]))

      const data = [...XZ_MAGIC, 1, 2, 3]
      const result = await getHandler()({}, data)
      expect(result).toBe('decompressed result')
    })

    it('returns null when XZ output exceeds MAX_DECOMPRESSED_SIZE', async () => {
      const oversized = new Uint8Array(MAX_DECOMPRESSED_SIZE + 1)
      mockXzReadableStream.mockReturnValue(mockStream([oversized]))

      const data = [...XZ_MAGIC, 1, 2, 3]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('exceeded limit'),
      )
    })

    it('returns null when XZ output exceeds limit across multiple chunks', async () => {
      const halfSize = Math.ceil(MAX_DECOMPRESSED_SIZE / 2)
      mockXzReadableStream.mockReturnValue(
        mockStream([new Uint8Array(halfSize), new Uint8Array(halfSize + 1)]),
      )

      const data = [...XZ_MAGIC, 1, 2, 3]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('exceeded limit'),
      )
    })

    it('returns null when XzReadableStream throws', async () => {
      mockXzReadableStream.mockImplementation(() => {
        throw new Error('corrupt XZ data')
      })

      const data = [...XZ_MAGIC, 1, 2, 3]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('corrupt XZ data'),
      )
    })

    it('returns null when stream read rejects', async () => {
      const errStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('stream error'))
        },
      })
      mockXzReadableStream.mockReturnValue(errStream)

      const data = [...XZ_MAGIC, 1, 2, 3]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('stream error'),
      )
    })
  })

  describe('LZMA decompression', () => {
    it('decompresses valid LZMA data', async () => {
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: string | null) => void) => cb('lzma result'),
      )

      const data = [0x5d, 0x00, 0x00, 0x01] // Non-XZ magic bytes
      const result = await getHandler()({}, data)
      expect(result).toBe('lzma result')
    })

    it('returns null when LZMA output exceeds MAX_DECOMPRESSED_SIZE', async () => {
      const hugeString = 'x'.repeat(MAX_DECOMPRESSED_SIZE + 1)
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: string | null) => void) => cb(hugeString),
      )

      const data = [0x5d, 0x00, 0x00, 0x01]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('LZMA output exceeded limit'),
      )
    })

    it('returns null when LZMA.decompress throws', async () => {
      mockLzmaDecompress.mockImplementation(() => {
        throw new Error('corrupt data')
      })

      const data = [0x5d, 0x00, 0x00, 0x01]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
    })

    it('returns null when LZMA.decompress returns null', async () => {
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: string | null) => void) => cb(null),
      )

      const data = [0x5d, 0x00, 0x00, 0x01]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
    })

    it('returns null when LZMA.decompress reports an error via callback', async () => {
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: string | null, error?: unknown) => void) =>
          cb(null, new Error('decompression failed')),
      )

      const data = [0x5d, 0x00, 0x00, 0x01]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('decompression failed'),
      )
    })

    it('handles Uint8Array output from LZMA.decompress', async () => {
      const bytes = new TextEncoder().encode('binary result')
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: Uint8Array) => void) => cb(bytes),
      )

      const data = [0x5d, 0x00, 0x00, 0x01]
      const result = await getHandler()({}, data)
      expect(result).toBe('binary result')
    })

    it('rejects oversized Uint8Array output from LZMA.decompress', async () => {
      const oversized = new Uint8Array(MAX_DECOMPRESSED_SIZE + 1)
      mockLzmaDecompress.mockImplementation(
        (_data: unknown, cb: (result: Uint8Array) => void) => cb(oversized),
      )

      const data = [0x5d, 0x00, 0x00, 0x01]
      const result = await getHandler()({}, data)
      expect(result).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('LZMA output exceeded limit'),
      )
    })
  })

  describe('constants', () => {
    it('MAX_COMPRESSED_SIZE is 1 MB', () => {
      expect(MAX_COMPRESSED_SIZE).toBe(1 * 1024 * 1024)
    })

    it('MAX_DECOMPRESSED_SIZE is 10 MB', () => {
      expect(MAX_DECOMPRESSED_SIZE).toBe(10 * 1024 * 1024)
    })
  })
})
