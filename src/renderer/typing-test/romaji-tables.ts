// SPDX-License-Identifier: GPL-2.0-or-later
//
// KANA_TABLE, PUNCTUATION_TABLE, and the spelling-style tags they carry.
// `romaji-engine.ts` imports these tables to match typed keystrokes against
// kana; this file holds only the data and the styles, not the matching
// logic.
//
// KANA_TABLE mirrors Google mozc's own romaji input table
// (mozc/src/data/preedit/romanji-hiragana.tsv) — IME keystroke input, not
// romanization orthography — so every accepted spelling in KANA_TABLE is
// something a real IME actually accepts, not merely a valid way to
// transliterate the finished word: mozc's table (not orthography guides)
// is the single source of truth for what counts as an accepted spelling,
// so a spelling that's correct romanization but not IME-typable (e.g. ぢ's
// orthographic "ji", which mozc's IME resolves to じ instead) is
// deliberately excluded even though it looks valid on paper. See
// `__tests__/romaji-engine-mozc.test.ts` for the compliance sweep against
// that table — kana spellings only; PUNCTUATION_TABLE's ASCII
// punctuation spellings sit outside that sweep (see PUNCTUATION_TABLE's
// own comment below).

import { ROMAJI_PUNCTUATION } from '../../shared/kana-purity'

// Spelling-style groups used to let the Romaji settings modal (Step 2)
// selectively disable alternate spellings while keeping every word
// completable. See SPELLING_STYLES below for the invariant that makes that
// possible. 'hepburn' and 'kunrei' are the two base systems: either one
// alone can spell every kana in the table, so the settings modal only lets
// the last enabled base be turned off together with the other (see
// BASE_STYLES). The rest are independent options layered on top: 'cq' was
// split into separate 'c' (ca/ci/cu/ce/co) and 'q' (qu) styles so the two
// letter substitutions can be toggled independently, 'xn' was carved out of
// 'xSmall' (ん's own x-tap is a different concern from standalone small
// kana), and 'w'/'v'/'f'/'ye'/'nApos' are new loanword/extended-kana and
// ん-spelling families. See the SPELLING_STYLES comment below for how the
// new families' tagging differs from cq/digraph/xSmall/lSmall.
export type RomajiStyle =
  | 'hepburn' | 'kunrei'
  | 'c' | 'q' | 'digraph' | 'xSmall' | 'lSmall'
  | 'w' | 'v' | 'f' | 'ye' | 'xn' | 'nApos'

// The two base spelling systems. Every kana in KANA_TABLE is typable using
// only one of these (plus the untagged spellings shared by both), so the
// settings modal treats them as a pair where at least one must stay
// enabled — unlike the option styles below, which may all be disabled at
// once. Exported so the modal and the persisted-config validator share this
// list instead of re-deriving it.
export const BASE_STYLES: readonly RomajiStyle[] = ['hepburn', 'kunrei']

