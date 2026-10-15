// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the keyboard definition decompression of the Tauri
// shell (src-tauri/src/definition.rs). Each input goes through the real
// Electron handler of the LZMA_DECOMPRESS channel (setupLzmaIpc in
// src/main/lzma.ts), and its result is recorded next to the input in
// src-tauri/tests/fixtures/definition/cases.json, as the SHA-256 and the
// UTF-8 length of the text (or null), so outputs at the 10 MiB limit need
// not be committed.
//
// The LZMA-alone definition is compressed with lzma-js (the encoder of the
// TypeScript virtual keyboard); the XZ inputs, and the large LZMA-alone
// ones, with Python's lzma module (liblzma), which is how Vial builds the
// definition it stores in the firmware. liblzma output is deterministic,
// so every run writes the same files.
//
// Requires python3 on PATH.
//
// Run: pnpm run generate:definition-fixtures

import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import * as lzmaModule from 'lzma'
import { writeFixture, writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const ipc = vi.hoisted(() => ({
  handler: null as ((event: unknown, data: number[]) => Promise<string | null>) | null,
}))

vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (_channel: string, handler: typeof ipc.handler) => {
    ipc.handler = handler
  },
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))

import { setupLzmaIpc, MAX_DECOMPRESSED_SIZE } from '../../src/main/lzma'
import definitionJson from '../../src/main/virtual-device/gpk60-63r-definition.json'

const OUT_DIR = resolve(REPO_ROOT, 'src-tauri/tests/fixtures/definition')

/** Python's lzma.compress with the given keyword arguments (Python source). */
function pythonCompress(data: Uint8Array, kwargs: string): Uint8Array {
  const script = `import lzma, sys; sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(), ${kwargs}))`
  return new Uint8Array(execFileSync('python3', ['-c', script], { input: data, maxBuffer: 64 * 1024 * 1024 }))
}

const xz = (data: Uint8Array, kwargs = 'format=lzma.FORMAT_XZ'): Uint8Array => pythonCompress(data, kwargs)
const lzmaAlone = (data: Uint8Array): Uint8Array => pythonCompress(data, 'format=lzma.FORMAT_ALONE')

function lzmaJs(text: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    lzmaModule.compress(text, 9, (result) => resolve(Uint8Array.from(result, (b) => b & 0xff)))
  })
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const filled = (size: number, byte: number): Uint8Array => new Uint8Array(size).fill(byte)

/** Deterministic bytes that are neither format. */
function garbage(size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = 0x12345678
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

function corruptMiddle(data: Uint8Array): Uint8Array {
  const out = data.slice()
  out[Math.floor(out.length / 2)] ^= 0xff
  return out
}

describe('definition decompression fixtures', () => {
  it('records the Electron result for every input', async () => {
    setupLzmaIpc()
    const handler = ipc.handler
    if (!handler) throw new Error('setupLzmaIpc did not register a handler')

    const definition = JSON.stringify(definitionJson)
    const definitionXz = xz(utf8(definition))
    const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0xe2, 0x82, 0x7d, 0xf0, 0x9f, 0x98])

    const inputs: Array<[string, Uint8Array]> = [
      ['lzma-alone-definition', await lzmaJs(definition)],
      ['lzma-alone-non-ascii', await lzmaJs(JSON.stringify({ name: 'Ü✓ キーボード', emoji: '⌨️' }))],
      ['lzma-alone-invalid-utf8', lzmaAlone(invalidUtf8)],
      ['lzma-alone-at-output-limit', lzmaAlone(filled(MAX_DECOMPRESSED_SIZE, 0x61))],
      ['lzma-alone-over-output-limit', lzmaAlone(filled(MAX_DECOMPRESSED_SIZE + 1, 0x61))],
      // Each 0xff becomes a 3-byte U+FFFD, so the text passes the limit
      // although the decompressed bytes do not.
      ['lzma-alone-replacement-over-output-limit', lzmaAlone(filled(4 * 1024 * 1024, 0xff))],
      ['lzma-alone-truncated', (await lzmaJs(definition)).slice(0, 200)],
      ['lzma-alone-corrupt', corruptMiddle(await lzmaJs(definition))],
      ['xz-definition', definitionXz],
      ['xz-definition-preset-9-extreme', xz(utf8(definition), 'format=lzma.FORMAT_XZ, preset=9 | lzma.PRESET_EXTREME')],
      ['xz-check-crc32', xz(utf8(definition), 'format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32')],
      ['xz-check-sha256', xz(utf8(definition), 'format=lzma.FORMAT_XZ, check=lzma.CHECK_SHA256')],
      ['xz-check-none', xz(utf8(definition), 'format=lzma.FORMAT_XZ, check=lzma.CHECK_NONE')],
      ['xz-non-ascii', xz(utf8(JSON.stringify({ name: 'Ü✓ キーボード', emoji: '⌨️' })))],
      ['xz-invalid-utf8', xz(invalidUtf8)],
      ['xz-at-output-limit', xz(filled(MAX_DECOMPRESSED_SIZE, 0x61))],
      ['xz-over-output-limit', xz(filled(MAX_DECOMPRESSED_SIZE + 1, 0x61))],
      ['xz-truncated', definitionXz.slice(0, definitionXz.length - 20)],
      ['xz-corrupt', corruptMiddle(definitionXz)],
      ['xz-magic-only', definitionXz.slice(0, 6)],
      ['garbage', garbage(4096)],
    ]

    const cases: { name: string; input: string; expected: { utf8Length: number; sha256: string } | null }[] = []
    for (const [name, input] of inputs) {
      const text = await handler(null, Array.from(input))
      writeFixture(resolve(OUT_DIR, `${name}.bin`), input)
      cases.push({
        name,
        input: `${name}.bin`,
        expected:
          text === null
            ? null
            : { utf8Length: Buffer.byteLength(text, 'utf-8'), sha256: createHash('sha256').update(text, 'utf-8').digest('hex') },
      })
    }
    writeJsonFixture(resolve(OUT_DIR, 'cases.json'), cases)

    // The inputs cover both outcomes of both formats.
    const decoded = (prefix: string): boolean[] =>
      cases.filter((c) => c.name.startsWith(prefix)).map((c) => c.expected !== null)
    expect(decoded('lzma-alone')).toContain(true)
    expect(decoded('lzma-alone')).toContain(false)
    expect(decoded('xz')).toContain(true)
    expect(decoded('xz')).toContain(false)
  })
})
