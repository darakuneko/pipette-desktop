// SPDX-License-Identifier: GPL-2.0-or-later
//
// Tests for the RomajiStyle spelling tags and the createRomajiMatcher
// disabledStyles/guideStyles options (Plan-typing-romaji-settings-modal
// Step 1, later subdivided into the 11-style Options layout). Complements
// romaji-engine.test.ts, which covers the untagged, opts-less matcher
// behaviour that must stay byte-for-byte unchanged.

import { describe, it, expect } from 'vitest'
import english from '../../i18n/locales/english.json'
import {
  createRomajiMatcher,
  KANA_TABLE,
  SPELLING_STYLES,
  SOKUON_EXPLICIT_PATTERNS,
  N_PATTERNS_SINGLE_OR_DOUBLE,
  type RomajiAcceptResult,
  type RomajiStyle,
} from '../romaji-engine'

// Every option style except the base pair (hepburn/kunrei) — kunrei is
// included since disabling it alone (keeping hepburn) never empties any
// entry; hepburn is deliberately excluded since disabling both bases at
// once is outside the invariant this sweep checks (see BASE_STYLES).
const ALL_STYLES: readonly RomajiStyle[] = ['kunrei', 'c', 'q', 'digraph', 'xSmall', 'lSmall', 'w', 'v', 'f', 'ye', 'xn', 'nApos']

