// SPDX-License-Identifier: GPL-3.0-or-later
// Based on Monkeytype (https://github.com/monkeytypegame/monkeytype)

export interface LanguageData {
  name: string
  rightToLeft: boolean
  ligatures?: boolean
  orderedByFrequency: boolean
  bcp47: string
  words: string[]
  additionalAccents?: [string, string][]
  noLazyMode?: boolean
}

export interface GenerateOptions {
  punctuation?: boolean
  numbers?: boolean
}

export interface GeneratedWords {
  words: string[]
  /** The RAW (pre-decoration) word actually sampled for the last slot,
   *  before `injectNumbers`/`injectPunctuation` ran — never `words`'s own
   *  last entry, which may be capitalized/punctuated/digit-replaced.
   *  `sampleWords`' own repeat-avoidance always compares a `seedLastWord`
   *  argument against RAW candidates pulled straight from the language's
   *  word list, so a caller seeding a follow-up call (e.g. a time-mode
   *  refill) must pass this, not a decorated word — see word-supply.ts's
   *  `refillTimeModeWords`. */
  lastRawWord: string
}