// Kana segment -> valid romaji spellings, ordered with the canonical
// (preferred / guide-representative) spelling first. Pure data: ん and っ
// are deliberately absent (their spellings depend on neighbouring kana, so
// the matcher derives their pattern lists at runtime instead of listing
// them here) and ー is included as an ordinary 1-character entry since its
// single spelling ("-") never depends on context.
export const KANA_TABLE: Record<string, readonly string[]> = {
  // -- vowels (あ行) --
  // う carries an extra alternate spelling (wu, whu) beyond the canonical
  // Hepburn form "u". These are tagged 'w' — they're the W-notation
  // family's う-row member (see the 'w' entries in SPELLING_STYLES below).
  あ: ['a'],
  い: ['i'],
  う: ['u', 'wu', 'whu'],
  え: ['e'],
  お: ['o'],

  // -- か行 / が行 --
  か: ['ka', 'ca'],
  き: ['ki'],
  く: ['ku', 'cu', 'qu'],
  け: ['ke'],
  こ: ['ko', 'co'],
  が: ['ga'],
  ぎ: ['gi'],
  ぐ: ['gu'],
  げ: ['ge'],
  ご: ['go'],

  // -- さ行 / ざ行 --
  さ: ['sa'],
  し: ['shi', 'si', 'ci'],
  す: ['su'],
  せ: ['se', 'ce'],
  そ: ['so'],
  ざ: ['za'],
  じ: ['ji', 'zi'],
  ず: ['zu'],
  ぜ: ['ze'],
  ぞ: ['zo'],

  // -- た行 / だ行 --
  た: ['ta'],
  ち: ['chi', 'ti'],
  つ: ['tsu', 'tu'],
  て: ['te'],
  と: ['to'],
  だ: ['da'],
  ぢ: ['di'],
  づ: ['du'],
  で: ['de'],
  ど: ['do'],

  // -- な行 --
  な: ['na'],
  に: ['ni'],
  ぬ: ['nu'],
  ね: ['ne'],
  の: ['no'],

  // -- は行 / ば行 / ぱ行 --
  は: ['ha'],
  ひ: ['hi'],
  ふ: ['fu', 'hu'],
  へ: ['he'],
  ほ: ['ho'],
  ば: ['ba'],
  び: ['bi'],
  ぶ: ['bu'],
  べ: ['be'],
  ぼ: ['bo'],
  ぱ: ['pa'],
  ぴ: ['pi'],
  ぷ: ['pu'],
  ぺ: ['pe'],
  ぽ: ['po'],

  // -- ま行 --
  ま: ['ma'],
  み: ['mi'],
  む: ['mu'],
  め: ['me'],
  も: ['mo'],

  // -- や行 --
  や: ['ya'],
  ゆ: ['yu'],
  よ: ['yo'],

  // -- ら行 --
  ら: ['ra'],
  り: ['ri'],
  る: ['ru'],
  れ: ['re'],
  ろ: ['ro'],

  // -- わ行 (ゐ/ゑ are historical kana, kept for completeness) --
  わ: ['wa'],
  を: ['wo'],
  ゐ: ['wyi'],
  ゑ: ['wye'],

  // -- long vowel mark (shared by hiragana/katakana text) --
  ー: ['-'],

  // -- small kana, typed standalone (x- canonical, l- alternate) --
  ぁ: ['xa', 'la'],
  ぃ: ['xi', 'li', 'xyi', 'lyi'],
  ぅ: ['xu', 'lu'],
  ぇ: ['xe', 'le', 'xye', 'lye'],
  ぉ: ['xo', 'lo'],
  ゃ: ['xya', 'lya'],
  ゅ: ['xyu', 'lyu'],
  ょ: ['xyo', 'lyo'],
  ゎ: ['xwa', 'lwa'],
  ゕ: ['xka', 'lka'],
  ゖ: ['xke', 'lke'],

  // -- youon (拗音): か/が行 --
  きゃ: ['kya'],
  きゅ: ['kyu'],
  きょ: ['kyo'],
  ぎゃ: ['gya'],
  ぎゅ: ['gyu'],
  ぎょ: ['gyo'],

  // -- youon: さ/ざ行 --
  しゃ: ['sha', 'sya'],
  しゅ: ['shu', 'syu'],
  しょ: ['sho', 'syo'],
  じゃ: ['ja', 'zya', 'jya'],
  じゅ: ['ju', 'zyu', 'jyu'],
  じょ: ['jo', 'zyo', 'jyo'],

  // -- youon: た/だ行 --
  ちゃ: ['cha', 'tya', 'cya'],
  ちゅ: ['chu', 'tyu', 'cyu'],
  ちょ: ['cho', 'tyo', 'cyo'],
  ぢゃ: ['dya'],
  ぢゅ: ['dyu'],
  ぢょ: ['dyo'],

  // -- youon: な行 --
  にゃ: ['nya'],
  にゅ: ['nyu'],
  にょ: ['nyo'],

  // -- youon: は/ば/ぱ行 --
  ひゃ: ['hya'],
  ひゅ: ['hyu'],
  ひょ: ['hyo'],
  びゃ: ['bya'],
  びゅ: ['byu'],
  びょ: ['byo'],
  ぴゃ: ['pya'],
  ぴゅ: ['pyu'],
  ぴょ: ['pyo'],

  // -- youon: ま行 --
  みゃ: ['mya'],
  みゅ: ['myu'],
  みょ: ['myo'],

  // -- youon: ら行 --
  りゃ: ['rya'],
  りゅ: ['ryu'],
  りょ: ['ryo'],

  // -- extended (外来音) digraphs used by loanword katakana --
  いぇ: ['ye'],
  うぁ: ['wha'],
  うぃ: ['wi', 'whi'],
  うぇ: ['we', 'whe'],
  うぉ: ['who'],
  ゔ: ['vu'],
  ゔぁ: ['va'],
  ゔぃ: ['vi', 'vyi'],
  ゔぇ: ['ve', 'vye'],
  ゔぉ: ['vo'],
  ゔゃ: ['vya'],
  ゔゅ: ['vyu'],
  ゔょ: ['vyo'],

  // -- extended い/え-row digraphs, one consonant-pair per row (きぃ/きぇ,
  // ぎぃ/ぎぇ, ...). Most of these have no toggleable family and no
  // decomposition fallback beyond the digraph spelling itself, so they're
  // deliberately left untagged in SPELLING_STYLES below (see the comment
  // directly above SPELLING_STYLES for the untagged-IME-extension policy)
  // — the few that do share a family with an existing style (cyi/cye,
  // jyi/jye) are tagged individually where they occur. --
  きぃ: ['kyi'],
  きぇ: ['kye'],
  ぎぃ: ['gyi'],
  ぎぇ: ['gye'],
  しぃ: ['syi'],
  しぇ: ['she', 'sye'],
  じぃ: ['zyi', 'jyi'],
  じぇ: ['je', 'zye', 'jye'],
  ちぃ: ['tyi', 'cyi'],
  ちぇ: ['che', 'tye', 'cye'],
  ぢぃ: ['dyi'],
  ぢぇ: ['dye'],
  にぃ: ['nyi'],
  にぇ: ['nye'],
  ひぃ: ['hyi'],
  ひぇ: ['hye'],
  びぃ: ['byi'],
  びぇ: ['bye'],
  ぴぃ: ['pyi'],
  ぴぇ: ['pye'],
  みぃ: ['myi'],
  みぇ: ['mye'],
  りぃ: ['ryi'],
  りぇ: ['rye'],

  // -- つ行 extended digraphs --
  つぁ: ['tsa'],
  つぃ: ['tsi'],
  つぇ: ['tse'],
  つぉ: ['tso'],

  // -- て/で/と/ど full digraph rows: th-/dh-/tw-/dw- spellings, plus the
  // apostrophe-separated t'-/d'- alternates for てぃ/てゅ/とぅ/でぃ/でゅ/どぅ --
  てゃ: ['tha'],
  てぃ: ['thi', "t'i"],
  てゅ: ['thu', "t'yu"],
  てぇ: ['the'],
  てょ: ['tho'],
  でゃ: ['dha'],
  でぃ: ['dhi', "d'i"],
  でゅ: ['dhu', "d'yu"],
  でぇ: ['dhe'],
  でょ: ['dho'],
  とぁ: ['twa'],
  とぃ: ['twi'],
  とぅ: ['twu', "t'u"],
  とぇ: ['twe'],
  とぉ: ['two'],
  どぁ: ['dwa'],
  どぃ: ['dwi'],
  どぅ: ['dwu', "d'u"],
  どぇ: ['dwe'],
  どぉ: ['dwo'],

  // -- ふぁ行 loanword digraphs (fa-/hwa- both tagged 'f' below) --
  ふぁ: ['fa', 'hwa'],
  ふぃ: ['fi', 'hwi'],
  ふぇ: ['fe', 'hwe'],
  ふぉ: ['fo', 'hwo'],
  ふゃ: ['fya'],
  ふゅ: ['fyu', 'hwyu'],
  ふょ: ['fyo'],

  // -- くぁ/ぐぁ full digraph rows (qa-family tagged 'q' below) --
  くぁ: ['kwa', 'qa'],
  くぃ: ['kwi', 'qi'],
  くぅ: ['kwu'],
  くぇ: ['kwe', 'qe'],
  くぉ: ['kwo', 'qo'],
  ぐぁ: ['gwa'],
  ぐぃ: ['gwi'],
  ぐぅ: ['gwu'],
  ぐぇ: ['gwe'],
  ぐぉ: ['gwo'],

  // -- すぁ/ずぁ full digraph rows --
  すぁ: ['swa'],
  すぃ: ['swi'],
  すぅ: ['swu'],
  すぇ: ['swe'],
  すぉ: ['swo'],
  ずぁ: ['zwa'],
  ずぃ: ['zwi'],
  ずぅ: ['zwu'],
  ずぇ: ['zwe'],
  ずぉ: ['zwo'],
}

