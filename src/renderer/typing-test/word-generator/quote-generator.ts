// SPDX-License-Identifier: GPL-2.0-or-later

import type { Quote, QuoteLength } from '../types'
import quotes from '../languages/english-quotes.json'
import { randomInt } from './random'

// All typeable characters: letters, digits, and all US ANSI symbols (unshifted + shifted)
const ALLOWED_CHARS = /[^a-zA-Z0-9 .,;'\-/!?:"()@#$%^&*_+=\[\]{}|\\`~<>]/g

const LENGTH_RANGES: Record<QuoteLength, [number, number]> = {
  short: [0, 100],
  medium: [101, 300],
  long: [301, Infinity],
  all: [0, Infinity],
}

export function selectQuote(length: QuoteLength): Quote {
  const [min, max] = LENGTH_RANGES[length]
  const filtered = (quotes as Quote[]).filter(
    (q) => q.length >= min && q.length <= max,
  )

  if (filtered.length === 0) {
    return (quotes as Quote[])[randomInt(0, (quotes as Quote[]).length - 1)]
  }

  return filtered[randomInt(0, filtered.length - 1)]
}

export function quoteToWords(quote: Quote): string[] {
  return quote.text
    .split(/\s+/)
    .map((w) => w.replace(ALLOWED_CHARS, ''))
    .filter((w) => w.length > 0)
}
