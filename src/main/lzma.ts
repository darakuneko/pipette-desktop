// SPDX-License-Identifier: GPL-2.0-or-later
// LZMA/XZ decompression with bomb protection — runs in main process

import * as lzmaModule from 'lzma'
import xzDecompress from 'xz-decompress'
const { XzReadableStream } = xzDecompress
import { IpcChannels } from '../shared/ipc/channels'
import { secureHandle } from './ipc-guard'
import { log } from './logger'

export const MAX_COMPRESSED_SIZE = 1 * 1024 * 1024   // 1 MB
export const MAX_DECOMPRESSED_SIZE = 10 * 1024 * 1024 // 10 MB

const XZ_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])

function hasXzMagic(buf: Buffer): boolean {
  if (buf.length < XZ_MAGIC.length) return false
  for (let i = 0; i < XZ_MAGIC.length; i++) {
    if (buf[i] !== XZ_MAGIC[i]) return false
  }
  return true
}

export function setupLzmaIpc(): void {
  secureHandle(IpcChannels.LZMA_DECOMPRESS, (_event, data: number[]): Promise<string | null> => {
    if (!data || !Array.isArray(data) || data.length === 0) {
      return Promise.resolve(null)
    }
    if (data.length > MAX_COMPRESSED_SIZE) {
      log('warn', `LZMA input rejected: ${data.length} bytes exceeds limit`)
      return Promise.resolve(null)
    }
    const buf = Buffer.from(data)
    if (hasXzMagic(buf)) {
      return decompressXz(buf)
    }
    return decompressLzma(data)
  })
}

async function decompressXz(buf: Buffer): Promise<string | null> {
  try {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buf))
        controller.close()
      },
    })
    const stream = new XzReadableStream(input)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let totalSize = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalSize += value.byteLength
      if (totalSize > MAX_DECOMPRESSED_SIZE) {
        await reader.cancel()
        log('warn', `XZ output exceeded limit: ${totalSize} bytes`)
        return null
      }
      chunks.push(value)
    }
    const merged = Buffer.concat(chunks)
    return merged.toString('utf-8')
  } catch (err) {
    log('warn', `XZ decompress error: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

function decompressLzma(data: number[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      lzmaModule.decompress(data, (result: string | Uint8Array | null, error?: unknown) => {
        if (error) {
          log('warn', `LZMA decompress error: ${error}`)
          resolve(null)
          return
        }
        if (result == null) {
          resolve(null)
          return
        }
        const str = typeof result === 'string' ? result : Buffer.from(result).toString('utf-8')
        if (Buffer.byteLength(str, 'utf-8') > MAX_DECOMPRESSED_SIZE) {
          log('warn', 'LZMA output exceeded limit')
          resolve(null)
          return
        }
        resolve(str)
      })
    } catch {
      resolve(null)
    }
  })
}
