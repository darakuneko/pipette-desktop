// SPDX-License-Identifier: GPL-2.0-or-later
// Tatoeba sentence packs for the typing test. Distributed via the Hub-only
// 'tatoeba' provider and cached per language, then played through the quote
// path: a batch of sampled sentences is folded into one quote (for char-based
// counting and the finished-screen source label) while keeping each
// sentence's word span, so line breaks can be placed at sentence boundaries.

import { parseFileImportText } from '../../../shared/types/typing-test-text-store'
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

/** A sampled batch of Tatoeba sentences, tokenized into word-flow units with
 *  a line break recorded at every sentence boundary (same convention as
 *  `parseFileImportText`: the index of each sentence's last word, except
 *  the final sentence). */
export interface TatoebaRun {
  words: string[]
  lineBreaks: number[]
  quote: Quote
}

/** Sample a batch of sentences and build a word-flow run that renders each
 *  sentence on its own line. Encodes the sentences with `parseFileImportText`
 *  (one sentence per line) — deliberately NOT `quoteToWords`, whose ASCII
 *  whitelist would destroy Tatoeba sentences in any non-ASCII script
 *  (Japanese, Cyrillic, accented Latin, etc. — most of the 72 Tatoeba
 *  languages). `quote` folds every sampled sentence into one string so the
 *  finished screen can label the source and char-based progress counting is
 *  reused verbatim. */
export function tatoebaRun(pack: TatoebaPack): TatoebaRun {
  const sentences = sampleSentences(pack.words, TATOEBA_SENTENCE_COUNT)
  const { words, lineBreaks } = parseFileImportText(sentences.join('\n'))
  const text = words.join(' ')
  return { words, lineBreaks, quote: { id: 0, text, source: pack.name, length: text.length } }
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
