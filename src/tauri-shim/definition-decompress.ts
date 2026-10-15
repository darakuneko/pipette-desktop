// SPDX-License-Identifier: GPL-2.0-or-later
// Decompresses a keyboard definition in the WebView: XZ (detected by its
// magic bytes) or LZMA-alone, the two formats Vial firmware stores. Same
// packages, size limits and results as the Electron main process
// (src/main/lzma.ts), which this build has no IPC channel to.

import lzmaD from 'lzma/src/lzma-d.js'

export const MAX_COMPRESSED_SIZE = 1 * 1024 * 1024 // 1 MB
export const MAX_DECOMPRESSED_SIZE = 10 * 1024 * 1024 // 10 MB

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]

function hasXzMagic(data: Uint8Array): boolean {
  return data.length >= XZ_MAGIC.length && XZ_MAGIC.every((byte, i) => data[i] === byte)
}

/** The definition JSON text, or null when the input is empty, too large,
 *  corrupt, or decompresses to more than MAX_DECOMPRESSED_SIZE. */
export async function decompressDefinition(data: Uint8Array): Promise<string | null> {
  if (data.length === 0 || data.length > MAX_COMPRESSED_SIZE) return null
  return hasXzMagic(data) ? decompressXz(data) : decompressLzma(data)
}

async function decompressXz(data: Uint8Array): Promise<string | null> {
  try {
    // Loaded on first use: the decoder embeds a WebAssembly module, and
    // LZMA-alone definitions never need it. Compiling it needs
    // 'wasm-unsafe-eval' in script-src, which the window's CSP
    // (src-tauri/tauri.conf.json) does not grant, so in the Tauri window an
    // XZ definition ends in the catch below and yields null.
    const { XzReadableStream } = await import('xz-decompress')
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })
    const reader = new XzReadableStream(input).getReader()
    const chunks: Uint8Array[] = []
    let totalSize = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalSize += value.byteLength
      if (totalSize > MAX_DECOMPRESSED_SIZE) {
        await reader.cancel()
        console.warn(`XZ output exceeded limit: ${totalSize} bytes`)
        return null
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(totalSize)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(merged)
  } catch (err) {
    console.warn('XZ decompress error:', err)
    return null
  }
}

function decompressLzma(data: Uint8Array): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      lzmaD.LZMA.decompress(Array.from(data), (result, error) => {
        if (error) {
          console.warn('LZMA decompress error:', error)
          resolve(null)
          return
        }
        if (result == null) {
          resolve(null)
          return
        }
        // A string when the output is valid UTF-8, otherwise the raw bytes.
        const text = typeof result === 'string' ? result : new TextDecoder().decode(new Uint8Array(result))
        if (new TextEncoder().encode(text).byteLength > MAX_DECOMPRESSED_SIZE) {
          console.warn('LZMA output exceeded limit')
          resolve(null)
          return
        }
        resolve(text)
      })
    } catch {
      resolve(null)
    }
  })
}
