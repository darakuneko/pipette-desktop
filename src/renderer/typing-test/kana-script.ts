// SPDX-License-Identifier: GPL-2.0-or-later
//
// Re-exports the shared hiragana <-> katakana conversion so renderer code
// can import it from typing-test/. The implementation lives in
// shared/kana-script.ts so the main process's kana-purity check can use
// the same codepoint offsets without a renderer dependency.
export { toHiragana, toKatakana } from '../../shared/kana-script'
