// SPDX-License-Identifier: GPL-2.0-or-later
// The zips given to importAozoraWork: well-formed archives (stored and
// DEFLATE, several entries, repeated and non-ASCII names, zip64, trailing
// bytes), broken ones, and texts at the edges of the decode check and the
// cleaning.

import { deflateSync, zipSync, type ZipOptions, type Zippable } from 'fflate'
import { AOZORA_SAMPLE } from './text-cases'
import { buildZip, type RawEntry } from './zip-builder'

export interface ZipCase {
  name: string
  zip: Uint8Array
  /** The archive fails in fflate's inflater, whose messages the Rust port
   *  does not copy: only the error code is compared. */
  inflateError?: boolean
}

/** A Shift_JIS encoder built from the decoder under test: each character
 *  maps to the first byte sequence that decodes to it. */
export function shiftJisEncoder(decode: (bytes: Uint8Array) => string): (text: string) => Uint8Array {
  const table = new Map<string, number[]>()
  for (let byte = 0; byte < 0x100; byte++) {
    const char = decode(Uint8Array.of(byte))
    if (char.length === 1 && char !== '�' && !table.has(char)) table.set(char, [byte])
  }
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      const char = decode(Uint8Array.of(lead, trail))
      if (char.length === 1 && char !== '�' && !table.has(char)) table.set(char, [lead, trail])
    }
  }
  return (text) => {
    const bytes: number[] = []
    for (const char of text) {
      const encoded = table.get(char)
      if (!encoded) throw new Error(`No Shift_JIS for ${JSON.stringify(char)}`)
      bytes.push(...encoded)
    }
    return Uint8Array.from(bytes)
  }
}

/** fflate's zipSync with a fixed modification time (written in local time,
 *  hence TZ=UTC in vitest.config.ts), so the archives are the same on every
 *  run. */
function zip(files: Zippable, level: ZipOptions['level'] = 6): Uint8Array {
  return zipSync(files, { level, mtime: new Date(Date.UTC(2020, 0, 1)) })
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)

function stored(name: string | Uint8Array, data: Uint8Array, flags = 0): RawEntry {
  return { name: typeof name === 'string' ? ascii(name) : name, flags, method: 0, data, size: data.length }
}

function deflated(name: string, data: Uint8Array): RawEntry {
  return { name: ascii(name), method: 8, data: deflateSync(data), size: data.length }
}