// Punctuation that appears in the Tatoeba japanese word packs and in kana
// file-import texts, but is not kana — so it lives outside KANA_TABLE rather
// than as a table entry, keeping KANA_TABLE in exact set correspondence
// with mozc's kana rows (see the mozc compliance test, which fails if
// KANA_TABLE gains a non-kana key). mozc's own romaji table maps "."/","
// to 。/、; ？/！ aren't part of that kana table, but "?"/"!" are their
// natural direct-keystroke spelling. One canonical ASCII spelling each, no
// style variants — the settings modal has nothing to toggle here. Keys are type-locked
// to ROMAJI_PUNCTUATION (shared with isKanaOnlyText in shared/kana-purity)
// so the two lists can't drift apart.
export const PUNCTUATION_TABLE: Record<(typeof ROMAJI_PUNCTUATION)[number], readonly string[]> = {
  '。': ['.'],
  '、': [','],
  '？': ['?'],
  '！': ['!'],
}

// Style tag per spelling, keyed by "<tableKey>|<spelling>" so spellings
// that collide across different kana (e.g. "ji" is both じ's canonical and
// ぢ's alternate) resolve independently per entry.
//
// Four tagging regimes coexist here:
// - c / q / digraph tag only non-canonical alternates, so disabling them
//   can never empty an entry's spelling set.
// - hepburn / kunrei tag *both* sides of the syllables where the two base
//   systems actually diverge (shi/si, chi/ti, tsu/tu, fu/hu, ji/zi and
//   their sha/sya-family compounds) — including the canonical Hepburn
//   forms, which used to be left untagged before 'hepburn' existed as a
//   style. Spellings the two systems already agree on (ka, mi, ...) stay
//   untagged, and ぢ/づ (di/du) are untagged for a different reason: they're
//   the sole IME-input spellings mozc's own romaji table lists for those
//   two kana — unlike じ/じゃ, ぢ/ぢゃ have no hepburn/kunrei divergence to
//   tag at all.
// - xSmall / lSmall tag *both* spelling families of the standalone
//   small-kana entries — including the canonical x-forms — because each
//   toggle must be able to remove its whole family ("only type small kana
//   the l-way" is a real preference).
// - w / v / f / ye tag *every* spelling of their 2-kana loanword digraph
//   entries — including the sole/canonical one (いぇ, ゔゃ, ... some entries
//   list two or more spellings, e.g. ふぁ's fa/hwa or ゔぃ's vi/vyi) — even
//   though that would normally trip `filterByStyle`'s empty-set guard.
//   These entries are deliberately exempted from that guard (see the
//   digraph branch of `getSegmentOptions`) because they always have a real
//   decomposition fallback: every digraph key here is `firstKana +
//   secondKana`, and both halves are independently typable (ふ alone, plus
//   the standalone small kana ぁ/ぃ/ぅ/ぇ/ぉ/ゃ/ゅ/ょ). Turning a whole family
//   off is a deliberate "force the decomposed spelling" preference, not a
//   trap — ふぁ with 'f' disabled still completes via "fu" + "xa"/"la". The
//   'w' family additionally reaches into う's own single-kana entry
//   (wu/whu) since う is the first half of every W-notation digraph — that
//   part keeps the ordinary tag-only-alternates treatment (う's canonical
//   "u" stays untagged), and ゔ (v's own first half) is guarded normally as
//   a standalone atomic kana with no decomposition of its own, so
//   disabling 'v' still leaves ゔ typable as "vu" while ゔぁ etc. need
//   "vu"+small-kana.
// Every other mozc-only IME-extension spelling stays untagged on purpose:
// it doesn't fit any of the families above, and inventing a dedicated style
// per rarely-used spelling would add Romaji Settings toggles for
// essentially nothing. Untagged means always accepted and never shown in
// the settings modal. The exhaustive spelling list lives in KANA_TABLE
// itself, pinned against the mozc fixture by romaji-engine-mozc.test.ts.
// For the both-tagged regimes without a decomposition fallback
// (hepburn/kunrei, xSmall/lSmall, and w/v/f/ye's own atomic first-kana
// entries う/ゔ), typability is guaranteed not by leaving one side untagged
// but by `filterByStyle`'s dynamic guard: whenever filtering would empty an
// entry's spelling set, the canonical (first-listed) spelling is kept
// regardless of its tag. The Romaji Settings modal additionally never lets
// both hepburn and kunrei be disabled at once (see BASE_STYLES), so that
// guard is a safety net here rather than the primary mechanism. See the
// canonical-sweep test for the resulting invariant, and its
// decomposition-required exceptions for w/v/f/ye's own 2-kana entries.
// Exported for the SPELLING_STYLES referential-integrity sweep test only
// (romaji-engine-styles.test.ts) — not part of the matcher's public API.
export const SPELLING_STYLES: Record<string, RomajiStyle> = {
  // -- c: "c"-letter substitutions --
  'か|ca': 'c',
  'く|cu': 'c',
  'こ|co': 'c',
  'し|ci': 'c',
  'せ|ce': 'c',
  'ちゃ|cya': 'c',
  'ちゅ|cyu': 'c',
  'ちょ|cyo': 'c',
  'ちぃ|cyi': 'c',
  'ちぇ|cye': 'c',

  // -- q: "q"-letter substitutions (く row, including the くぁ-row's
  // JIS X 4063 kwa(qa)-family spellings) --
  'く|qu': 'q',
  'くぁ|qa': 'q',
  'くぃ|qi': 'q',
  'くぇ|qe': 'q',
  'くぉ|qo': 'q',

  // -- hepburn: canonical Hepburn spellings, paired one-for-one with the
  // kunrei-shiki alternates directly below --
  'し|shi': 'hepburn',
  'じ|ji': 'hepburn',
  'ち|chi': 'hepburn',
  'つ|tsu': 'hepburn',
  'ふ|fu': 'hepburn',
  'しゃ|sha': 'hepburn',
  'しゅ|shu': 'hepburn',
  'しょ|sho': 'hepburn',
  'じゃ|ja': 'hepburn',
  'じゅ|ju': 'hepburn',
  'じょ|jo': 'hepburn',
  'ちゃ|cha': 'hepburn',
  'ちゅ|chu': 'hepburn',
  'ちょ|cho': 'hepburn',

  // -- kunrei: kunrei-shiki-style alternates --
  'し|si': 'kunrei',
  'じ|zi': 'kunrei',
  'ち|ti': 'kunrei',
  'つ|tu': 'kunrei',
  'ふ|hu': 'kunrei',
  'しゃ|sya': 'kunrei',
  'しゅ|syu': 'kunrei',
  'しょ|syo': 'kunrei',
  'じゃ|zya': 'kunrei',
  'じゅ|zyu': 'kunrei',
  'じょ|zyo': 'kunrei',
  'ちゃ|tya': 'kunrei',
  'ちゅ|tyu': 'kunrei',
  'ちょ|tyo': 'kunrei',

  // -- digraph: alternate spellings of the youon j-row 2-kana table entries
  // that don't fall into the kunrei/c/q families above (the loanword W
  // digraphs うぃ/うぇ moved out of this family into 'w' below) --
  'じゃ|jya': 'digraph',
  'じゅ|jyu': 'digraph',
  'じょ|jyo': 'digraph',
  'じぃ|jyi': 'digraph',
  'じぇ|jye': 'digraph',

  // -- w: W-notation loanword digraphs. Both spellings of うぃ/うぇ are
  // tagged (including the canonical "wi"/"we"), plus うぁ/うぉ's sole
  // spellings "wha"/"who" and う's own "wu"/"whu" alternates — see the
  // SPELLING_STYLES header comment for why tagging a sole/canonical digraph
  // spelling is safe here (decomposition into う + the standalone small
  // kana always remains). --
  'うぁ|wha': 'w',
  'うぃ|wi': 'w',
  'うぃ|whi': 'w',
  'うぇ|we': 'w',
  'うぇ|whe': 'w',
  'うぉ|who': 'w',
  'う|wu': 'w',
  'う|whu': 'w',

  // -- v: ゔ行 (ヴ/ゔ) loanword digraphs, canonical spellings tagged too —
  // ゔ itself (the atomic first half) keeps the ordinary guarded treatment,
  // ゔぁ/ゔぃ/ゔぇ/ゔぉ decompose to "vu" + small kana when 'v' is off --
  'ゔ|vu': 'v',
  'ゔぁ|va': 'v',
  'ゔぃ|vi': 'v',
  'ゔぃ|vyi': 'v',
  'ゔぇ|ve': 'v',
  'ゔぇ|vye': 'v',
  'ゔぉ|vo': 'v',
  'ゔゃ|vya': 'v',
  'ゔゅ|vyu': 'v',
  'ゔょ|vyo': 'v',

  // -- f: ふぁ行 loanword digraphs (canonical and hwa-family spellings both
  // tagged; ふ itself is untouched by this tag — ふ=fu/hu stays
  // hepburn/kunrei territory) --
  'ふぁ|fa': 'f',
  'ふぁ|hwa': 'f',
  'ふぃ|fi': 'f',
  'ふぃ|hwi': 'f',
  'ふぇ|fe': 'f',
  'ふぇ|hwe': 'f',
  'ふぉ|fo': 'f',
  'ふぉ|hwo': 'f',
  'ふゃ|fya': 'f',
  'ふゅ|fyu': 'f',
  'ふゅ|hwyu': 'f',
  'ふょ|fyo': 'f',

  // -- ye: いぇ, the sole loanword digraph with no other family to join. --
  'いぇ|ye': 'ye',

  // -- xSmall / lSmall: standalone small-kana spellings, both families
  // tagged (canonical x-forms included — the dynamic guard in
  // `filterByStyle` is what keeps these entries typable when both
  // families are disabled at once) --
  'ぁ|xa': 'xSmall',
  'ぃ|xi': 'xSmall',
  'ぃ|xyi': 'xSmall',
  'ぅ|xu': 'xSmall',
  'ぇ|xe': 'xSmall',
  'ぇ|xye': 'xSmall',
  'ぉ|xo': 'xSmall',
  'ゃ|xya': 'xSmall',
  'ゅ|xyu': 'xSmall',
  'ょ|xyo': 'xSmall',
  'ゎ|xwa': 'xSmall',
  'ゕ|xka': 'xSmall',
  'ゖ|xke': 'xSmall',
  'ぁ|la': 'lSmall',
  'ぃ|li': 'lSmall',
  'ぃ|lyi': 'lSmall',
  'ぅ|lu': 'lSmall',
  'ぇ|le': 'lSmall',
  'ぇ|lye': 'lSmall',
  'ぉ|lo': 'lSmall',
  'ゃ|lya': 'lSmall',
  'ゅ|lyu': 'lSmall',
  'ょ|lyo': 'lSmall',
  'ゎ|lwa': 'lSmall',
  'ゕ|lka': 'lSmall',
  'ゖ|lke': 'lSmall',

  // -- っ (explicit small-tsu tap) keeps the x/l tagging above. --
  'っ|xtu': 'xSmall',
  'っ|xtsu': 'xSmall',
  'っ|ltu': 'lSmall',
  'っ|ltsu': 'lSmall',

  // -- ん: 'n'/'nn' stay untagged (shared baseline, always accepted, so its
  // set never empties and the guard never has to fire for it). 'xn' is its
  // own style (no longer folded into xSmall — ん's explicit x-tap is a
  // separate preference from standalone small-kana spellings). 'nApos' is
  // the "n'" IME-style separator that disambiguates ん before a vowel
  // (kan'i) without forcing a double tap. See SOKUON_EXPLICIT_PATTERNS and
  // N_PATTERNS_SINGLE_OR_DOUBLE in romaji-engine.ts for the full pattern
  // lists. --
  'ん|xn': 'xn',
  "ん|n'": 'nApos',
}

