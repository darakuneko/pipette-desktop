// SPDX-License-Identifier: GPL-3.0-or-later
// Based on Monkeytype (https://github.com/monkeytypegame/monkeytype)

export { generateWords, generateWordsSync, getLanguageData, getLanguageDataSync, injectPunctuation, injectNumbers } from './word-generator'
export { selectQuote, quoteToWords } from './quote-generator'
export { getCustomTextData, getCustomTextDataSync, clearCustomTextCache } from './custom-text'
export type { CustomTextData } from './custom-text'
export type { LanguageData, GenerateOptions, GeneratedWords } from './types'
