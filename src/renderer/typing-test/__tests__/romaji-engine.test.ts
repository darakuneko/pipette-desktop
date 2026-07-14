// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { createRomajiMatcher, canonicalRomaji, KANA_TABLE, type RomajiAcceptResult } from '../romaji-engine'

/** Types every character of `keys` into a fresh matcher for `word` and
 *  returns the matcher plus the per-keystroke result sequence. */
function type(word: string, keys: string): { matcher: ReturnType<typeof createRomajiMatcher>; results: RomajiAcceptResult[] } {
  const matcher = createRomajiMatcher(word)
  const results: RomajiAcceptResult[] = []
  for (const key of keys) results.push(matcher.acceptChar(key))
  return { matcher, results }
}

describe('KANA_TABLE exhaustive coverage', () => {
  const entries = Object.entries(KANA_TABLE)

  it.each(entries)('every spelling of "%s" completes the segment', (kana, patterns) => {
    for (const pattern of patterns) {
      const { matcher, results } = type(kana, pattern)
      expect(results.at(-1)).toBe('complete')
      expect(matcher.isComplete()).toBe(true)
      expect(matcher.typedRomaji()).toBe(pattern)
    }
  })
})

describe('でぃなーにいく — ambiguous digraph vs decomposed segmentation', () => {
  it('completes via the digraph spelling (dhi)', () => {
    const { matcher, results } = type('でぃなーにいく', 'dhina-niiku')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('dhina-niiku')
  })

  it('completes via the decomposed spelling using the x- small-kana form (dexi)', () => {
    const { matcher, results } = type('でぃなーにいく', 'dexina-niiku')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('dexina-niiku')
  })

  it('completes via the decomposed spelling using the l- small-kana form (deli)', () => {
    const { matcher, results } = type('でぃなーにいく', 'delina-niiku')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('delina-niiku')
  })

  it('never rejects while "d" then "e" are still consistent with the decomposed path', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    expect(matcher.acceptChar('d')).toBe('accept')
    expect(matcher.acceptChar('e')).toBe('complete')
  })

  it('shows the digraph as the initial guide, then re-derives it once "de" commits', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    expect(matcher.remainingGuide()).toBe('dhina-niiku')

    matcher.acceptChar('d')
    expect(matcher.remainingGuide()).toBe('hina-niiku')

    matcher.acceptChar('e')
    expect(matcher.typedRomaji()).toBe('de')
    expect(matcher.remainingGuide()).toBe('xina-niiku')
  })
})

describe('ん — context-dependent single vs double tap', () => {
  it('accepts a single tap before a consonant-starting kana (kanji)', () => {
    const { matcher, results } = type('かんじ', 'kanji')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('kanji')
  })

  it('also accepts a double tap in the same consonant context (kannji)', () => {
    const { matcher, results } = type('かんじ', 'kannji')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('kannji')
  })

  it('accepts the alternate じ spelling (kanzi)', () => {
    const { matcher, results } = type('かんじ', 'kanzi')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('kanzi')
  })

  it('allows a single tap at word end (hon)', () => {
    const { matcher, results } = type('ほん', 'hon')
    expect(results.at(-1)).toBe('accept')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('hon')
  })

  it('also allows a double tap at word end (honn)', () => {
    const { matcher, results } = type('ほん', 'honn')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('honn')
  })

  it('requires a double tap before a na-row kana, spanning three literal n letters (mannna)', () => {
    const { matcher, results } = type('まんな', 'mannna')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('mannna')
  })

  it('rejects a bare "n" before a vowel-starting kana, since that would spell the na-row kana instead', () => {
    const matcher = createRomajiMatcher('かんい')
    expect(matcher.acceptChar('k')).toBe('accept')
    expect(matcher.acceptChar('a')).toBe('complete')
    expect(matcher.acceptChar('n')).toBe('accept')
    // "kani" would type かに, not かんい — the engine must refuse the "i"
    // here rather than silently mis-segmenting the word.
    expect(matcher.acceptChar('i')).toBe('reject')
    expect(matcher.typedRomaji()).toBe('kan')

    // Retyping with the required double tap recovers and completes.
    expect(matcher.acceptChar('n')).toBe('complete')
    expect(matcher.acceptChar('i')).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('kanni')
  })
})

