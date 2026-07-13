// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sequential romaji-keystroke matcher for the kana typing-test packs
// (japanese_hiragana / japanese_katakana). A kana word is not typed via a
// single canonical romaji string: most kana accept several spellings
// (si/shi/ci for し, tu/tsu for つ, ...), and two-kana sequences like でぃ
// can be typed either as one digraph chunk ("dhi") or as two independent
// kana ("de" + "xi"/"li"). The matcher below never enumerates every full
// spelling of a word up front; it walks the kana one segment at a time and
// asks, per keystroke, which segment-length/spelling combinations are still
// alive.
//
// Segmentation is intentionally decided lazily rather than fixed in
// advance: at any kana position, `getSegmentOptions` returns every
// (kana-length, romaji spellings) group that could start there (a 2-kana
// digraph group and/or a 1-kana group). A keystroke narrows the flattened
// pattern list to those still matching as a prefix; once exactly one
// pattern is both an exact match for what's typed and not itself a proper
// prefix of any other still-alive pattern, that segment is unambiguous and
// the matcher commits it and moves on. Only ん's own patterns
// (n / nn / xn / n') are a genuine exact-match-that-is-also-a-prefix case (a
// single "n" can validly finish ん, but so can typing a second "n" or an
// apostrophe): the matcher holds that keystroke as pending and resolves it
// against the following character with a one-keystroke lookahead
// ("retroactive commit" below), instead of hard-coding the ambiguity into
// the table.

