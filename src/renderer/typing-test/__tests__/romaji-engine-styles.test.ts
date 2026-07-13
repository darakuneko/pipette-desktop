// SPDX-License-Identifier: GPL-2.0-or-later
//
// Tests for the RomajiStyle spelling tags and the createRomajiMatcher
// disabledStyles/guideStyle options (Plan-typing-romaji-settings-modal
// Step 1). Complements romaji-engine.test.ts, which covers the untagged,
// opts-less matcher behaviour that must stay byte-for-byte unchanged.

import { describe, it, expect } from 'vitest'
import { createRomajiMatcher, KANA_TABLE, type RomajiAcceptResult, type RomajiStyle } from '../romaji-engine'

const ALL_STYLES: readonly RomajiStyle[] = ['kunrei', 'cq', 'digraph', 'xSmall', 'lSmall']

function type(
  word: string,
  keys: string,
  opts?: Parameters<typeof createRomajiMatcher>[1],
): { matcher: ReturnType<typeof createRomajiMatcher>; results: RomajiAcceptResult[] } {
  const matcher = createRomajiMatcher(word, opts)
  const results: RomajiAcceptResult[] = []
  for (const key of keys) results.push(matcher.acceptChar(key))
  return { matcher, results }
}

describe('disabledStyles: per-style acceptance', () => {
  it('kunrei OFF rejects si (し) but still accepts shi', () => {
    const rejected = type('し', 'si', { disabledStyles: ['kunrei'] })
    expect(rejected.results.at(-1)).toBe('reject')

    const accepted = type('し', 'shi', { disabledStyles: ['kunrei'] })
    expect(accepted.results.at(-1)).toBe('complete')
    expect(accepted.matcher.typedRomaji()).toBe('shi')
  })

  it('kunrei OFF also rejects the youon alternates (sya/zya/tya) but keeps the Hepburn spellings', () => {
    expect(type('しゃ', 'sya', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('reject')
    expect(type('しゃ', 'sha', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('complete')

    expect(type('じゃ', 'zya', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('reject')
    expect(type('じゃ', 'ja', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('complete')

    expect(type('ちゃ', 'tya', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('reject')
    expect(type('ちゃ', 'cha', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('complete')
  })

  it('cq OFF rejects ca (か) but still accepts ka', () => {
    expect(type('か', 'ca', { disabledStyles: ['cq'] }).results.at(-1)).toBe('reject')
    expect(type('か', 'ka', { disabledStyles: ['cq'] }).results.at(-1)).toBe('complete')
  })

  it('cq OFF rejects qu (く) but still accepts ku', () => {
    expect(type('く', 'qu', { disabledStyles: ['cq'] }).results.at(-1)).toBe('reject')
    expect(type('く', 'ku', { disabledStyles: ['cq'] }).results.at(-1)).toBe('complete')
  })

  it('digraph OFF rejects the leftover youon j-alternate (jya) but keeps ja/zya', () => {
    // "jya" shares its first letter with the still-live "ja", so the
    // sequence doesn't reject outright — the 'y' keystroke is what
    // rejects (buffer stays "j", a live prefix of "ja"), after which the
    // final 'a' silently completes via "ja" instead. Asserting a 'reject'
    // shows up somewhere is what actually proves "jya" itself is gone.
    const jya = type('じゃ', 'jya', { disabledStyles: ['digraph'] })
    expect(jya.results).toContain('reject')
    expect(jya.matcher.typedRomaji()).not.toBe('jya')

    expect(type('じゃ', 'ja', { disabledStyles: ['digraph'] }).results.at(-1)).toBe('complete')
    expect(type('じゃ', 'zya', { disabledStyles: ['digraph'] }).results.at(-1)).toBe('complete')
  })

  it('digraph OFF rejects whi (うぃ) but keeps its canonical spelling (wi)', () => {
    // Same prefix-collision shape as jya/ja above: 'w' stays live (prefix
    // of "wi"), 'h' is what actually rejects.
    const whi = type('うぃ', 'whi', { disabledStyles: ['digraph'] })
    expect(whi.results).toContain('reject')
    expect(whi.matcher.typedRomaji()).not.toBe('whi')

    expect(type('うぃ', 'wi', { disabledStyles: ['digraph'] }).results.at(-1)).toBe('complete')
  })

  it('digraph OFF still accepts the canonical spelling of a single-spelling 2-kana entry (dhi for でぃ)', () => {
    // でぃ has only one spelling in KANA_TABLE (canonical, untagged), so
    // digraph OFF has nothing to remove here — completability is
    // guaranteed by design decision #2 (canonical is always accepted).
    const { matcher, results } = type('でぃ', 'dhi', { disabledStyles: ['digraph'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('dhi')
  })

  it('xSmall OFF rejects xn (ん) but still accepts n/nn', () => {
    // ん's own single-tap "n" requires a following context that doesn't
    // force double-tap; "hon" (word-final) is that context. Typing "x"
    // rejects outright (no live pattern starts with "x"); the following
    // "n" is then just a fresh, valid keystroke on its own, so the last
    // result is 'accept' rather than 'reject' — the reject shows up
    // mid-sequence instead.
    const hoxn = type('ほん', 'hoxn', { disabledStyles: ['xSmall'] })
    expect(hoxn.results).toContain('reject')
    expect(hoxn.matcher.typedRomaji()).not.toBe('hoxn')

    expect(type('ほん', 'hon', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('accept')
    expect(type('ほん', 'honn', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
  })

  it('lSmall OFF rejects la (ぁ) but still accepts xa', () => {
    expect(type('ぁ', 'la', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('reject')
    expect(type('ぁ', 'xa', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('complete')
  })

  it('xSmall OFF rejects xa (ぁ) but still accepts la', () => {
    expect(type('ぁ', 'xa', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('reject')
    expect(type('ぁ', 'la', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
  })

  it('xSmall OFF rejects the dexi decomposition of でぃ but keeps deli and dhi', () => {
    expect(type('でぃ', 'dexi', { disabledStyles: ['xSmall'] }).results).toContain('reject')
    expect(type('でぃ', 'deli', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
    expect(type('でぃ', 'dhi', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
  })

  it('lSmall OFF rejects the deli decomposition of でぃ but keeps dexi and dhi', () => {
    expect(type('でぃ', 'deli', { disabledStyles: ['lSmall'] }).results).toContain('reject')
    expect(type('でぃ', 'dexi', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('complete')
    expect(type('でぃ', 'dhi', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('complete')
  })

  it('lSmall OFF rejects the explicit small-tsu l-forms (ltu/ltsu) but keeps xtu', () => {
    expect(type('あっ', 'altu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('reject')
    expect(type('あっ', 'altsu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('reject')
    expect(type('あっ', 'axtu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('complete')
  })

  it('xSmall OFF rejects the explicit small-tsu x-form (xtu) but keeps ltu/ltsu', () => {
    expect(type('あっ', 'axtu', { disabledStyles: ['xSmall'] }).results).toContain('reject')
    expect(type('あっ', 'altu', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
    expect(type('あっ', 'altsu', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
  })

  it("xSmall OFF never touches ん's forced double-tap context — nn is untagged, so the guard has nothing to do", () => {
    // ん before な forces the double-only pattern set ['nn', 'xn'];
    // removing 'xn' still leaves 'nn', so filtering alone (no guard)
    // keeps the word typable.
    expect(type('まんな', 'mannna', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
    const maxnna = type('まんな', 'maxnna', { disabledStyles: ['xSmall'] })
    expect(maxnna.results).toContain('reject')
    expect(maxnna.matcher.typedRomaji()).not.toBe('maxnna')
  })

  it('gemination derived from a filtered-out consonant spelling disappears along with it (kunrei OFF removes the tti-from-ti derivative of っち)', () => {
    // ち = ['chi', 'ti']; disabling kunrei removes 'ti', so the doubled
    // form derived from it ('tti') must disappear too, while the doubled
    // form derived from the surviving canonical ('chi' -> 'cchi') stays.
    expect(type('いっちゃ', 'ittya', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('reject')
    expect(type('いっちゃ', 'iccha', { disabledStyles: ['kunrei'] }).results.at(-1)).toBe('complete')
  })
})

describe('disabledStyles: multiple styles at once', () => {
  it('combines independently — kunrei+cq off on し leaves only shi', () => {
    expect(type('し', 'si', { disabledStyles: ['kunrei', 'cq'] }).results.at(-1)).toBe('reject')
    expect(type('し', 'ci', { disabledStyles: ['kunrei', 'cq'] }).results.at(-1)).toBe('reject')
    expect(type('し', 'shi', { disabledStyles: ['kunrei', 'cq'] }).results.at(-1)).toBe('complete')
  })

  it('xSmall+lSmall both OFF: the dynamic guard revives the canonical x-form for a standalone small kana', () => {
    // Filtering removes both spelling families, which would leave ぁ with
    // no spelling at all; filterByStyle's guard keeps the canonical
    // (x-form) alive in exactly that case.
    const { matcher, results } = type('ぁ', 'xa', { disabledStyles: ['xSmall', 'lSmall'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)

    // The l-form stays dead: the guard revives only the canonical.
    expect(type('ぁ', 'la', { disabledStyles: ['xSmall', 'lSmall'] }).results.at(-1)).toBe('reject')
  })

  it('xSmall+lSmall both OFF: でぃ completes via dhi, and the guard keeps the decomposition from dead-ending after "de"', () => {
    const opts = { disabledStyles: ['xSmall', 'lSmall'] as const }
    expect(type('でぃ', 'dhi', opts).results.at(-1)).toBe('complete')

    // "de" commits で on its own, stranding the matcher at ぃ. Without the
    // guard that position would have no live spelling left — an
    // unrecoverable dead end. The guard revives ぃ's canonical (xi), so
    // dexi still completes while deli stays rejected.
    expect(type('でぃ', 'dexi', opts).results.at(-1)).toBe('complete')
    expect(type('でぃ', 'deli', opts).results).toContain('reject')
  })

  it('xSmall+lSmall both OFF: word-final っ stays typable via its canonical xtu', () => {
    const opts = { disabledStyles: ['xSmall', 'lSmall'] as const }
    expect(type('あっ', 'axtu', opts).results.at(-1)).toBe('complete')
    expect(type('あっ', 'altu', opts).results).toContain('reject')
  })
})

describe('canonical-sweep: every word stays completable with all styles disabled', () => {
  const opts = { disabledStyles: ALL_STYLES }

  it.each(Object.entries(KANA_TABLE))('canonical spelling of "%s" still completes with every style disabled', (kana, patterns) => {
    const canonical = patterns[0]
    const { matcher, results } = type(kana, canonical, opts)
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(canonical)
  })

  const contextWords: ReadonlyArray<[word: string, canonicalKeys: string]> = [
    ['きって', 'kitte'], // っ via gemination
    ['あっ', 'axtu'], // っ via explicit tap at word end
    ['かんじ', 'kanji'], // ん single tap before a non-na-row kana
    ['ほん', 'honn'], // ん double tap at word end
    ['しんにゅう', 'shinnnyuu'], // ん forced double tap before a na-row kana
    ['まんな', 'mannna'], // ん forced double tap, three literal n's
    ['まっちゃ', 'maccha'], // っ doubling a youon digraph
    ['でぃなーにいく', 'dhina-niiku'], // digraph entry with no alternate spelling
  ]

  it.each(contextWords)('"%s" completes via its canonical spelling (%s) with every style disabled', (word, keys) => {
    const { matcher, results } = type(word, keys, opts)
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(keys)
  })
})

describe('guideStyle: display-only, never affects acceptance', () => {
  it('guideStyle does not change which keystrokes are accepted (dexi still completes でぃ with guideStyle=digraph)', () => {
    const { matcher, results } = type('でぃなーにいく', 'dexina-niiku', { guideStyle: 'digraph' })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('dexina-niiku')
  })

  it("guideStyle: 'auto' (or omitted) reproduces the pre-existing canonical/longest-match guide", () => {
    const withAuto = createRomajiMatcher('でぃなーにいく', { guideStyle: 'auto' })
    const withoutOpts = createRomajiMatcher('でぃなーにいく')
    expect(withAuto.remainingGuide()).toBe(withoutOpts.remainingGuide())
    expect(withAuto.remainingGuide()).toBe('dhina-niiku')
  })

  it("guideStyle: 'kunrei' prefers the kunrei alternate as the guide for し", () => {
    const matcher = createRomajiMatcher('し', { guideStyle: 'kunrei' })
    expect(matcher.remainingGuide()).toBe('si')
  })

  it("guideStyle: 'digraph' prefers the digraph alternate for じゃ", () => {
    const matcher = createRomajiMatcher('じゃ', { guideStyle: 'digraph' })
    expect(matcher.remainingGuide()).toBe('jya')
  })

  it("guideStyle: 'xSmall' shows the decomposed de+xi form for でぃ", () => {
    const matcher = createRomajiMatcher('でぃなーにいく', { guideStyle: 'xSmall' })
    expect(matcher.remainingGuide()).toBe('dexina-niiku')
  })

  it("guideStyle: 'lSmall' shows the decomposed de+li form for でぃ", () => {
    const matcher = createRomajiMatcher('でぃなーにいく', { guideStyle: 'lSmall' })
    expect(matcher.remainingGuide()).toBe('delina-niiku')
  })

  it("guideStyle: 'xSmall' still only changes display — dhi keeps completing", () => {
    const { matcher, results } = type('でぃなーにいく', 'dhina-niiku', { guideStyle: 'xSmall' })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('dhina-niiku')
  })

  it("guideStyle: 'xSmall' respects disabledStyles when picking the displayed spelling (falls back to the live l-form)", () => {
    // The guide is derived from the *filtered* spelling set, so with
    // xSmall disabled it can't show xi even when asked to prefer it.
    const matcher = createRomajiMatcher('ぁ', { guideStyle: 'xSmall', disabledStyles: ['xSmall'] })
    expect(matcher.remainingGuide()).toBe('la')
  })

  it('falls back to the usual canonical tie-break when no live spelling matches guideStyle', () => {
    // あ has only one spelling, so no style tag can ever apply to it.
    const matcher = createRomajiMatcher('あ', { guideStyle: 'kunrei' })
    expect(matcher.remainingGuide()).toBe('a')
  })

  it('re-derives the guide once earlier alternatives fall out of contention, respecting guideStyle throughout', () => {
    const matcher = createRomajiMatcher('でぃなーにいく', { guideStyle: 'digraph' })
    expect(matcher.remainingGuide()).toBe('dhina-niiku')
    matcher.acceptChar('d')
    expect(matcher.remainingGuide()).toBe('hina-niiku')
  })
})

describe('opts omitted or empty behaves exactly like the pre-existing no-opts matcher', () => {
  const words = ['でぃなーにいく', 'きって', 'かんじ', 'しゃちょう', 'コーヒー']

  it.each(words)('"%s": {} opts produce the same guide and acceptance sequence as no opts', (word) => {
    const bare = createRomajiMatcher(word)
    const empty = createRomajiMatcher(word, {})
    expect(empty.remainingGuide()).toBe(bare.remainingGuide())
    expect(empty.typedRomaji()).toBe(bare.typedRomaji())
  })

  it('an empty disabledStyles array behaves like no restriction at all', () => {
    const { results } = type('か', 'ca', { disabledStyles: [] })
    expect(results.at(-1)).toBe('complete')
  })
})
