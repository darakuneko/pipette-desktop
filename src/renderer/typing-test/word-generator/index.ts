// SPDX-License-Identifier: GPL-3.0-or-later
// Based on Monkeytype (https://github.com/monkeytypegame/monkeytype)

export { generateWords, generateWordsSync, getLanguageData, getLanguageDataSync, clearLanguageCache, injectPunctuation, injectNumbers } from './word-generator'
export { selectQuote, quoteToWords } from './quote-generator'
export { getFileImportTextData, getFileImportTextDataSync, clearFileImportTextCache } from './file-import-text'
export type { FileImportTextData } from './file-import-text'
export { getTatoebaPack, getTatoebaPackSync, clearTatoebaPackCache, tatoebaRun, TATOEBA_SENTENCE_COUNT } from './tatoeba-pack'
export type { TatoebaPack } from './tatoeba-pack'
export type { LanguageData, GenerateOptions, GeneratedWords } from './types'
// Only the type is re-exported here — sampleWords/word-generator.ts's own
// callers reach `wordWeakSpotScore`/`pickWeightedIndex`/`WEAK_SPOT_BIAS_RATIO`
// by importing straight from './weak-spot-weighting' (they're internal to
// the sampling algorithm, not part of this barrel's public surface).
export type { WeakSpotBiasProfile } from './weak-spot-weighting'
