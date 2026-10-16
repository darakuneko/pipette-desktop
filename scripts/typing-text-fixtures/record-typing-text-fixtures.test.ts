// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-typing-text: runs the real
// TypeScript text functions and the Aozora import over the inputs of
// text-cases.ts and aozora-cases.ts, and Electron's
// TextDecoder('shift_jis') over every one- and two-byte sequence, and
// records the results for the Rust crate to match:
//
// - tests/fixtures/text_functions.json — normalizeFileImportText (with the
//   parse behind it), isKanaOnlyText and cleanAozoraText;
// - tests/fixtures/shift_jis.json — the decoded code units, in hex;
// - tests/fixtures/aozora_zips.json — what importAozoraWork does with each
//   zip: the text it saves, its error, or the error it throws.
//
// Runs under Electron acting as Node (see the generate:typing-text-fixtures
// script): the Shift_JIS decoder must be the one of Electron's ICU.
//
// Run: pnpm run generate:typing-text-fixtures

import { describe, it, expect, vi } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { random32 } from '../fixture-random'
import { REPO_ROOT } from '../fixture-vitest-config'
import { cleanCases, kanaCases, normalizeCases } from './text-cases'
import { shiftJisEncoder, zipCases } from './aozora-cases'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
vi.mock('../../src/main/language-store', () => ({ getEffectiveDataset: vi.fn() }))
vi.mock('../../src/main/typing-test-text-store', () => ({ saveRecord: vi.fn() }))

import { net } from 'electron'
import { getEffectiveDataset } from '../../src/main/language-store'
import { saveRecord } from '../../src/main/typing-test-text-store'
import { importAozoraWork } from '../../src/main/aozora/aozora-import'
import { cleanAozoraText } from '../../src/main/aozora/aozora-clean'
import { normalizeFileImportText, parseFileImportText } from '../../src/shared/types/typing-test-text-store'
import { isKanaOnlyText } from '../../src/shared/kana-purity'

const FIXTURES = resolve(REPO_ROOT, 'src-tauri/crates/pipette-typing-text/tests/fixtures')

/** Above this many words a case records only the normalized text, not
 *  the parse, to keep the fixture small. */
const MAX_RECORDED_PARSE_WORDS = 100

const hex = (n: number): string => n.toString(16).padStart(2, '0')

/** The UTF-16 code units of `text` in hex, joined with `.`. */
function units(text: string): string {
  return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16)).join('.')
}

function recordTextFunctions(): void {
  const normalize = normalizeCases().map(({ input, maxWords }) => {
    const normalized = normalizeFileImportText(input, maxWords)
    const parsed = parseFileImportText(input, maxWords)
    return {
      input,
      maxWords,
      ...normalized,
      ...(parsed.words.length <= MAX_RECORDED_PARSE_WORDS ? { parsed } : {}),
    }
  })
  const kanaOnly = kanaCases().map((input) => ({ input, kanaOnly: isKanaOnlyText(input) }))
  const clean = cleanCases().map((input) => {
    try {
      return { input, output: cleanAozoraText(input) }
    } catch (err) {
      return { input, throws: String(err) }
    }
  })
  expect(clean.some((c) => 'throws' in c)).toBe(true)
  writeJsonFixture(resolve(FIXTURES, 'text_functions.json'), { normalize, kanaOnly, clean })
}

function recordShiftJis(decodeBytes: (bytes: Uint8Array) => string): void {
  const decode = (bytes: number[]): string => units(decodeBytes(Uint8Array.from(bytes)))
  const singleBytes = Array.from({ length: 256 }, (_, byte) => decode([byte]))
  // One row per first byte from 0x80: the 256 second bytes, space-separated.
  const pairs: Record<string, string> = {}
  for (let lead = 0x80; lead <= 0xff; lead++) {
    pairs[hex(lead)] = Array.from({ length: 256 }, (_, trail) => decode([lead, trail])).join(' ')
  }
  const next = random32(0x5150)
  const pools = [
    Array.from({ length: 256 }, (_, b) => b),
    [0x81, 0x9f, 0xe0, 0xef, 0xf0, 0xfc, 0x80, 0xa0, 0xfd, 0xfe, 0xff],
    [0x00, 0x3f, 0x40, 0x7e, 0x7f, 0x80, 0xa1, 0xdf, 0xfc, 0xfd, 0x0a, 0x5c],
  ]
  const streams = Array.from({ length: 300 }, () => {
    const bytes = Array.from({ length: 1 + (next() % 24) }, () => {
      const pool = pools[next() % pools.length]
      return pool[next() % pool.length]
    })
    return { bytes: bytes.map(hex).join(''), units: decode(bytes) }
  })
  writeJsonFixture(resolve(FIXTURES, 'shift_jis.json'), { singleBytes, pairs, streams })
}

const WORK_ID = '000001/files/1_ruby_1.zip'

async function recordAozoraZips(encode: (text: string) => Uint8Array): Promise<void> {
  const results = []
  for (const { name, zip, inflateError } of zipCases(encode)) {
    vi.mocked(getEffectiveDataset).mockResolvedValue({
      provider: 'aozora',
      version: 'fixture',
      downloadUrlBase: 'https://hub.example/aozora',
      model: 'catalog',
      languages: [{ name: WORK_ID, title: 'T', author: 'A', wordCount: 1, rightToLeft: false, fileSize: zip.byteLength }],
    })
    const body = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(body) } as unknown as Response)
    vi.mocked(saveRecord).mockReset()
    vi.mocked(saveRecord).mockResolvedValue({ success: true, data: { id: 'id', name: 'T（A）', wordCount: 1, filename: 'f', savedAt: 'x', updatedAt: 'x' } })

    let outcome: Record<string, unknown>
    try {
      const result = await importAozoraWork(WORK_ID)
      outcome = result.success
        ? { text: vi.mocked(saveRecord).mock.calls[0][0].text }
        : { errorCode: result.errorCode, error: result.error }
    } catch (err) {
      outcome = { throws: String(err) }
    }
    results.push({ name, zip: Buffer.from(zip).toString('base64'), ...(inflateError ? { inflateError } : {}), ...outcome })
  }
  writeJsonFixture(resolve(FIXTURES, 'aozora_zips.json'), results)
}

describe('typing-text fixtures', () => {
  it('runs under Electron', () => {
    expect(process.versions.electron).toBeDefined()
  })

  it('records the text functions', () => {
    recordTextFunctions()
  })

  it('records Shift_JIS and the Aozora zips', async () => {
    const decoder = new TextDecoder('shift_jis')
    const decode = (bytes: Uint8Array): string => decoder.decode(bytes)
    recordShiftJis(decode)
    await recordAozoraZips(shiftJisEncoder(decode))
  })
})