describe('っ — gemination vs explicit small-tsu spelling', () => {
  it('completes via doubling the following consonant (kitte)', () => {
    const { matcher, results } = type('きって', 'kitte')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('kitte')
  })

  it('completes via the explicit ltu spelling (kiltute)', () => {
    const { matcher, results } = type('きって', 'kiltute')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('kiltute')
  })

  it('completes via the explicit xtu spelling (kixtute)', () => {
    const { matcher, results } = type('きって', 'kixtute')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('kixtute')
  })

  it('allows only the explicit spelling at word end (no consonant to double)', () => {
    const { matcher, results } = type('あっ', 'axtu')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('axtu')
    // The digraph-doubling groups shouldn't exist at all, so a doubled
    // "tt"-style attempt has nothing to match at word end.
    const rejected = createRomajiMatcher('あっ')
    expect(rejected.acceptChar('a')).toBe('complete')
    expect(rejected.acceptChar('t')).toBe('reject')
  })

  it('doubles the youon digraph as a whole (maccha / mattya)', () => {
    const maccha = type('まっちゃ', 'maccha')
    expect(maccha.results.at(-1)).toBe('complete')
    expect(maccha.matcher.typedRomaji()).toBe('maccha')

    const mattya = type('まっちゃ', 'mattya')
    expect(mattya.results.at(-1)).toBe('complete')
    expect(mattya.matcher.typedRomaji()).toBe('mattya')
  })

  it('also accepts the explicit spelling before a youon digraph (maltucha)', () => {
    const { matcher, results } = type('まっちゃ', 'maltucha')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('maltucha')
  })

  it('completes via the explicit xtsu spelling (kixtsute)', () => {
    const { matcher, results } = type('きって', 'kixtsute')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('kixtsute')
  })

  it('accepts the tch- spelling before a ch- consonant, alongside cch-/tt- (botchi/bocchi/botti all complete)', () => {
    // mozc's romaji table has an explicit "tch -> っ + ch" doubling row
    // alongside its per-letter doubling rows, so typing "botchi" against
    // ぼっち is real IME input, not just valid Hepburn orthography for the
    // finished word. The wapuro cch- doubling and the kunrei-derived tt-
    // doubling (from the ti spelling) remain accepted too.
    const botchi = type('ぼっち', 'botchi')
    expect(botchi.results.at(-1)).toBe('complete')
    expect(botchi.matcher.typedRomaji()).toBe('botchi')

    const bocchi = type('ぼっち', 'bocchi')
    expect(bocchi.results.at(-1)).toBe('complete')
    expect(bocchi.matcher.typedRomaji()).toBe('bocchi')

    const botti = type('ぼっち', 'botti')
    expect(botti.results.at(-1)).toBe('complete')
    expect(botti.matcher.typedRomaji()).toBe('botti')
  })

  it('accepts tch- doubling a youon ch- digraph too (matcha), alongside maccha/mattya', () => {
    const matcha = type('まっちゃ', 'matcha')
    expect(matcha.results.at(-1)).toBe('complete')
    expect(matcha.matcher.typedRomaji()).toBe('matcha')

    const maccha = type('まっちゃ', 'maccha')
    expect(maccha.results.at(-1)).toBe('complete')
    expect(maccha.matcher.typedRomaji()).toBe('maccha')

    const mattya = type('まっちゃ', 'mattya')
    expect(mattya.results.at(-1)).toBe('complete')
    expect(mattya.matcher.typedRomaji()).toBe('mattya')
  })
})

describe('っ — gemination excluded before an n/vowel-starting following kana', () => {
  it('rejects doubling "n" before a na-row kana (あっな as anna would read back as あんな)', () => {
    const matcher = createRomajiMatcher('あっな')
    expect(matcher.acceptChar('a')).toBe('complete')
    expect(matcher.acceptChar('n')).toBe('reject')
    expect(matcher.typedRomaji()).toBe('a')
  })

  it('still completes あっな via the explicit tap (axtuna)', () => {
    const { matcher, results } = type('あっな', 'axtuna')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('axtuna')
  })

  it('doubles "y" before や, matching mozc\'s own yy -> っ + y row (あっや as ayya)', () => {
    const { matcher, results } = type('あっや', 'ayya')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('ayya')
  })

  it('still completes あっや via the explicit tap (altuya)', () => {
    const { matcher, results } = type('あっや', 'altuya')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('altuya')
  })

  it('still rejects doubling a vowel before あ (あっあ as aaa), the pre-existing exclusion', () => {
    const matcher = createRomajiMatcher('あっあ')
    expect(matcher.acceptChar('a')).toBe('complete')
    expect(matcher.acceptChar('a')).toBe('reject')
    expect(matcher.typedRomaji()).toBe('a')
  })
})

describe('katakana normalization and the long vowel mark', () => {
  it('completes コーヒー as ko-hi-', () => {
    const { matcher, results } = type('コーヒー', 'ko-hi-')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('ko-hi-')
  })
})

