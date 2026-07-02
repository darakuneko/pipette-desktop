// SPDX-License-Identifier: GPL-2.0-or-later
// Tatoeba sentence packs for the typing test. Distributed via the Hub-only
// 'tatoeba' provider and cached per language, then played through the quote
// path: a batch of sampled sentences is concatenated into a single quote so
// the word-flow renderer and char-based counting are reused verbatim.

import type { Quote } from '../types'
import { randomInt } from './random'

/** Sentences sampled per test — sized to feel like a words/quote run given
 *  the short, independent daily sentences Tatoeba packs contain. */
export const TATOEBA_SENTENCE_COUNT = 5

/** A downloaded Tatoeba pack: `words` are full sentences, not tokens. */
export interface TatoebaPack {
  name: string
  words: string[]
}

const packCache = new Map<string, TatoebaPack>()

function isPack(v: unknown): v is TatoebaPack {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.name === 'string' && Array.isArray(p.words) && p.words.every((w) => typeof w === 'string')
}

export function getTatoebaPackSync(language: string): TatoebaPack | undefined {
  return packCache.get(language)
}

export async function getTatoebaPack(language: string): Promise<TatoebaPack | undefined> {
  const cached = packCache.get(language)
  if (cached) return cached

  const data = await window.vialAPI.langGet(language, 'tatoeba')
  if (!isPack(data)) return undefined
  packCache.set(language, data)
  return data
}

/** Drop cached packs so the next read re-fetches from disk. Called after a
 *  download / delete / dataset update changes the on-disk pack files, so a
 *  stale copy is never played for the rest of the session. */
export function clearTatoebaPackCache(language?: string): void {
  if (language) {
    packCache.delete(language)
  } else {
    packCache.clear()
  }
}

/** Sample a batch of sentences and fold them into one quote for the word-flow
 *  path. `source` carries the pack name so the finished screen can label it. */
export function tatoebaQuote(pack: TatoebaPack): Quote {
  const text = sampleSentences(pack.words, TATOEBA_SENTENCE_COUNT).join(' ')
  return { id: 0, text, source: pack.name, length: text.length }
}

/** Tokenize a Tatoeba quote into word-flow display units. Deliberately NOT
 *  `quoteToWords` — that function whitelist-strips to ASCII, which is correct
 *  for MonkeyType's English quotes but destroys Tatoeba sentences in any
 *  non-ASCII script (Japanese, Cyrillic, accented Latin, etc. — most of the
 *  72 Tatoeba languages). Splits on whitespace only and keeps every
 *  character as-is, mirroring parseFileImportText's script-agnostic
 *  tokenizer. */
export function tatoebaQuoteToWords(quote: Quote): string[] {
  return quote.text.split(/\s+/).filter((w) => w.length > 0)
}

/** Pick `count` sentences, avoiding an immediate repeat (mirrors sampleWords). */
function sampleSentences(list: readonly string[], count: number): string[] {
  if (list.length === 0) return []
  if (list.length <= count) return [...list]

  const result: string[] = []
  let lastIdx = -1
  for (let i = 0; i < count; i++) {
    let idx = randomInt(0, list.length - 1)
    let attempts = 0
    while (idx === lastIdx && attempts < 100) {
      idx = randomInt(0, list.length - 1)
      attempts++
    }
    result.push(list[idx])
    lastIdx = idx
  }
  return result
}