import { toHiragana } from './kana-script'

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
  // い/う carry an extra alternate spelling (yi / wu, whu) beyond the
  // canonical Hepburn form. い's "yi" stays untagged (no SPELLING_STYLES
  // entry): it doesn't fit any of the families below, and inventing a
  // dedicated style for one rarely-used spelling would add a Romaji
  // Settings toggle for essentially nothing. Untagged means always
  // accepted and never shown in the settings modal. う's "wu"/"whu" are
  // tagged 'w' instead — they're the W-notation family's う-row member
  // (see the 'w' entries in SPELLING_STYLES below).
  あ: ['a'],
  い: ['i', 'yi'],
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
  ぢ: ['di', 'ji', 'zi'],
  づ: ['du', 'zu'],
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

  // -- わ行 --
  わ: ['wa'],
  を: ['wo'],

  // -- long vowel mark (shared by hiragana/katakana text) --
  ー: ['-'],

  // -- small kana, typed standalone (x- canonical, l- alternate) --
  ぁ: ['xa', 'la'],
  ぃ: ['xi', 'li'],
  ぅ: ['xu', 'lu'],
  ぇ: ['xe', 'le'],
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
  ぢゃ: ['dya', 'ja', 'zya'],
  ぢゅ: ['dyu', 'ju', 'zyu'],
  ぢょ: ['dyo', 'jo', 'zyo'],

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
  うぃ: ['wi', 'whi'],
  うぇ: ['we', 'whe'],
  うぉ: ['who'],
  ゔ: ['vu'],
  ゔぁ: ['va'],
  ゔぃ: ['vi'],
  ゔぇ: ['ve'],
  ゔぉ: ['vo'],
  きぇ: ['kye'],
  ぎぇ: ['gye'],
  しぇ: ['she'],
  じぇ: ['je'],
  ちぇ: ['che'],
  にぇ: ['nye'],
  ひぇ: ['hye'],
  びぇ: ['bye'],
  ぴぇ: ['pye'],
  みぇ: ['mye'],
  りぇ: ['rye'],
  つぁ: ['tsa'],
  つぃ: ['tsi'],
  つぇ: ['tse'],
  つぉ: ['tso'],
  てぃ: ['thi'],
  てゅ: ['thu'],
  とぅ: ['twu'],
  でぃ: ['dhi'],
  でゅ: ['dhu'],
  どぅ: ['dwu'],
  ふぁ: ['fa'],
  ふぃ: ['fi'],
  ふぇ: ['fe'],
  ふぉ: ['fo'],
  ふゅ: ['fyu'],
  くぁ: ['kwa'],
  くぃ: ['kwi'],
  くぇ: ['kwe'],
  くぉ: ['kwo'],
  ぐぁ: ['gwa'],
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
//   their sha/sya-family compounds, plus ぢ's ji/zi and the ぢゃ-row's
//   ja/zya-family compounds, which diverge the same way じ/じゃ do) —
//   including the canonical Hepburn forms, which used to be left untagged
//   before 'hepburn' existed as a style. Spellings the two systems already
//   agree on (ka, mi, ...) stay untagged, as do IME-specific alternates
//   that don't fit either system's own rules (ぢ's "di" and the ぢゃ-row's
//   "dya"/"dyu"/"dyo" are the canonical, untagged IME forms). づ's "zu" is
//   untagged too, but for a different reason: both base systems spell づ
//   as "zu", so it's a spelling the two systems share rather than an
//   IME-specific one — untagged here means always accepted regardless of
//   which base style is selected, the same practical effect as an
//   IME-specific tag but a different justification.
// - xSmall / lSmall tag *both* spelling families of the standalone
//   small-kana entries — including the canonical x-forms — because each
//   toggle must be able to remove its whole family ("only type small kana
//   the l-way" is a real preference).
// - w / v / f / ye tag *every* spelling of their 2-kana loanword digraph
//   entries — including the sole/canonical one (ふぁ, ゔぁ, いぇ, ... each
//   have exactly one listed spelling, or two for うぃ/うぇ) — even though
//   that would normally trip `filterByStyle`'s empty-set guard. These
//   entries are deliberately exempted from that guard (see the digraph
//   branch of `getSegmentOptions`) because they always have a real
//   decomposition fallback: every digraph key here is `firstKana +
//   secondKana`, and both halves are independently typable (ふ alone, plus
//   the standalone small kana ぁ/ぃ/ぅ/ぇ/ぉ/ゅ). Turning a whole family off
//   is a deliberate "force the decomposed spelling" preference, not a trap
//   — ふぁ with 'f' disabled still completes via "fu" + "xa"/"la". The 'w'
//   family additionally reaches into う's own single-kana entry (wu/whu)
//   since う is the first half of every W-notation digraph — that part
//   keeps the ordinary tag-only-alternates treatment (う's canonical "u"
//   stays untagged), and ゔ (v's own first half) is guarded normally as a
//   standalone atomic kana with no decomposition of its own, so disabling
//   'v' still leaves ゔ typable as "vu" while ゔぁ etc. need "vu"+small-kana.
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

  // -- q: "qu"-letter substitution (く only; no "qa"-style spelling exists
  // in KANA_TABLE today for くぁ etc. — add one here if it's ever added
  // there) --
  'く|qu': 'q',

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
  'ぢ|ji': 'hepburn',
  'ぢゃ|ja': 'hepburn',
  'ぢゅ|ju': 'hepburn',
  'ぢょ|jo': 'hepburn',

  // -- kunrei: kunrei-shiki-style alternates --
  'し|si': 'kunrei',
  'じ|zi': 'kunrei',
  'ち|ti': 'kunrei',
  'つ|tu': 'kunrei',
  'ぢ|zi': 'kunrei',
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
  'ぢゃ|zya': 'kunrei',
  'ぢゅ|zyu': 'kunrei',
  'ぢょ|zyo': 'kunrei',

  // -- digraph: alternate spellings of the youon j-row 2-kana table entries
  // that don't fall into the kunrei/c/q families above (the loanword W
  // digraphs うぃ/うぇ moved out of this family into 'w' below) --
  'じゃ|jya': 'digraph',
  'じゅ|jyu': 'digraph',
  'じょ|jyo': 'digraph',

  // -- w: W-notation loanword digraphs. Both spellings of うぃ/うぇ are
  // tagged (including the canonical "wi"/"we"), plus うぉ's sole spelling
  // "who" and う's own "wu"/"whu" alternates — see the SPELLING_STYLES
  // header comment for why tagging a sole/canonical digraph spelling is
  // safe here (decomposition into う + the standalone small kana always
  // remains). --
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
  'ゔぇ|ve': 'v',
  'ゔぉ|vo': 'v',

  // -- f: ふぁ行 loanword digraphs (canonical tagged too; ふ itself is
  // untouched by this tag — ふ=fu/hu stays hepburn/kunrei territory) --
  'ふぁ|fa': 'f',
  'ふぃ|fi': 'f',
  'ふぇ|fe': 'f',
  'ふぉ|fo': 'f',
  'ふゅ|fyu': 'f',

  // -- ye: いぇ, the sole loanword digraph with no other family to join.
  // い itself (yi) stays untagged — see the あ行 KANA_TABLE comment. --
  'いぇ|ye': 'ye',

  // -- xSmall / lSmall: standalone small-kana spellings, both families
  // tagged (canonical x-forms included — the dynamic guard in
  // `filterByStyle` is what keeps these entries typable when both
  // families are disabled at once) --
  'ぁ|xa': 'xSmall',
  'ぃ|xi': 'xSmall',
  'ぅ|xu': 'xSmall',
  'ぇ|xe': 'xSmall',
  'ぉ|xo': 'xSmall',
  'ゃ|xya': 'xSmall',
  'ゅ|xyu': 'xSmall',
  'ょ|xyo': 'xSmall',
  'ゎ|xwa': 'xSmall',
  'ゕ|xka': 'xSmall',
  'ゖ|xke': 'xSmall',
  'ぁ|la': 'lSmall',
  'ぃ|li': 'lSmall',
  'ぅ|lu': 'lSmall',
  'ぇ|le': 'lSmall',
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
  // N_PATTERNS_SINGLE_OR_DOUBLE below for the full pattern lists. --
  'ん|xn': 'xn',
  "ん|n'": 'nApos',
}