describe('passthrough for characters outside the table', () => {
  it('types an unmapped character as itself, one keystroke', () => {
    const { matcher, results } = type('5じ', '5ji')
    expect(results).toEqual(['complete', 'accept', 'complete'])
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('5ji')
  })
})

describe('reject leaves state untouched', () => {
  it('does not advance or record anything on an invalid keystroke', () => {
    const matcher = createRomajiMatcher('あ')
    expect(matcher.acceptChar('b')).toBe('reject')
    expect(matcher.typedRomaji()).toBe('')
    expect(matcher.isComplete()).toBe(false)

    expect(matcher.acceptChar('a')).toBe('complete')
    expect(matcher.typedRomaji()).toBe('a')
    expect(matcher.isComplete()).toBe(true)
  })

  it('reports an empty guide once the word is complete', () => {
    const matcher = createRomajiMatcher('あ')
    matcher.acceptChar('a')
    expect(matcher.remainingGuide()).toBe('')
  })
})

describe('completedKanaCount', () => {
  it('starts at 0 before any keystroke', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    expect(matcher.completedKanaCount()).toBe(0)
  })

  it('does not advance while a segment is only partially typed', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    matcher.acceptChar('d')
    expect(matcher.completedKanaCount()).toBe(0)
  })

  it('advances by the segment length once a segment commits, tracking a mid-word digraph split (dhi = 2 kana)', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    matcher.acceptChar('d')
    matcher.acceptChar('h')
    matcher.acceptChar('i') // commits でぃ as one 2-kana digraph segment
    expect(matcher.completedKanaCount()).toBe(2)
  })

  it('advances by 1 kana at a time for the decomposed (de + xi) spelling', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    matcher.acceptChar('d')
    matcher.acceptChar('e') // commits で alone (1 kana)
    expect(matcher.completedKanaCount()).toBe(1)
    matcher.acceptChar('x')
    matcher.acceptChar('i') // commits ぃ (1 more kana)
    expect(matcher.completedKanaCount()).toBe(2)
  })

  it('rejects never advance the count', () => {
    const matcher = createRomajiMatcher('あい')
    matcher.acceptChar('a')
    expect(matcher.completedKanaCount()).toBe(1)
    expect(matcher.acceptChar('z')).toBe('reject')
    expect(matcher.completedKanaCount()).toBe(1)
  })

  it('reaches the full kana length once the word completes', () => {
    const matcher = createRomajiMatcher('でぃなーにいく')
    for (const key of 'dhina-niiku') matcher.acceptChar(key)
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.completedKanaCount()).toBe([...'でぃなーにいく'].length)
  })
})

describe('あ行 alternate spellings (wu/whu for う)', () => {
  it('accepts wu and whu for う alongside the canonical u, inside a word', () => {
    const wu = type('あう', 'awu')
    expect(wu.results.at(-1)).toBe('complete')
    expect(wu.matcher.typedRomaji()).toBe('awu')

    const whu = type('あう', 'awhu')
    expect(whu.results.at(-1)).toBe('complete')
    expect(whu.matcher.typedRomaji()).toBe('awhu')
  })
})

// Single-kana acceptance of every mozc spelling is swept exhaustively by
// romaji-engine-mozc.test.ts against the vendored fixture; the cases here
// cover only compositions that sweep can't generate (mid-word doubling,
// doubling an apostrophe digraph, the decomposed fallback spelling).
describe('mozc-aligned additions: y-doubling, apostrophe digraphs, and new extended rows', () => {
  it('doubles a y-starting spelling mid-word (やっよ as yayyo)', () => {
    const { matcher, results } = type('やっよ', 'yayyo')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('yayyo')
  })

  it('doubles the apostrophe-separated d\'- spelling of でゅ (っでゅ as dd\'yu)', () => {
    const { matcher, results } = type('っでゅ', "dd'yu")
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe("dd'yu")
  })

  it('still completes via the decomposed spelling (きぃ as ki + xi)', () => {
    const { matcher, results } = type('きぃ', 'kixi')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('kixi')
  })
})

describe('mozc-aligned removals: い has no yi, ぢ/づ have no ji/zi/zu alternates', () => {
  it('rejects yi for い (mozc has no such row)', () => {
    const { results } = type('い', 'yi')
    expect(results).toContain('reject')
  })

  it('rejects ji and zi for ぢ, but still accepts di', () => {
    expect(type('ぢ', 'ji').results).toContain('reject')
    expect(type('ぢ', 'zi').results).toContain('reject')

    const { matcher, results } = type('ぢ', 'di')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('di')
  })

  it('rejects zu for づ', () => {
    expect(type('づ', 'zu').results).toContain('reject')
  })

  it('rejects ja for ぢゃ, but still accepts dya', () => {
    expect(type('ぢゃ', 'ja').results).toContain('reject')

    const { matcher, results } = type('ぢゃ', 'dya')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.typedRomaji()).toBe('dya')
  })
})