export function zipCases(encode: (text: string) => Uint8Array): ZipCase[] {
  const sample = encode(AOZORA_SAMPLE.replaceAll('\n', '\r\n'))
  const body = (text: string): Uint8Array => encode(`\r\n${text}\r\n`)
  const cases: ZipCase[] = [
    { name: 'stored sample', zip: zip({ 'work.txt': sample }, 0) },
    { name: 'deflated sample', zip: zip({ 'dir/work.txt': sample }) },
    {
      name: 'largest txt among other files',
      zip: zip({
        'image.png': new Uint8Array(5000),
        '__MACOSX/dir/._work.txt': new Uint8Array(4000),
        'readme.TXT': body('小さい'),
        'dir/': new Uint8Array(0),
        'work.Txt': sample,
      }),
    },
    { name: 'equal sizes take the first', zip: zip({ 'a.txt': body('いち'), 'b.txt': body('にい') }) },
    { name: 'no txt entry', zip: zip({ 'image.png': new Uint8Array([1, 2, 3]), '__MACOSX/work.txt': body('x') }) },
    { name: 'no entries', zip: zip({}) },
    {
      name: 'repeated name keeps its first place',
      zip: buildZip([stored('a.txt', body('ああ')), stored('b.txt', body('いい')), stored('a.txt', body('うう'))]),
    },
    {
      name: 'latin-1 and utf-8 names that decode the same',
      zip: buildZip([
        stored(Uint8Array.of(0xe9, ...ascii('.txt')), body('ラテン')),
        stored(Uint8Array.of(0xef, 0xbb, 0xbf, 0xc3, 0xa9, ...ascii('.txt')), body('ユーティーエフ'), 0x800),
        stored('x.txt', body('ばつばつばつ')),
      ]),
    },
    {
      name: 'shift_jis name without the utf-8 flag',
      zip: buildZip([stored(Uint8Array.of(...encode('作品'), ...ascii('.txt')), body('本文'))]),
    },
    {
      name: 'invalid utf-8 name with the flag',
      zip: buildZip([stored(Uint8Array.of(0xe3, 0x81, ...ascii('.txt')), body('本文'), 0x800)]),
    },
    {
      name: 'zip64 sizes',
      zip: buildZip([{ ...deflated('work.txt', sample), zip64Sizes: true }], { zip64: true }),
    },
    {
      name: 'zip64 sizes without the extra field',
      zip: (() => {
        const bytes = buildZip([{ ...stored('work.txt', sample), zip64Sizes: true }], { zip64: true })
        // Clear the central directory entry's extra length.
        const directory = bytes.findIndex((_, i) => bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2)
        bytes[directory + 30] = 0
        return bytes
      })(),
    },
    { name: 'trailing bytes 65537', zip: buildZip([stored('a.txt', body('本文'))], { trailing: new Uint8Array(65537) }) },
    { name: 'trailing bytes 65538', zip: buildZip([stored('a.txt', body('本文'))], { trailing: new Uint8Array(65538) }) },
    { name: 'unknown method', zip: buildZip([stored('a.txt', body('本文')), { ...stored('b.bin', ascii('x')), method: 12 }]) },
    {
      name: 'deflate cut at the declared size',
      zip: buildZip([{ ...deflated('a.txt', body('あいうえおかきくけこ')), size: 12 }]),
    },
    {
      name: 'deflate shorter than the declared size',
      zip: buildZip([{ ...deflated('a.txt', body('あいうえお')), size: 1000 }]),
    },
    {
      name: 'deflate with no data gives zeros',
      zip: buildZip([{ ...stored('a.txt', new Uint8Array(0)), method: 8, size: 6 }]),
    },
    {
      name: 'corrupt deflate in another entry',
      zip: buildZip([stored('a.txt', body('本文')), { ...stored('b.png', new Uint8Array(8).fill(0xff)), method: 8 }]),
      inflateError: true,
    },
    {
      name: 'truncated deflate',
      zip: (() => {
        const entry = deflated('a.txt', sample)
        return buildZip([{ ...entry, data: entry.data.subarray(0, entry.data.length >> 1) }])
      })(),
      inflateError: true,
    },
    { name: 'empty data', zip: new Uint8Array(0) },
    { name: 'not a zip', zip: ascii('This is not a zip file, just some text that is long enough.') },
    {
      name: 'cut short',
      zip: (() => {
        const bytes = zip({ 'a.txt': sample })
        return bytes.subarray(0, bytes.length - 1)
      })(),
    },
    { name: 'unmapped bytes only', zip: zip({ 'work.txt': new Uint8Array(100).fill(0xa0) }) },
    // 0x80 is U+0080 in Electron (Node's own ICU gives U+FFFD).
    { name: '0x80 bytes', zip: zip({ 'work.txt': new Uint8Array(100).fill(0x80) }) },
    // 1 U+FFFD in 200 units is exactly the threshold (not over it); in 199 it
    // is over.
    { name: 'replacement ratio at the threshold', zip: zip({ 'a.txt': Uint8Array.of(0x0a, ...ascii('a'.repeat(198)), 0xa0) }) },
    { name: 'replacement ratio over the threshold', zip: zip({ 'a.txt': Uint8Array.of(0x0a, ...ascii('a'.repeat(197)), 0xa0) }) },
    { name: 'empty txt', zip: zip({ 'a.txt': new Uint8Array(0) }) },
    { name: 'title only', zip: zip({ 'a.txt': ascii('OnlyTitleLine') }) },
    { name: 'gaiji past U+10FFFF', zip: zip({ 'a.txt': body('前※［＃U+110000］後') }) },
    { name: 'gaiji lone surrogate', zip: zip({ 'a.txt': body('前※［＃U+D800］後') }) },
    { name: 'invalid shift_jis bytes', zip: zip({ 'a.txt': Uint8Array.of(0x0a, ...encode('本文'.repeat(200)), 0x81, 0x7f, 0xfd) }) },
  ]
  return cases
}