// Guide styles whose no-tagged-candidate fallback (see `pickGuideWinner`)
// prefers the *shortest* segmentation — a digraph position itself carries no
// x/l-tagged spelling, so walking into the decomposed path is what surfaces
// the following small kana's tagged spelling (xi/li). w/v/f/ye don't need
// this: unlike xSmall/lSmall, they tag their own digraph scope directly
// (see SPELLING_STYLES), so `pickGuideWinner`'s first pass already finds a
// tagged candidate at the digraph position itself.
const DECOMPOSING_GUIDE_STYLES: ReadonlySet<RomajiStyle> = new Set(['xSmall', 'lSmall'])

// Fixed precedence used to break ties when more than one selected guide
// style could tag a candidate within the same kana segment (e.g. both
// 'kunrei' and 'c' are selected and the segment has spellings tagged with
// each). Declaration order, not selection order, decides the winner, so the
// guide is deterministic regardless of the order the styles were toggled
// on in the Romaji Settings modal.
const GUIDE_STYLE_PRIORITY: readonly RomajiStyle[] =
  ['kunrei', 'c', 'q', 'digraph', 'w', 'v', 'f', 'ye', 'xn', 'nApos', 'xSmall', 'lSmall']

// っ typed explicitly (small tsu, standalone) rather than as a doubled
// consonant. Always available, including at word end where doubling has
// no following consonant to double. xtsu is the fourth MS-IME-standard
// explicit spelling, alongside xtu/ltu/ltsu.
// Exported for the SPELLING_STYLES referential-integrity sweep test only.
export const SOKUON_EXPLICIT_PATTERNS: readonly string[] = ['xtu', 'ltu', 'ltsu', 'xtsu']

