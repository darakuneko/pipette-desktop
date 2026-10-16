// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-js-json: runs the real
// JSON.parse and JSON.stringify over a list of texts and records whether
// each one parses and what it stringifies back to with no gap, two spaces
// and a tab; and records String(n) for a list of doubles given by their
// bits (edge cases and seeded pseudo-random ones). The Rust crate must
// give the same results.
//
// Run: pnpm run generate:js-json-fixtures

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { random32 } from '../fixture-random'
import { REPO_ROOT } from '../fixture-vitest-config'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-js-json/tests/fixtures/js_json.json')

const TEXTS = [
  // Literals and whitespace.
  'null', 'true', 'false', ' \t\n\r1 \r\n', '""', '{}', '[]', '[ ]', '{ }',
  // Numbers.
  '0', '-0', '-0.0', '0e5', '1', '-1', '1.5', '1E2', '1e+2', '1e-2', '1.0', '100',
  '9007199254740991', '9007199254740992', '9007199254740993', '18446744073709551616',
  '123456789012345678901234567890', '1e21', '1e20', '123e-20', '1e-7', '1e-6', '0.000001',
  '0.1', '0.30000000000000004', '1e400', '-1e400', '1e-400', '-1e-400', '5e-324', '2e-324',
  '1.7976931348623157e308', '4.9406564584124654e-324', '2.2250738585072014e-308',
  '0.1e1', '12345678901234567e-5',
  // Object key order: array indexes, duplicates, special names.
  '{"b":1,"a":2}',
  '{"b":1,"10":2,"a":3,"2":4,"0":5}',
  '{"4294967294":1,"4294967295":2,"4294967296":3,"x":4}',
  '{"01":1,"1":2,"-0":3,"-1":4,"1.0":5,"1e2":6," 1":7}',
  '{"a":1,"b":2,"a":3}',
  '{"1":1,"a":2,"1":3}',
  '{"__proto__":1,"constructor":2,"prototype":3}',
  '{"":1,"\\u0000":2}',
  '{"a":{"z":1,"9":2},"list":[{"y":1,"3":2}]}',
  // Strings and escapes.
  '"plain"', '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\u0000\\u001f\\u0020\\u007f\\u0080"',
  '"\\u2028\\u2029"', '"日本語 é 😀"', '"\\u65E5\\u672c"', '"\\ud83d\\ude00"', '"\\uD83D\\uDE00"',
  '"\\ud800"', '"\\udc00"', '"a\\ud800b"', '"\\ude00\\ud83d"', '"\\ud800\\ud800"', '"\\ud83d\\u0041"',
  '{"\\ud800":1}', '"tab\there"'.replace('\t', '\\t'),
  // Nesting and indentation.
  '[1,[2,[3,[]]],{"a":{"b":{}}}]', '{"a":[],"b":{},"c":[{}],"d":[[]]}', '[null,true,false,"x",0.5]',
  // Not JSON.
  '', ' ', '﻿{}', '01', '-01', '1.', '.5', '+1', '-', '1e', '1e+', '0x10', 'Infinity', 'NaN',
  '[1,]', '{"a":1,}', '{a:1}', "{'a':1}", "'a'", '"\\x"', '"\\u12"', '"\\u12G4"', '"a\nb"', '"a\tb"',
  '"\u0001"', '[1] x', '[1]]', '{"a" 1}', '{"a":}', '[', '{', '"', 'nul', 'tru', ' 1', ' 1',
  '//c\n1', '/*c*/1', 'undefined',
]

const GAPS = { compact: undefined, twoSpaces: '  ', tab: '\t' } as const

function bitsOf(n: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, n)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

function fromBits(high: number, low: number): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setUint32(0, high)
  view.setUint32(4, low)
  return view.getFloat64(0)
}

const EDGE_NUMBERS = [
  0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 100, 1e21, 1e20, 999999999999999900000, 1e-6, 1e-7, 1.5e-7,
  123e-20, 2 ** 53, 2 ** 53 + 2, 2 ** 64, Number.MAX_VALUE, Number.MIN_VALUE, 2.2250738585072014e-308,
  Number.EPSILON, Math.PI, -Math.E, 5e-324, 1.7976931348623157e308, 4294967295, 4294967296, 0.5, 49.5,
  200.5, 123456789.123456789, 1e100, 1e-100,
]

function numberCases(): { bits: string; text: string }[] {
  const next = random32(0x5eed)
  const numbers = [...EDGE_NUMBERS]
  for (let i = 0; i < 1500; i++) {
    const n = fromBits(next(), next())
    if (Number.isFinite(n)) numbers.push(n)
  }
  // Short decimals, the kind people write.
  for (let i = 0; i < 500; i++) {
    numbers.push(Number(((next() % 2_000_000) - 1_000_000) / 10 ** (next() % 8)))
  }
  return numbers.map((n) => ({ bits: bitsOf(n), text: String(n) }))
}

describe('JSON fixtures', () => {
  it('records JSON.parse and JSON.stringify of each text and String() of each number', () => {
    const texts = TEXTS.map((text) => {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return { text, ok: false }
      }
      const out: Record<string, unknown> = { text, ok: true }
      for (const [name, gap] of Object.entries(GAPS)) out[name] = JSON.stringify(value, undefined, gap)
      return out
    })
    writeJsonFixture(OUT, { texts, numbers: numberCases() })

    expect(texts.some((c) => c.ok)).toBe(true)
    expect(texts.some((c) => !c.ok)).toBe(true)
  })
})