describe('ん — mozc consonant-lookahead retroactive commit', () => {
  it('commits ん before a w-starting continuation even though う forces the guide\'s double-tap form (んう as nwu)', () => {
    const { matcher, results } = type('んう', 'nwu')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('nwu')
  })

  it('still rejects a bare single "n" continuation into a vowel keystroke (んう as nu)', () => {
    const { results } = type('んう', 'nu')
    expect(results).toContain('reject')
  })

  it('still allows the double-tap spelling (んう as nnu)', () => {
    const { matcher, results } = type('んう', 'nnu')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('nnu')
  })

  it('commits ん before a consonant-starting continuation across a full word (しんうち as shinwuchi)', () => {
    const { matcher, results } = type('しんうち', 'shinwuchi')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('shinwuchi')
  })
})

describe('punctuation — 。、？！ typed via their ASCII spelling', () => {
  it('completes 。 via "."', () => {
    const { matcher, results } = type('。', '.')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('.')
  })

  it('completes 、 via ","', () => {
    const { matcher, results } = type('、', ',')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe(',')
  })

  it('completes ？ via "?"', () => {
    const { matcher, results } = type('？', '?')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('?')
  })

  it('completes ！ via "!"', () => {
    const { matcher, results } = type('！', '!')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('!')
  })

  it('completes a mixed word end-to-end (はい、そうです。 as hai,soudesu.)', () => {
    const { matcher, results } = type('はい、そうです。', 'hai,soudesu.')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('hai,soudesu.')
  })

  it('remainingGuide shows the ASCII spelling for a word starting with punctuation, not the literal kana', () => {
    const matcher = createRomajiMatcher('。です')
    expect(matcher.remainingGuide()).toBe('.desu')
  })

  it('remainingGuide shows the ASCII spelling for punctuation mid-word', () => {
    const matcher = createRomajiMatcher('はい、そうです。')
    expect(matcher.remainingGuide()).toBe('hai,soudesu.')
  })
})

describe('ねっこ — full pattern enumeration', () => {
  // Exhaustively walks every keystroke sequence the matcher accepts for
  // ねっこ (via DFS over a-z plus '-'), pruning as soon as a keystroke is
  // rejected and stopping at each completed word rather than continuing
  // past it. Depth is capped well above the longest real spelling
  // (neltsuko/nextsuko top out at 8 characters) purely as a safety bound
  // against an unbounded search if the matcher regresses.
  function enumerateCompletions(word: string, maxDepth: number): string[] {
    const alphabet = [...'abcdefghijklmnopqrstuvwxyz-']
    const completions: string[] = []

    function dfs(path: string): void {
      if (path.length >= maxDepth) return
      for (const key of alphabet) {
        const candidate = path + key
        const { matcher, results } = type(word, candidate)
        if (results.at(-1) === 'reject') continue
        if (matcher.isComplete()) {
          completions.push(candidate)
          continue
        }
        dfs(candidate)
      }
    }

    dfs('')
    return completions
  }

  it('accepts exactly 10 full spellings: gemination (nekko/necco) plus the 4 explicit taps x2 following spellings', () => {
    const completions = enumerateCompletions('ねっこ', 12).sort()
    expect(completions).toEqual(
      [
        'nekko',
        'necco',
        'nextuko',
        'nextuco',
        'neltuko',
        'neltuco',
        'neltsuko',
        'neltsuco',
        'nextsuko',
        'nextsuco',
      ].sort(),
    )
    expect(completions).toHaveLength(10)
  })
})

// Plan-typing-mistake-analysis Phase 1: mistake tracking keys a mistyped
// kana segment by its canonical romaji spelling, independent of which
// alternate spelling the user actually typed.
describe('canonicalRomaji', () => {
  it('returns the canonical (first-listed) single-kana spelling', () => {
    expect(canonicalRomaji('し')).toBe('shi')
    expect(canonicalRomaji('き')).toBe('ki')
  })

  it('returns the canonical 2-kana digraph spelling', () => {
    expect(canonicalRomaji('ぎゃ')).toBe('gya')
    expect(canonicalRomaji('きょ')).toBe('kyo')
  })

  it('handles katakana input the same as its hiragana equivalent', () => {
    expect(canonicalRomaji('シ')).toBe('shi')
    expect(canonicalRomaji('ギャ')).toBe('gya')
  })

  it('handles a multi-kana word by concatenating each segment\'s canonical spelling', () => {
    expect(canonicalRomaji('あい')).toBe('ai')
  })
})