// ん's own patterns, split by whether the following kana forces the
// two-keystroke spelling. な/や/あ行 (and their small-kana forms) would
// otherwise fold a bare "n" into their own na-row reading (e.g. typing
// "kani" must produce かに, not かんい), so those contexts drop the
// single-tap "n" option entirely. "n'" (the IME-style apostrophe separator)
// is valid in *both* contexts — that's its whole purpose: it confirms ん
// even before a vowel/na-row/ya-row kana without needing a second "n"
// (kan'i types かんい directly). It's also accepted at word end, confirmed
// the same way as "n"/"nn" there (per real IME behaviour, a trailing
// separator still commits the pending ん).
// Exported for the SPELLING_STYLES referential-integrity sweep test only —
// the superset of every pattern ん can resolve to (N_PATTERNS_DOUBLE_ONLY is
// a subset of this list).
export const N_PATTERNS_SINGLE_OR_DOUBLE: readonly string[] = ['n', 'nn', 'xn', "n'"]
const N_PATTERNS_DOUBLE_ONLY: readonly string[] = ['nn', 'xn', "n'"]
const N_CONTEXT_REQUIRES_DOUBLE_TAP = new Set([
  'あ', 'い', 'う', 'え', 'お', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ',
  'な', 'に', 'ぬ', 'ね', 'の',
  'や', 'ゆ', 'よ', 'ゃ', 'ゅ', 'ょ',
])

interface SegmentOption {
  /** Number of kana characters this option consumes from the word. */
  length: number
  /** Valid full-keystroke spellings for consuming exactly that many kana. */
  patterns: readonly string[]
  /** SPELLING_STYLES lookup key for this option's patterns (a KANA_TABLE
   *  key, or 'っ'/'ん' for the runtime-derived sokuon/n pattern lists).
   *  Doubled-gemination patterns reuse the underlying segment's scope,
   *  which is harmless since the synthesized doubled strings never appear
   *  in SPELLING_STYLES themselves — their filtering already happened one
   *  level down, on the patterns they were doubled from. */
  scope: string
}

interface FlatPattern {
  pattern: string
  length: number
  scope: string
}

function kanaAt(kana: readonly string[], index: number): string | undefined {
  return index >= 0 && index < kana.length ? kana[index] : undefined
}

/** Removes spellings tagged with a disabled style from `patterns`. Untagged
 *  spellings are never removed. Dynamic guard (default on): when filtering
 *  would leave the entry with no spelling at all (both xSmall and lSmall
 *  disabled on a standalone small-kana entry is the main case), the
 *  canonical (first-listed) spelling is kept regardless of its tag — no
 *  combination of disabled styles may ever make a kana untypable this way.
 *  Pass `allowEmpty: true` to skip that guard and let the result come back
 *  empty instead — used only for the 2-kana digraph branch of
 *  `getSegmentOptions` (w/v/f/ye's fully-tagged entries), where an empty
 *  digraph option is safe because the decomposed single-kana + small-kana
 *  path is always available as a fallback segmentation (see the
 *  SPELLING_STYLES header comment). Returns `patterns` unchanged (no
 *  allocation) when nothing is disabled, so the no-opts path used by every
 *  pre-existing call site is exactly as before. */
function filterByStyle(
  scope: string,
  patterns: readonly string[],
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
  opts?: { allowEmpty?: boolean },
): readonly string[] {
  if (!disabledStyles || disabledStyles.size === 0) return patterns
  const filtered = patterns.filter((pattern) => {
    const style = SPELLING_STYLES[`${scope}|${pattern}`]
    return style === undefined || !disabledStyles.has(style)
  })
  if (filtered.length > 0 || opts?.allowEmpty) return filtered
  return patterns.slice(0, 1)
}

function nPatternsFor(
  kana: readonly string[],
  index: number,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
): readonly string[] {
  const next = kanaAt(kana, index + 1)
  const base =
    next !== undefined && N_CONTEXT_REQUIRES_DOUBLE_TAP.has(next) ? N_PATTERNS_DOUBLE_ONLY : N_PATTERNS_SINGLE_OR_DOUBLE
  return filterByStyle('ん', base, disabledStyles)
}

