// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import * as lzma from 'lzma'
import { decompressDefinition, MAX_COMPRESSED_SIZE } from '../definition-decompress'

function compress(text: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    lzma.compress(text, 1, (result) => resolve(new Uint8Array(result)))
  })
}

describe('decompressDefinition', () => {
  it('decompresses an LZMA-alone definition to its JSON text', async () => {
    const json = JSON.stringify({ name: 'Virtual Keyboard', matrix: { rows: 5, cols: 14 }, note: 'ü✓' })
    await expect(decompressDefinition(await compress(json))).resolves.toBe(json)
  })

  it('returns null for empty, oversized and corrupt input', async () => {
    await expect(decompressDefinition(new Uint8Array())).resolves.toBeNull()
    await expect(decompressDefinition(new Uint8Array(MAX_COMPRESSED_SIZE + 1))).resolves.toBeNull()
    await expect(decompressDefinition(new Uint8Array([1, 2, 3, 4, 5]))).resolves.toBeNull()
  })
})