// KANA_TABLE keys whose entry is a 2-kana digraph fully tagged by one of
// w/v/f/ye (canonical spelling included — see the SPELLING_STYLES header
// comment in romaji-engine.ts). Disabling that entry's own style empties
// its digraph option entirely (no guard — a decomposition fallback always
// exists), so the canonical-sweep test below can't type these entries'
// literal canonical string with ALL_STYLES disabled; they're excluded from
// that sweep and checked via their decomposed spelling in a dedicated block.
const DECOMPOSE_REQUIRED_ENTRIES: ReadonlySet<string> = new Set([
  'うぃ', 'うぇ', 'うぉ', 'ゔぁ', 'ゔぃ', 'ゔぇ', 'ゔぉ', 'ふぁ', 'ふぃ', 'ふぇ', 'ふぉ', 'ふゅ', 'いぇ',
])

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

  it('c OFF rejects ca (か) and cu (く) but still accepts ka/ku', () => {
    expect(type('か', 'ca', { disabledStyles: ['c'] }).results.at(-1)).toBe('reject')
    expect(type('か', 'ka', { disabledStyles: ['c'] }).results.at(-1)).toBe('complete')

    expect(type('く', 'cu', { disabledStyles: ['c'] }).results.at(-1)).toBe('reject')
    expect(type('く', 'ku', { disabledStyles: ['c'] }).results.at(-1)).toBe('complete')
    // q is a separate style now — c OFF alone leaves qu accepted.
    expect(type('く', 'qu', { disabledStyles: ['c'] }).results.at(-1)).toBe('complete')
  })

  it('c OFF rejects the youon c-alternate (cya) but keeps cha/tya', () => {
    const cya = type('ちゃ', 'cya', { disabledStyles: ['c'] })
    expect(cya.results).toContain('reject')
    expect(cya.matcher.typedRomaji()).not.toBe('cya')

    expect(type('ちゃ', 'cha', { disabledStyles: ['c'] }).results.at(-1)).toBe('complete')
    expect(type('ちゃ', 'tya', { disabledStyles: ['c'] }).results.at(-1)).toBe('complete')
  })

  it('q OFF rejects qu (く) but still accepts ku and cu', () => {
    expect(type('く', 'qu', { disabledStyles: ['q'] }).results.at(-1)).toBe('reject')
    expect(type('く', 'ku', { disabledStyles: ['q'] }).results.at(-1)).toBe('complete')
    expect(type('く', 'cu', { disabledStyles: ['q'] }).results.at(-1)).toBe('complete')
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

  it('digraph OFF still accepts the canonical spelling of a single-spelling 2-kana entry (dhi for でぃ)', () => {
    // でぃ has only one spelling in KANA_TABLE (canonical, untagged), so
    // digraph OFF has nothing to remove here — completability is
    // guaranteed by design decision #2 (canonical is always accepted).
    const { matcher, results } = type('でぃ', 'dhi', { disabledStyles: ['digraph'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('dhi')
  })

  it('xn OFF rejects xn (ん) but still accepts n/nn', () => {
    // ん's own single-tap "n" requires a following context that doesn't
    // force double-tap; "hon" (word-final) is that context. Typing "x"
    // rejects outright (no live pattern starts with "x"); the following
    // "n" is then just a fresh, valid keystroke on its own, so the last
    // result is 'accept' rather than 'reject' — the reject shows up
    // mid-sequence instead.
    const hoxn = type('ほん', 'hoxn', { disabledStyles: ['xn'] })
    expect(hoxn.results).toContain('reject')
    expect(hoxn.matcher.typedRomaji()).not.toBe('hoxn')

    expect(type('ほん', 'hon', { disabledStyles: ['xn'] }).results.at(-1)).toBe('accept')
    expect(type('ほん', 'honn', { disabledStyles: ['xn'] }).results.at(-1)).toBe('complete')
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

  it('lSmall OFF rejects the explicit small-tsu l-forms (ltu/ltsu) but keeps xtu/xtsu', () => {
    expect(type('あっ', 'altu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('reject')
    expect(type('あっ', 'altsu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('reject')
    expect(type('あっ', 'axtu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('complete')
    expect(type('あっ', 'axtsu', { disabledStyles: ['lSmall'] }).results.at(-1)).toBe('complete')
  })

  it('xSmall OFF rejects the explicit small-tsu x-forms (xtu/xtsu) but keeps ltu/ltsu', () => {
    expect(type('あっ', 'axtu', { disabledStyles: ['xSmall'] }).results).toContain('reject')
    expect(type('あっ', 'axtsu', { disabledStyles: ['xSmall'] }).results).toContain('reject')
    expect(type('あっ', 'altu', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
    expect(type('あっ', 'altsu', { disabledStyles: ['xSmall'] }).results.at(-1)).toBe('complete')
  })

  it("xn OFF never touches ん's forced double-tap context — nn is untagged, so the guard has nothing to do", () => {
    // ん before な forces the double-only pattern set ['nn', 'xn', "n'"];
    // removing 'xn' still leaves 'nn'/"n'", so filtering alone (no guard)
    // keeps the word typable.
    expect(type('まんな', 'mannna', { disabledStyles: ['xn'] }).results.at(-1)).toBe('complete')
    const maxnna = type('まんな', 'maxnna', { disabledStyles: ['xn'] })
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

  it('w OFF rejects the wi/whi digraph spellings of うぃ, forcing the u+xi/li decomposition', () => {
    // う's own remaining spelling ("u") doesn't start with "w", so typing
    // "w" rejects immediately — no prefix collision here (unlike v/f/ye
    // below, whose atomic first half keeps a "v"/"f"/"y"-starting spelling
    // alive).
    expect(type('うぃ', 'wi', { disabledStyles: ['w'] }).results.at(0)).toBe('reject')
    expect(type('うぃ', 'whi', { disabledStyles: ['w'] }).results.at(0)).toBe('reject')

    const { matcher: uxi, results: uxiResults } = type('うぃ', 'uxi', { disabledStyles: ['w'] })
    expect(uxiResults.at(-1)).toBe('complete')
    expect(uxi.typedRomaji()).toBe('uxi')

    const { matcher: uli, results: uliResults } = type('うぃ', 'uli', { disabledStyles: ['w'] })
    expect(uliResults.at(-1)).toBe('complete')
    expect(uli.typedRomaji()).toBe('uli')
  })

  it('w OFF rejects we/whe (うぇ) and who (うぉ), forcing decomposition', () => {
    expect(type('うぇ', 'we', { disabledStyles: ['w'] }).results.at(0)).toBe('reject')
    expect(type('うぇ', 'uxe', { disabledStyles: ['w'] }).results.at(-1)).toBe('complete')

    expect(type('うぉ', 'who', { disabledStyles: ['w'] }).results.at(0)).toBe('reject')
    expect(type('うぉ', 'uxo', { disabledStyles: ['w'] }).results.at(-1)).toBe('complete')
  })

  it('w OFF also rejects wu/whu for う itself (standalone, not part of a digraph) but keeps u', () => {
    expect(type('あう', 'awu', { disabledStyles: ['w'] }).results).toContain('reject')
    expect(type('あう', 'awhu', { disabledStyles: ['w'] }).results).toContain('reject')
    expect(type('あう', 'au', { disabledStyles: ['w'] }).results.at(-1)).toBe('complete')
  })

  it('v OFF rejects the va digraph spelling of ゔぁ, forcing the vu+xa/la decomposition', () => {
    // ゔ's own sole spelling ("vu") is tagged 'v' too, but it's reached via
    // the guarded single-kana branch (no decomposition of its own), so the
    // dynamic guard keeps "vu" alive there — which is exactly what the
    // decomposed path relies on. That guard-revived "vu" also means typing
    // "va" doesn't reject on the very first keystroke: "v" is still a live
    // prefix of the guarded "vu" option, so the rejection surfaces on "a".
    const va = type('ゔぁ', 'va', { disabledStyles: ['v'] })
    expect(va.results).toContain('reject')
    expect(va.matcher.typedRomaji()).not.toBe('va')

    const { matcher, results } = type('ゔぁ', 'vuxa', { disabledStyles: ['v'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('vuxa')
  })

  it('v OFF still leaves ゔ itself (standalone, not part of a digraph) typable as vu — the guard has a real effect there', () => {
    const { matcher, results } = type('ゔ', 'vu', { disabledStyles: ['v'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('vu')
  })

  it('f OFF rejects the fa digraph spelling of ふぁ, forcing the fu+xa/la decomposition', () => {
    // Same prefix-collision shape as v/va above: ふ's own "fu" (untouched
    // by 'f' — it's hepburn-tagged, not f-tagged) keeps "f" alive as a
    // prefix, so the rejection surfaces on "a" rather than "f".
    const fa = type('ふぁ', 'fa', { disabledStyles: ['f'] })
    expect(fa.results).toContain('reject')
    expect(fa.matcher.typedRomaji()).not.toBe('fa')

    const { matcher, results } = type('ふぁ', 'fuxa', { disabledStyles: ['f'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('fuxa')
  })

  it('f OFF leaves ふ itself untouched (fu/hu are hepburn/kunrei territory, not f)', () => {
    expect(type('ふ', 'fu', { disabledStyles: ['f'] }).results.at(-1)).toBe('complete')
    expect(type('ふ', 'hu', { disabledStyles: ['f'] }).results.at(-1)).toBe('complete')
  })

  it('ye OFF rejects ye (いぇ), forcing the i+xe/le decomposition', () => {
    // い's own "yi" alternate (untagged, unrelated to 'ye') keeps "y" alive
    // as a prefix, so the rejection surfaces on "e" rather than "y".
    const ye = type('いぇ', 'ye', { disabledStyles: ['ye'] })
    expect(ye.results).toContain('reject')
    expect(ye.matcher.typedRomaji()).not.toBe('ye')

    const { matcher, results } = type('いぇ', 'ixe', { disabledStyles: ['ye'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('ixe')
  })
})

describe('disabledStyles: multiple styles at once', () => {
  it('combines independently — kunrei+c off on し leaves only shi', () => {
    expect(type('し', 'si', { disabledStyles: ['kunrei', 'c'] }).results.at(-1)).toBe('reject')
    expect(type('し', 'ci', { disabledStyles: ['kunrei', 'c'] }).results.at(-1)).toBe('reject')
    expect(type('し', 'shi', { disabledStyles: ['kunrei', 'c'] }).results.at(-1)).toBe('complete')
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

describe("nApos: the n' ん-separator", () => {
  it("types かんい as kan'i (n' confirms ん before a vowel without a double tap)", () => {
    const { matcher, results } = type('かんい', "kan'i")
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe("kan'i")
  })

  it("word-final ん also confirms via n' (hon' completes ほん, same as hon/honn)", () => {
    const { matcher, results } = type('ほん', "hon'")
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe("hon'")
  })

  it("nApos OFF rejects the apostrophe continuation of a word-final ん, but the plain single/double tap still completes it", () => {
    const rejected = type('ほん', "hon'", { disabledStyles: ['nApos'] })
    expect(rejected.results.at(-1)).toBe('reject')
    expect(rejected.matcher.typedRomaji()).toBe('hon')
    expect(rejected.matcher.isComplete()).toBe(true)

    expect(type('ほん', 'hon', { disabledStyles: ['nApos'] }).results.at(-1)).toBe('accept')
    expect(type('ほん', 'honn', { disabledStyles: ['nApos'] }).results.at(-1)).toBe('complete')
  })

  it("nApos OFF rejects kan'i (the forced double-tap context loses its n' escape hatch) but kanni still completes", () => {
    const rejected = type('かんい', "kan'i", { disabledStyles: ['nApos'] })
    expect(rejected.results.at(-1)).toBe('reject')
    expect(rejected.matcher.typedRomaji()).toBe('kan')

    expect(type('かんい', 'kanni', { disabledStyles: ['nApos'] }).results.at(-1)).toBe('complete')
  })
})

describe('canonical-sweep: every word stays completable with all styles disabled', () => {
  const opts = { disabledStyles: ALL_STYLES }

  const sweepableEntries = Object.entries(KANA_TABLE).filter(([kana]) => !DECOMPOSE_REQUIRED_ENTRIES.has(kana))

  it.each(sweepableEntries)('canonical spelling of "%s" still completes with every style disabled', (kana, patterns) => {
    const canonical = patterns[0]
    const { matcher, results } = type(kana, canonical, opts)
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(canonical)
  })

  // w/v/f/ye tag every spelling of these 2-kana entries (canonical
  // included) and are exempted from filterByStyle's empty-set guard, since
  // a decomposition into (single kana) + (standalone small kana) always
  // remains — see the SPELLING_STYLES header comment. So with every style
  // disabled, these complete via their decomposed spelling instead of the
  // literal canonical string.
  const decomposedWords: ReadonlyArray<[word: string, decomposedKeys: string]> = [
    ['うぃ', 'uxi'],
    ['うぇ', 'uxe'],
    ['うぉ', 'uxo'],
    ['ゔぁ', 'vuxa'],
    ['ゔぃ', 'vuxi'],
    ['ゔぇ', 'vuxe'],
    ['ゔぉ', 'vuxo'],
    ['ふぁ', 'fuxa'],
    ['ふぃ', 'fuxi'],
    ['ふぇ', 'fuxe'],
    ['ふぉ', 'fuxo'],
    ['ふゅ', 'fuxyu'],
    ['いぇ', 'ixe'],
  ]

  it.each(decomposedWords)('"%s" completes via its decomposed spelling (%s) with every style disabled', (word, keys) => {
    const { matcher, results } = type(word, keys, opts)
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(keys)
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

describe('base toggle: hepburn OFF leaves kunrei-shiki a complete, self-sufficient system', () => {
  const opts = { disabledStyles: ['hepburn'] as const }

  it('rejects the Hepburn-specific alternates but accepts their kunrei-shiki counterparts', () => {
    const pairs: ReadonlyArray<[kana: string, hepburn: string, kunrei: string]> = [
      ['し', 'shi', 'si'],
      ['ち', 'chi', 'ti'],
      ['つ', 'tsu', 'tu'],
      ['ふ', 'fu', 'hu'],
      ['じ', 'ji', 'zi'],
      ['しゃ', 'sha', 'sya'],
      ['しゅ', 'shu', 'syu'],
      ['しょ', 'sho', 'syo'],
      ['ちゃ', 'cha', 'tya'],
      ['ちゅ', 'chu', 'tyu'],
      ['ちょ', 'cho', 'tyo'],
      ['じゃ', 'ja', 'zya'],
      ['じゅ', 'ju', 'zyu'],
      ['じょ', 'jo', 'zyo'],
    ]
    for (const [kana, hepburnSpelling, kunreiSpelling] of pairs) {
      // Some hepburn/kunrei spellings share a leading letter with a
      // still-live alternate (e.g. "shi" and "si" both start with "s"), so
      // a stray keystroke can resync into completing a *different* valid
      // pattern rather than dead-ending outright — same prefix-collision
      // shape as the pre-existing jya/ja and whi/wi cases above. Asserting
      // a 'reject' shows up somewhere, and that the full hepburn spelling
      // was never actually typed, is what proves the alternate is gone.
      const rejected = type(kana, hepburnSpelling, opts)
      expect(rejected.results).toContain('reject')
      expect(rejected.matcher.typedRomaji()).not.toBe(hepburnSpelling)

      expect(type(kana, kunreiSpelling, opts).results.at(-1)).toBe('complete')
    }
  })

  it('gemination derived from a hepburn-filtered consonant spelling disappears along with it (hepburn OFF removes the cchi-from-chi derivative of っちゃ, keeps ttya-from-tya)', () => {
    expect(type('いっちゃ', 'iccha', opts).results.at(-1)).toBe('reject')
    expect(type('いっちゃ', 'ittya', opts).results.at(-1)).toBe('complete')
  })

  it('the tch- derivative of っち disappears along with chi when hepburn is off, leaving only the kunrei-derived tti (botchi/bocchi reject, botti accepts)', () => {
    expect(type('ぼっち', 'botchi', opts).results).toContain('reject')
    expect(type('ぼっち', 'bocchi', opts).results).toContain('reject')
    expect(type('ぼっち', 'botti', opts).results.at(-1)).toBe('complete')
  })

  it.each(Object.entries(KANA_TABLE))('every KANA_TABLE entry stays completable via a non-Hepburn spelling with hepburn disabled (%s)', (kana, patterns) => {
    const spelling = patterns.find((p) => SPELLING_STYLES[`${kana}|${p}`] !== 'hepburn') ?? patterns[0]
    const { matcher, results } = type(kana, spelling, opts)
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(spelling)
  })

  const contextWordsKunrei: ReadonlyArray<[word: string, kunreiKeys: string]> = [
    ['きって', 'kitte'], // っ via gemination, no hepburn/kunrei kana involved
    ['あっ', 'axtu'], // っ via explicit tap at word end
    ['かんじ', 'kanzi'], // ん single tap before a non-na-row kana, kunrei じ
    ['ほん', 'honn'], // ん double tap at word end
    ['しんにゅう', 'sinnnyuu'], // ん forced double tap before a na-row kana, kunrei し
    ['まんな', 'mannna'], // ん forced double tap, three literal n's
    ['まっちゃ', 'mattya'], // っ doubling a youon digraph, kunrei ちゃ
    ['でぃなーにいく', 'dhina-niiku'], // digraph entry with no alternate spelling
  ]

  it.each(contextWordsKunrei)('"%s" completes via a kunrei-shiki spelling (%s) with hepburn disabled', (word, keys) => {
    const { matcher, results } = type(word, keys, opts)
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(keys)
  })

  it('remainingGuide naturally falls back to a kunrei-shiki spelling once hepburn is disabled, with no guideStyles override needed', () => {
    const matcher = createRomajiMatcher('しゃちょう', { disabledStyles: ['hepburn'] })
    expect(matcher.remainingGuide()).toBe('syatyou')
  })
})

describe('guideStyles: display-only, never affects acceptance', () => {
  it('guideStyles does not change which keystrokes are accepted (dexi still completes でぃ with guideStyles=[digraph])', () => {
    const { matcher, results } = type('でぃなーにいく', 'dexina-niiku', { guideStyles: ['digraph'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('dexina-niiku')
  })

  it('an empty/omitted guideStyles reproduces the pre-existing canonical/longest-match guide (the old \'auto\' behaviour)', () => {
    const withEmpty = createRomajiMatcher('でぃなーにいく', { guideStyles: [] })
    const withoutOpts = createRomajiMatcher('でぃなーにいく')
    expect(withEmpty.remainingGuide()).toBe(withoutOpts.remainingGuide())
    expect(withEmpty.remainingGuide()).toBe('dhina-niiku')
  })

  it("guideStyles: ['kunrei'] prefers the kunrei alternate as the guide for し", () => {
    const matcher = createRomajiMatcher('し', { guideStyles: ['kunrei'] })
    expect(matcher.remainingGuide()).toBe('si')
  })

  it("guideStyles: ['digraph'] prefers the digraph alternate for じゃ", () => {
    const matcher = createRomajiMatcher('じゃ', { guideStyles: ['digraph'] })
    expect(matcher.remainingGuide()).toBe('jya')
  })

  it("guideStyles: ['w'] prefers the W-notation digraph for うぃ", () => {
    const matcher = createRomajiMatcher('うぃ', { guideStyles: ['w'] })
    expect(matcher.remainingGuide()).toBe('wi')
  })

  it("guideStyles: ['v'] prefers va for ゔぁ", () => {
    const matcher = createRomajiMatcher('ゔぁ', { guideStyles: ['v'] })
    expect(matcher.remainingGuide()).toBe('va')
  })

  it("guideStyles: ['f'] prefers fa for ふぁ", () => {
    const matcher = createRomajiMatcher('ふぁ', { guideStyles: ['f'] })
    expect(matcher.remainingGuide()).toBe('fa')
  })

  it("guideStyles: ['nApos'] prefers n' for ん before a vowel", () => {
    const matcher = createRomajiMatcher('かんい', { guideStyles: ['nApos'] })
    expect(matcher.remainingGuide()).toBe("kan'i")
  })

  it("guideStyles: ['xSmall'] shows the decomposed de+xi form for でぃ", () => {
    const matcher = createRomajiMatcher('でぃなーにいく', { guideStyles: ['xSmall'] })
    expect(matcher.remainingGuide()).toBe('dexina-niiku')
  })

  it("guideStyles: ['lSmall'] shows the decomposed de+li form for でぃ", () => {
    const matcher = createRomajiMatcher('でぃなーにいく', { guideStyles: ['lSmall'] })
    expect(matcher.remainingGuide()).toBe('delina-niiku')
  })

  it("guideStyles: ['xSmall'] still only changes display — dhi keeps completing", () => {
    const { matcher, results } = type('でぃなーにいく', 'dhina-niiku', { guideStyles: ['xSmall'] })
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('dhina-niiku')
  })

  it("guideStyles: ['xSmall'] respects disabledStyles when picking the displayed spelling (falls back to the live l-form)", () => {
    // The guide is derived from the *filtered* spelling set, so with
    // xSmall disabled it can't show xi even when asked to prefer it.
    const matcher = createRomajiMatcher('ぁ', { guideStyles: ['xSmall'], disabledStyles: ['xSmall'] })
    expect(matcher.remainingGuide()).toBe('la')
  })

  it('falls back to the usual canonical tie-break when no live spelling matches any selected guide style', () => {
    // あ has only one spelling, so no style tag can ever apply to it.
    const matcher = createRomajiMatcher('あ', { guideStyles: ['kunrei'] })
    expect(matcher.remainingGuide()).toBe('a')
  })

  it('re-derives the guide once earlier alternatives fall out of contention, respecting guideStyles throughout', () => {
    const matcher = createRomajiMatcher('でぃなーにいく', { guideStyles: ['digraph'] })
    expect(matcher.remainingGuide()).toBe('dhina-niiku')
    matcher.acceptChar('d')
    expect(matcher.remainingGuide()).toBe('hina-niiku')
  })

  describe('multiple styles selected at once', () => {
    it('xSmall + kunrei each apply to the segment their own tag matches, independently, in the same guide', () => {
      // し -> kunrei's 'si' tag applies; でぃ has no tag of its own, so
      // xSmall's decomposing fallback walks it into で+ぃ, where ぃ's
      // xSmall-tagged 'xi' then surfaces.
      const matcher = createRomajiMatcher('しでぃ', { guideStyles: ['xSmall', 'kunrei'] })
      expect(matcher.remainingGuide()).toBe('sidexi')
    })

    it('acceptance is unaffected by combining styles — every spelling combination still completes the word', () => {
      const { matcher, results } = type('しでぃ', 'shideli', { guideStyles: ['xSmall', 'kunrei'] })
      expect(results.at(-1)).toBe('complete')
      expect(matcher.typedRomaji()).toBe('shideli')
    })

    it('when two selected styles could both tag the same segment, GUIDE_STYLE_PRIORITY order decides — not selection order', () => {
      // し's spellings: si (kunrei), ci (c). kunrei precedes c in
      // GUIDE_STYLE_PRIORITY, so it wins even though 'c' is listed first
      // in guideStyles here.
      const cFirst = createRomajiMatcher('し', { guideStyles: ['c', 'kunrei'] })
      expect(cFirst.remainingGuide()).toBe('si')

      const kunreiFirst = createRomajiMatcher('し', { guideStyles: ['kunrei', 'c'] })
      expect(kunreiFirst.remainingGuide()).toBe('si')
    })

    it('c alone (no kunrei selected) still prefers ci for し', () => {
      const matcher = createRomajiMatcher('し', { guideStyles: ['c'] })
      expect(matcher.remainingGuide()).toBe('ci')
    })
  })
})

describe('SPELLING_STYLES referential integrity', () => {
  it('every "<scope>|<spelling>" key resolves to a spelling that actually exists for that scope', () => {
    for (const key of Object.keys(SPELLING_STYLES)) {
      const separatorIndex = key.indexOf('|')
      const scope = key.slice(0, separatorIndex)
      const spelling = key.slice(separatorIndex + 1)

      // っ and ん have no KANA_TABLE entry — their spellings are derived at
      // runtime (gemination / context-dependent double-tap), so they're
      // checked against the same pattern lists the matcher itself uses.
      const validSpellings =
        scope === 'っ' ? SOKUON_EXPLICIT_PATTERNS
        : scope === 'ん' ? N_PATTERNS_SINGLE_OR_DOUBLE
        : KANA_TABLE[scope]

      expect(validSpellings, `unknown scope "${scope}" (from key "${key}")`).toBeDefined()
      expect(validSpellings, `"${spelling}" is not a valid spelling for scope "${scope}" (key "${key}")`).toContain(spelling)
    }
  })
})

describe('styleTip i18n content matches SPELLING_STYLES exactly, per family', () => {
  // Sweeps every family that actually appears in SPELLING_STYLES (the base
  // pair hepburn/kunrei included) and checks the Romaji Settings modal's
  // tooltip text against it, so a future SPELLING_STYLES edit (adding or
  // dropping a tagged spelling) can't silently drift from what the tooltip
  // tells the user.
  const familiesInUse = [...new Set(Object.values(SPELLING_STYLES))] as RomajiStyle[]
  const styleTip = english.editor.typingTest.romajiSettings.styleTip as Record<string, string>

  it.each(familiesInUse)('styleTip.%s lists exactly the kana:spelling pairs SPELLING_STYLES tags with that family', (style) => {
    const expected = Object.entries(SPELLING_STYLES)
      .filter(([, tag]) => tag === style)
      .map(([key]) => key.replace('|', ':'))
      .sort()

    const actual = (styleTip[style] ?? '').split(/\s+/).filter(Boolean).sort()

    expect(actual).toEqual(expected)
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