// Doubles a segment option's patterns by prefixing each with its own
// leading consonant letter (っ + て "te" -> "tte"). Patterns that don't
// start with a plain consonant letter (a vowel, or something like the
// long-vowel mark's "-") can't be doubled and are skipped. "n" and "y"
// starts are excluded too: doubling "na" into "nna" would make "anna"
// read back as あんな (single ん + な) instead of あっな, and doubling "ya"
// into "yya" has no real IME equivalent either — real input methods never
// derive a consonant-doubled spelling from these starts, so the matcher
// must not accept it as a gemination spelling of っ. The explicit taps
// (xtu/ltu/ltsu/xtsu) remain the only way to type っ before such a kana.
function doubledPatterns(option: SegmentOption): readonly string[] {
  const doubled: string[] = []
  for (const pattern of option.patterns) {
    const first = pattern[0]
    if (first !== undefined && /[a-z]/.test(first) && !/[aiueony]/.test(first)) {
      doubled.push(first + pattern)
    }
  }
  return doubled
}

function sokuonOptions(
  kana: readonly string[],
  index: number,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
): SegmentOption[] {
  const options: SegmentOption[] = [
    { length: 1, patterns: filterByStyle('っ', SOKUON_EXPLICIT_PATTERNS, disabledStyles), scope: 'っ' },
  ]
  const next = kanaAt(kana, index + 1)
  // Gemination only makes sense against an ordinary following segment;
  // consecutive っ/ん are rare enough in real word lists that we scope
  // doubling out rather than recursing into their own special cases.
  if (next !== undefined && next !== 'ん' && next !== 'っ') {
    for (const nextOption of getSegmentOptions(kana, index + 1, disabledStyles)) {
      const patterns = doubledPatterns(nextOption)
      if (patterns.length > 0) {
        options.push({ length: 1 + nextOption.length, patterns, scope: nextOption.scope })
      }
    }
  }
  return options
}

/** Every (kana-length, spellings) group that could start at `index`. Always
 *  returns at least one option while `index` is within the word (falling
 *  back to typing the raw character itself for anything outside the
 *  table, per the passthrough rule for未対応文字). `disabledStyles` prunes
 *  tagged alternate spellings out of each option's pattern list; canonical
 *  spellings are never tagged, so they always survive. */
function getSegmentOptions(
  kana: readonly string[],
  index: number,
  disabledStyles?: ReadonlySet<RomajiStyle>,
): SegmentOption[] {
  const current = kanaAt(kana, index)
  if (current === undefined) return []

  if (current === 'ん') return [{ length: 1, patterns: nPatternsFor(kana, index, disabledStyles), scope: 'ん' }]
  if (current === 'っ') return sokuonOptions(kana, index, disabledStyles)

  const options: SegmentOption[] = []
  const next = kanaAt(kana, index + 1)
  if (next !== undefined) {
    const digraphKey = current + next
    const digraph = KANA_TABLE[digraphKey]
    if (digraph) {
      // No empty-guard here (see filterByStyle's doc comment): a 2-kana
      // digraph key's first half always has its own KANA_TABLE entry (the
      // `single` option pushed below), so when a fully-tagged digraph
      // family (w/v/f/ye) is entirely disabled, this option is simply
      // omitted and the decomposed single + following-small-kana path
      // carries the segment instead.
      const filtered = filterByStyle(digraphKey, digraph, disabledStyles, { allowEmpty: true })
      if (filtered.length > 0) options.push({ length: 2, patterns: filtered, scope: digraphKey })
    }
  }
  const single = KANA_TABLE[current]
  if (single) options.push({ length: 1, patterns: filterByStyle(current, single, disabledStyles), scope: current })

  if (options.length === 0) options.push({ length: 1, patterns: [current], scope: current })
  return options
}

function flattenOptions(options: readonly SegmentOption[]): FlatPattern[] {
  const flat: FlatPattern[] = []
  for (const option of options) {
    for (const pattern of option.patterns) flat.push({ pattern, length: option.length, scope: option.scope })
  }
  return flat
}

