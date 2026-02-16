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
}
