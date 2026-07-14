// SPDX-License-Identifier: GPL-2.0-or-later
//
// Re-exports the shared hiragana <-> katakana conversion so this module's
// three existing renderer call sites (kana-initial.ts, romaji-engine.ts,
// romaji-engine-mozc.test.ts) keep working unchanged. The implementation
// moved to shared/kana-script.ts so the main process's kana-purity check
// can use the same codepoint offsets without a renderer dependency.
export { toHiragana, toKatakana } from '../../shared/kana-script'
