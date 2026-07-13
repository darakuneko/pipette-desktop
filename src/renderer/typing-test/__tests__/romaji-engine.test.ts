// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { createRomajiMatcher, KANA_TABLE, type RomajiAcceptResult } from '../romaji-engine'

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

  it('rejects the tch- spelling before a ch- consonant; only the cch-/tt- forms complete (bocchi/botti accept, botchi rejects)', () => {
    // Real IME input does not fold "t" into a ch- spelling's own doubling —
    // typing "matcha" against 抹茶 leaves a literal "t" behind instead of
    // completing まっちゃ, per Wikipedia's ローマ字入力 article and real IME
    // behaviour, even though "matcha" is valid Hepburn orthography for the
    // finished word. The wapuro cch- doubling and the kunrei-derived tt-
    // doubling (from the ti spelling) remain the two accepted forms.
    const botchi = type('ぼっち', 'botchi')
    expect(botchi.results).toContain('reject')

    const bocchi = type('ぼっち', 'bocchi')
    expect(bocchi.results.at(-1)).toBe('complete')
    expect(bocchi.matcher.typedRomaji()).toBe('bocchi')

    const botti = type('ぼっち', 'botti')
    expect(botti.results.at(-1)).toBe('complete')
    expect(botti.matcher.typedRomaji()).toBe('botti')
  })

  it('rejects tch- doubling a youon ch- digraph too (matcha); maccha/mattya still complete', () => {
    const matcha = type('まっちゃ', 'matcha')
    expect(matcha.results).toContain('reject')

    const maccha = type('まっちゃ', 'maccha')
    expect(maccha.results.at(-1)).toBe('complete')
    expect(maccha.matcher.typedRomaji()).toBe('maccha')

    const mattya = type('まっちゃ', 'mattya')
    expect(mattya.results.at(-1)).toBe('complete')
    expect(mattya.matcher.typedRomaji()).toBe('mattya')
  })
})

describe('っ — gemination excluded before an n/vowel/y-starting following kana', () => {
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

  it('rejects doubling "y" before や (あっや as ayya has no real IME equivalent)', () => {
    const matcher = createRomajiMatcher('あっや')
    expect(matcher.acceptChar('a')).toBe('complete')
    expect(matcher.acceptChar('y')).toBe('reject')
    expect(matcher.typedRomaji()).toBe('a')
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

describe('あ行 alternate spellings (yi for い, wu/whu for う)', () => {
  it('accepts yi for い alongside the canonical i, inside a word', () => {
    const { matcher, results } = type('あい', 'ayi')
    expect(results.at(-1)).toBe('complete')
    expect(matcher.isComplete()).toBe(true)
    expect(matcher.typedRomaji()).toBe('ayi')
  })

  it('accepts wu and whu for う alongside the canonical u, inside a word', () => {
    const wu = type('あう', 'awu')
    expect(wu.results.at(-1)).toBe('complete')
    expect(wu.matcher.typedRomaji()).toBe('awu')

    const whu = type('あう', 'awhu')
    expect(whu.results.at(-1)).toBe('complete')
    expect(whu.matcher.typedRomaji()).toBe('awhu')
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