// Deterministic tie-break for "which candidate represents this position":
// prefer the option consuming the most kana (a digraph reading over its
// decomposed one), then whichever pattern is listed first within that
// group (the table's declared canonical spelling).
function pickWinner(candidates: readonly FlatPattern[]): FlatPattern {
  let winner = candidates[0]
  for (const candidate of candidates) {
    if (candidate.length > winner.length) winner = candidate
  }
  return winner
}

/** Guide-only variant of `pickWinner`: when `guideStyles` names one or more
 *  styles, walks `GUIDE_STYLE_PRIORITY` in order and returns the first
 *  priority style's tagged candidates (via `pickWinner`'s usual tie-break
 *  among just those candidates) — so when several selected styles could
 *  each tag a different candidate within the same segment, the earlier
 *  style in `GUIDE_STYLE_PRIORITY` wins, independent of the order the
 *  styles were toggled on in the modal. When none of the selected styles
 *  tags any candidate here at all, falls through to a second pass: for the
 *  small-kana styles there is a second-level preference, since a digraph
 *  position itself has no x/l tag (dhi carries no tag) — prefer the
 *  *shortest* segmentation, which walks the guide into the decomposed
 *  path, where the following small kana's tagged spelling (xi/li) can then
 *  surface (でぃ -> "dexi"/"deli"). With no `guideStyles` selected at all
 *  (or none survive the segment), behaves exactly like `pickWinner` — the
 *  canonical Hepburn-based spelling. Never used for acceptance — only
 *  `representativeAt`/`canonicalGuideFrom` (guide display) call this, so
 *  `guideStyles` never affects what `acceptChar` accepts or commits. */
function pickGuideWinner(candidates: readonly FlatPattern[], guideStyles: ReadonlySet<RomajiStyle> | undefined): FlatPattern {
  if (guideStyles && guideStyles.size > 0) {
    for (const style of GUIDE_STYLE_PRIORITY) {
      if (!guideStyles.has(style)) continue
      const preferred = candidates.filter((c) => SPELLING_STYLES[`${c.scope}|${c.pattern}`] === style)
      if (preferred.length > 0) return pickWinner(preferred)
    }
    for (const style of GUIDE_STYLE_PRIORITY) {
      if (guideStyles.has(style) && DECOMPOSING_GUIDE_STYLES.has(style)) {
        let shortest = candidates[0]
        for (const candidate of candidates) {
          if (candidate.length < shortest.length) shortest = candidate
        }
        // Among equal-length candidates, candidates[0] is already the
        // first-listed (canonical) spelling thanks to flatten order.
        return shortest
      }
    }
  }
  return pickWinner(candidates)
}

function representativeAt(
  kana: readonly string[],
  index: number,
  buffer: string,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
  guideStyles: ReadonlySet<RomajiStyle> | undefined,
): FlatPattern | null {
  const flat = flattenOptions(getSegmentOptions(kana, index, disabledStyles))
  const alive = flat.filter((f) => f.pattern.startsWith(buffer))
  return alive.length > 0 ? pickGuideWinner(alive, guideStyles) : null
}

function canonicalGuideFrom(
  kana: readonly string[],
  index: number,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
  guideStyles: ReadonlySet<RomajiStyle> | undefined,
): string {
  if (index >= kana.length) return ''
  const winner = representativeAt(kana, index, '', disabledStyles, guideStyles)
  if (!winner) return ''
  return winner.pattern + canonicalGuideFrom(kana, index + winner.length, disabledStyles, guideStyles)
}

/** The winning pattern that exactly matches `buffer` as a full spelling at
 *  `index`, or null when nothing does. Shared by the retroactive-commit
 *  path in `stepAt`/`tryConsume` and by `isComplete`, both of which need to
 *  know whether the in-progress buffer already spells a complete segment
 *  (ん's bare "n" pending a possible second "n" is the only real case).
 *  Acceptance-only: never takes `guideStyles`, since it never feeds a guide. */
