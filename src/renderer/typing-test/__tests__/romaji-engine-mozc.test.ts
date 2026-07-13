// SPDX-License-Identifier: GPL-2.0-or-later
//
// mozc compliance sweep: the romaji engine's tables must stay in exact
// correspondence with Google mozc's IME romaji input table. The fixture
// `fixtures/mozc-romanji-hiragana.tsv` is a verbatim copy of
// mozc `src/data/preedit/romanji-hiragana.tsv` (Copyright Google Inc.,
// BSD-3-Clause; redistribution with attribution permitted). When mozc
// updates its table, re-copy the file and re-run this suite — any drift
// between the fixture and KANA_TABLE / sokuon / ん handling fails here.
// Policy and scope details: .claude/docs/ROMAJI-ENGINE.md.
//
// TSV format: `input \t output \t pending?`. Three row classes matter:
// - plain kana rows (2 columns, kana output) → KANA_TABLE entries
// - っ rows with a pending column (kk → っ + k) → consonant doubling
// - っ rows without pending (xtu/xtsu/ltu/ltsu) and ん rows (n/nn/xn/n')
//   → the runtime-derived sokuon/ん pattern lists
// Out of scope: symbol rows (punctuation, z-series arrows/brackets) and
// the `www → w + ww` laughter special case — typing-test words are kana
// only. ヵ/ヶ are normalized to ゕ/ゖ to match the word packs' hiragana.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  createRomajiMatcher,
  KANA_TABLE,
  SOKUON_EXPLICIT_PATTERNS,
  N_PATTERNS_SINGLE_OR_DOUBLE,
} from '../romaji-engine'
import { toHiragana } from '../kana-script'

const FIXTURE = fileURLToPath(new URL('./fixtures/mozc-romanji-hiragana.tsv', import.meta.url))

// Word-pack alphabet: hiragana block incl. ゔ/ゕ/ゖ, plus the long-vowel mark.
const KANA_OUTPUT_RE = /^[ぁ-ゖー]+$/

interface MozcTable {
  kana: Map<string, Set<string>>
  sokuonExplicit: Set<string>
  /** doubled-consonant rows: full input (kk, tch) -> pending remainder (k, ch) */
  doubling: Map<string, string>
  n: Set<string>
}

function parseMozcTsv(): MozcTable {
  const kana = new Map<string, Set<string>>()
  const sokuonExplicit = new Set<string>()
  const doubling = new Map<string, string>()
  const n = new Set<string>()
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const [input, rawOutput, pending] = line.split('\t')
    const output = [...(rawOutput ?? '')].map(toHiragana).join('')
    if (output === 'っ' && pending) {
      doubling.set(input, pending)
    } else if (output === 'っ') {
      sokuonExplicit.add(input)
    } else if (output === 'ん') {
      n.add(input)
    } else if (!pending && KANA_OUTPUT_RE.test(output)) {
      if (!kana.has(output)) kana.set(output, new Set())
      kana.get(output)!.add(input)
    }
    // else: symbol row or the www special case — out of scope by design
  }
  return { kana, sokuonExplicit, doubling, n }
}

const mozc = parseMozcTsv()

describe('KANA_TABLE is in exact set correspondence with the mozc table', () => {
  it('parsed a plausible number of kana rows from the fixture', () => {
    expect(mozc.kana.size).toBeGreaterThan(150)
  })

  it.each([...mozc.kana.keys()].sort())('mozc kana %s: spelling sets match exactly', (kana) => {
    const ours = KANA_TABLE[kana]
    expect(ours, `KANA_TABLE is missing an entry for ${kana}`).toBeDefined()
    expect([...(ours ?? [])].sort()).toEqual([...mozc.kana.get(kana)!].sort())
  })

  it('has no KANA_TABLE entries mozc does not define', () => {
    const extras = Object.keys(KANA_TABLE).filter((kana) => !mozc.kana.has(kana))
    expect(extras).toEqual([])
  })
})

describe('runtime-derived pattern lists match the mozc table', () => {
  it('explicit っ spellings match', () => {
    expect([...SOKUON_EXPLICIT_PATTERNS].sort()).toEqual([...mozc.sokuonExplicit].sort())
  })

  it('ん spellings match', () => {
    expect([...N_PATTERNS_SINGLE_OR_DOUBLE].sort()).toEqual([...mozc.n].sort())
  })
})

describe('matcher accepts every mozc input for its kana', () => {
  const cases: Array<[string, string]> = []
  for (const [kana, inputs] of [...mozc.kana.entries()].sort()) {
    for (const input of [...inputs].sort()) cases.push([kana, input])
  }

  it.each(cases)('%s completes when typed as %s', (kana, input) => {
    const matcher = createRomajiMatcher(kana)
    for (const char of input) expect(matcher.acceptChar(char)).not.toBe('reject')
    expect(matcher.isComplete()).toBe(true)
  })
})

describe('matcher accepts every mozc consonant-doubling row', () => {
  // For each doubling row (input `kk` yielding っ with `k` still pending),
  // pick the first kana entry whose spelling starts with the pending
  // remainder and verify っ+kana completes when typed as the doubled
  // input followed by the rest of that spelling (kk + ka → っか "kka",
  // tch + chi's tail → っち "tchi").
  const cases: Array<[string, string, string]> = [] // [word, keys, rowInput]
  const kanaEntries = [...mozc.kana.entries()]
  for (const [input, pending] of [...mozc.doubling.entries()].sort()) {
    const sample = kanaEntries
      .flatMap(([kana, inputs]) => [...inputs].filter((i) => i.startsWith(pending)).map((i) => [kana, i] as const))
      .sort((a, b) => a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1))[0]
    expect(sample, `no kana spelling starts with pending "${pending}" (row ${input})`).toBeDefined()
    const [kana, spelling] = sample
    const prefix = input.slice(0, input.length - pending.length)
    cases.push(['っ' + kana, prefix + spelling, input])
  }

  it.each(cases)('%s completes when typed as %s (mozc row %s)', (word, keys) => {
    const matcher = createRomajiMatcher(word)
    for (const char of keys) expect(matcher.acceptChar(char)).not.toBe('reject')
    expect(matcher.isComplete()).toBe(true)
  })
})