function exactWinnerAt(
  kana: readonly string[],
  index: number,
  buffer: string,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
): FlatPattern | null {
  const flat = flattenOptions(getSegmentOptions(kana, index, disabledStyles))
  const exact = flat.filter((f) => f.pattern === buffer)
  return exact.length > 0 ? pickWinner(exact) : null
}

interface StepResult {
  status: 'accept' | 'complete'
  position: number
  buffer: string
  /** The pattern just committed, set only when `status === 'complete'`. */
  committed?: string
}

/** Feeds `char` onto `buffer` at `index` and resolves it against the live
 *  pattern list: 'accept' when the extended buffer is still a live prefix
 *  of at least one pattern, 'complete' when it exactly (and unambiguously)
 *  finishes one, or null when it isn't a live continuation at all. Used by
 *  `tryConsume` both for the current typing position and — after a
 *  retroactive commit — for the position immediately after it, so the two
 *  call sites share one prefix/exact/pickWinner resolution instead of each
 *  re-deriving it. */
function stepAt(
  kana: readonly string[],
  index: number,
  buffer: string,
  char: string,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
): StepResult | null {
  const flat = flattenOptions(getSegmentOptions(kana, index, disabledStyles))
  const newBuffer = buffer + char
  const alive = flat.filter((f) => f.pattern.startsWith(newBuffer))
  if (alive.length === 0) return null
  const exact = alive.filter((f) => f.pattern === newBuffer)
  const hasLonger = alive.some((f) => f.pattern.length > newBuffer.length)
  if (exact.length > 0 && !hasLonger) {
    const winner = pickWinner(exact)
    return { status: 'complete', position: index + winner.length, buffer: '', committed: winner.pattern }
  }
  return { status: 'accept', position: index, buffer: newBuffer }
}

export type RomajiAcceptResult = 'accept' | 'reject' | 'complete'

export interface RomajiMatcher {
  /** Feeds one keystroke. Returns 'reject' (state left untouched) when no
   *  live spelling accepts it, 'complete' when it finishes a kana segment,
   *  otherwise 'accept'. */
  acceptChar(c: string): RomajiAcceptResult
  /** Confirmed romaji for completed segments, plus the in-progress buffer. */
  typedRomaji(): string
  /** Canonical spelling for the rest of the word, continuing from what has
   *  already been typed for the current segment. Recomputed on every
   *  keystroke, so it tracks whichever spelling the user is actually
   *  typing once earlier alternatives fall out of contention. */
  remainingGuide(): string
  isComplete(): boolean
  /** Number of kana characters fully confirmed so far — i.e. committed
   *  segments only, excluding whatever's in the in-progress keystroke
   *  buffer for the segment currently being typed. Romaji spelling length
   *  varies per kana (で = "de", でぃ = "dhi"), so `typedRomaji().length`
   *  can't be mapped back to a kana count; the UI uses this instead to
   *  color the word's kana characters up through what's actually locked in. */
  completedKanaCount(): number
}

interface ConsumeResult {
  status: RomajiAcceptResult
  position: number
  buffer: string
  typed: string
}

export interface RomajiMatcherOptions {
  /** Styles to exclude from acceptance. Every word remains completable
   *  regardless of the combination chosen, via one of three mechanisms (see
   *  the SPELLING_STYLES header comment for the full breakdown):
   *  c/q/digraph tag only non-canonical alternates, so filtering never
   *  empties an entry; hepburn/kunrei and xSmall/lSmall tag both sides of
   *  their respective pair, so disabling one side still leaves the other
   *  sufficient, and where disabling both at once would empty an entry's
   *  spelling set, `filterByStyle`'s dynamic guard keeps that entry's
   *  canonical spelling alive as a last resort; w/v/f/ye tag every spelling
   *  of their own 2-kana digraph entries (including the canonical one) and
   *  deliberately skip that guard, since disabling the whole family instead
   *  forces the always-available decomposed spelling (ふぁ -> "fu"+"xa"). */
  disabledStyles?: readonly RomajiStyle[]
  /** Preferred styles for `remainingGuide()`'s displayed spelling. Any
   *  combination may be selected simultaneously — e.g. `['xSmall',
   *  'kunrei']` surfaces both the small-kana-decomposition preference and
   *  the kunrei alternate in the same guide, each applying to whichever
   *  kana segments its own tag matches. When more than one selected style
   *  could tag distinct candidates within a single segment, precedence is
   *  `GUIDE_STYLE_PRIORITY`'s declaration order (see `pickGuideWinner`),
   *  not the order styles appear in this array. Undefined/empty (the
   *  default) keeps the pre-existing canonical/longest-match tie-break —
   *  i.e. the plain Hepburn-based spelling, replacing the old `'auto'`
   *  sentinel. Display-only: never affects what `acceptChar` accepts. */
  guideStyles?: readonly RomajiStyle[]
}

export function createRomajiMatcher(word: string, opts?: RomajiMatcherOptions): RomajiMatcher {
  const kana = [...word].map(toHiragana)
  const disabledStyles =
    opts?.disabledStyles && opts.disabledStyles.length > 0 ? new Set(opts.disabledStyles) : undefined
  const guideStyles =
    opts?.guideStyles && opts.guideStyles.length > 0 ? new Set(opts.guideStyles) : undefined
  let position = 0
  let buffer = ''
  let typed = ''

  function tryConsume(char: string): ConsumeResult | null {
    if (position >= kana.length) return null

    const step = stepAt(kana, position, buffer, char, disabledStyles)
    if (step) {
      return step.status === 'complete'
        ? { status: 'complete', position: step.position, buffer: '', typed: typed + (step.committed ?? '') }
        : { status: 'accept', position: step.position, buffer: step.buffer, typed }
    }

    // Not a live continuation of the current segment. If the buffer typed
    // so far already exactly finished a spelling (ん's "n" pending a
    // possible second "n"), retroactively commit that segment and retry
    // this keystroke fresh against the next kana position.
    if (buffer === '') return null
    const winner = exactWinnerAt(kana, position, buffer, disabledStyles)
    if (!winner) return null

    const nextPosition = position + winner.length
    const nextTyped = typed + winner.pattern
    if (nextPosition >= kana.length) return null

    const nextStep = stepAt(kana, nextPosition, '', char, disabledStyles)
    if (!nextStep) return null

    return nextStep.status === 'complete'
      ? { status: 'complete', position: nextStep.position, buffer: '', typed: nextTyped + (nextStep.committed ?? '') }
      : { status: 'accept', position: nextStep.position, buffer: nextStep.buffer, typed: nextTyped }
  }

  return {
    acceptChar(c: string): RomajiAcceptResult {
      const result = tryConsume(c)
      if (!result) return 'reject'
      position = result.position
      buffer = result.buffer
      typed = result.typed
      return result.status
    },

    typedRomaji(): string {
      return typed + buffer
    },

    remainingGuide(): string {
      if (position >= kana.length) return ''
      const winner = representativeAt(kana, position, buffer, disabledStyles, guideStyles)
      if (!winner) return ''
      return (
        winner.pattern.slice(buffer.length) +
        canonicalGuideFrom(kana, position + winner.length, disabledStyles, guideStyles)
      )
    },

    isComplete(): boolean {
      if (position >= kana.length) return true
      if (buffer === '') return false
      // A pending exact match (ん's bare "n") already finished the word
      // even though a longer alternative ("nn") is still theoretically
      // typeable — word-final ん must be completable with a single tap.
      const winner = exactWinnerAt(kana, position, buffer, disabledStyles)
      return winner !== null && position + winner.length >= kana.length
    },

    completedKanaCount(): number {
      return position
    },
  }
}
