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
// the table. That lookahead also covers mozc's own composer behaviour of
// committing a pending "n" the moment the *next keystroke* is a consonant
// that ん's own spellings can't extend, even when the guide would otherwise show
// the forced double-tap form for that context (see the retroactive-commit
// branch of `tryConsume`).
//
// The spelling tables KANA_TABLE and PUNCTUATION_TABLE live in
// romaji-tables.ts; the source-of-truth rule for what KANA_TABLE may
// contain is in that file's header.

import { toHiragana } from './kana-script'
import { isRomajiPunctuation } from '../../shared/kana-purity'
import { KANA_TABLE, PUNCTUATION_TABLE, SPELLING_STYLES } from './romaji-tables'
import type { RomajiStyle } from './romaji-tables'

export { BASE_STYLES, KANA_TABLE, PUNCTUATION_TABLE, SPELLING_STYLES } from './romaji-tables'
export type { RomajiStyle } from './romaji-tables'

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
// Next-keystroke class that lets a pending single "n" retroactively commit
// as ん (see the fallback in `tryConsume`): every consonant that can't
// extend ん's own spellings. Vowels, "n", and "y" stay excluded — they'd
// fold the pending "n" into a na/nya-row reading instead. Deliberately one
// letter narrower than `doubledPatterns`' vowel/n exclusion, where "y" is
// a valid doubling start (mozc's yy row).
const N_SINGLE_COMMIT_NEXT_KEY = /^[b-df-hj-mp-tv-xz]$/
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
// long-vowel mark's "-") can't be doubled and are skipped. "n" starts stay
// excluded: doubling "na" into "nna" would make "anna" read back as あんな
// (single ん + な) instead of あっな. "y" starts are doubleable, matching
// mozc's own romaji table (yy -> っ + y is one of its listed doubling
// rows), so "yya"/"yyo" etc. are accepted here too. っち also gets the
// extra "tch-" derivation on top of its own leading-letter double
// ("cchi"): mozc's table has an explicit "tch -> っ + ch" row alongside the
// regular per-letter doubling rows, so a pattern starting with "ch" (chi,
// cha, chu, che, cho) additionally doubles via a literal "t" prefix.
function doubledPatterns(option: SegmentOption): readonly string[] {
  const doubled: string[] = []
  for (const pattern of option.patterns) {
    const first = pattern[0]
    if (first !== undefined && /[a-z]/.test(first) && !/[aiueon]/.test(first)) {
      doubled.push(first + pattern)
      if (pattern.startsWith('ch')) doubled.push('t' + pattern)
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
 *  returns at least one option while `index` is within the word: a
 *  PUNCTUATION_TABLE entry (。、？！) is consulted before the final
 *  passthrough, which falls back to typing the raw character itself for
 *  anything still outside both tables. `disabledStyles` prunes tagged
 *  alternate spellings out of each option's pattern list; canonical
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

  if (options.length === 0 && isRomajiPunctuation(current)) {
    options.push({ length: 1, patterns: PUNCTUATION_TABLE[current], scope: current })
  }
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

/** The first character `canonicalGuideFrom(kana, index, ...)` would
 *  produce, without recursively building the guide for the rest of the
 *  word — just one segment's `representativeAt` call. Used by
 *  `nextGuideChar`'s fallthrough case (see its own doc comment). */
function firstGuideCharAt(
  kana: readonly string[],
  index: number,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
  guideStyles: ReadonlySet<RomajiStyle> | undefined,
): string | undefined {
  if (index >= kana.length) return undefined
  const winner = representativeAt(kana, index, '', disabledStyles, guideStyles)
  return winner ? winner.pattern[0] : undefined
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

/** The single segmentation walk every canonical-spelling reader (guide
 *  string, mistake-tally key, weak-spot candidate tokenization) shares:
 *  each recursive step picks the winning pattern at `index` via
 *  `representativeAt` and returns it alongside every following segment's
 *  own token, so the two accumulation shapes below (`canonicalGuideFrom`'s
 *  joined string, `canonicalRomajiSegments`' array) can never drift apart
 *  — there is exactly one place that decides where a segment boundary
 *  falls. */
function canonicalSegmentsFrom(
  kana: readonly string[],
  index: number,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
  guideStyles: ReadonlySet<RomajiStyle> | undefined,
): string[] {
  if (index >= kana.length) return []
  const winner = representativeAt(kana, index, '', disabledStyles, guideStyles)
  if (!winner) return []
  return [winner.pattern, ...canonicalSegmentsFrom(kana, index + winner.length, disabledStyles, guideStyles)]
}

function canonicalGuideFrom(
  kana: readonly string[],
  index: number,
  disabledStyles: ReadonlySet<RomajiStyle> | undefined,
  guideStyles: ReadonlySet<RomajiStyle> | undefined,
): string {
  return canonicalSegmentsFrom(kana, index, disabledStyles, guideStyles).join('')
}

/** Canonical romaji spelling of a kana substring (e.g. a single completed
 *  segment sliced from a word via `completedKanaCount()`'s before/after
 *  positions) — the same first-listed/longest-match spelling
 *  `canonicalGuideFrom` would show as the guide with no style preference
 *  selected. Used to key mistake-tracking so the same kana always tallies
 *  under one spelling regardless of which alternate the user actually
 *  typed. Always lowercase, since `KANA_TABLE`'s spellings are. */
export function canonicalRomaji(kana: string): string {
  const kanaArr = [...kana].map(toHiragana)
  return canonicalGuideFrom(kanaArr, 0, undefined, undefined)
}

/** Same segmentation walk as {@link canonicalRomaji} — literally the same
 *  `canonicalSegmentsFrom` call, just left as an array instead of joined
 *  into one string — e.g. "きゃっぷ" -> `["kya", "p", "pu"]`. Joining the
 *  result reproduces `canonicalRomaji(kana)` exactly, by construction (see
 *  `canonicalGuideFrom`'s own one-line implementation above). Used to
 *  tokenize a CANDIDATE word into the same segment units `mistakes` keys
 *  are recorded under, for exact-token weak-spot matching (never flat
 *  substring matching — see weak-spot-weighting.ts). */
export function canonicalRomajiSegments(kana: string): string[] {
  const kanaArr = [...kana].map(toHiragana)
  return canonicalSegmentsFrom(kanaArr, 0, undefined, undefined)
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
  /** Equivalent to `remainingGuide()[0]` (the next character the guide
   *  would display), computed without building the guide for the rest of
   *  the word — a cheap read for a caller that only needs one character
   *  (e.g. the run-keystroke-log recorder's per-press `expectedChar`). */
  nextGuideChar(): string | undefined
  isComplete(): boolean
  /** Number of kana characters fully confirmed so far — i.e. committed
   *  segments only, excluding whatever's in the in-progress keystroke
   *  buffer for the segment currently being typed. Romaji spelling length
   *  varies per kana (で = "de", でぃ = "dhi"), so `typedRomaji().length`
   *  can't be mapped back to a kana count; the UI uses this instead to
   *  color the word's kana characters up through what's actually locked in. */
  completedKanaCount(): number
  /** Canonical romaji spelling of the kana segment currently being
   *  attempted at this matcher's live position/buffer — the same
   *  candidate `remainingGuide()`/`nextGuideChar()` read off, resolved to
   *  its full kana span and re-canonicalized style-agnostically (see
   *  `canonicalRomaji`) so it matches the spelling a real completed
   *  segment would tally under in `TypingTestState.mistakes`
   *  (`handleRomajiChar` in run-state.ts). Used by run-log-recorder.ts
   *  (via `deriveMistakeKey`/`currentRomajiMistakeKey`) to attribute a
   *  REJECTED keystroke to the eventual mistake-map key without waiting
   *  for the segment to actually finish — this is exactly the
   *  "recorded at input time" design this feature deliberately chose
   *  over replaying the saved log afterward (non-deterministic for
   *  romaji: which alternate spelling family a segment resolves under
   *  depends on what the user goes on to type). Best-effort, not a
   *  guarantee: if the user later abandons this candidate for an
   *  entirely different spelling family, the segment that eventually
   *  completes could resolve a different kana span than the one
   *  snapshotted here. Returns undefined once the word is already fully
   *  matched. */
  currentSegmentCanonicalKey(): string | undefined
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
    let winner = exactWinnerAt(kana, position, buffer, disabledStyles)
    // mozc's composer commits a pending "n" as ん the moment the next
    // keystroke is a consonant that can't extend any of ん's own spellings
    // (n/nn/xn/n'), even in contexts whose guide shows the forced
    // double-tap form (N_CONTEXT_REQUIRES_DOUBLE_TAP only governs
    // nPatternsFor's forward-looking pattern list, not this backward
    // lookahead). E.g. んう typed "nwu": "n" alone isn't a live prefix of
    // う's own patterns, but "n" + "w" can't continue as ん's own spelling
    // either, so mozc commits the pending ん and reprocesses "w" against
    // the next kana — "kani" must still reject, since "i" is a vowel and
    // stays excluded here, along with "y" (yi/ya/yu/yo could extend ん's
    // own "n" into a na-row misreading the same way a vowel would).
    // Synthesizing the winner without `filterByStyle` is safe only because
    // bare "n" is permanently untagged (see SPELLING_STYLES' ん comment).
    if (!winner && buffer === 'n' && kanaAt(kana, position) === 'ん' && N_SINGLE_COMMIT_NEXT_KEY.test(char)) {
      winner = { pattern: 'n', length: 1, scope: 'ん' }
    }
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

    nextGuideChar(): string | undefined {
      if (position >= kana.length) return undefined
      const winner = representativeAt(kana, position, buffer, disabledStyles, guideStyles)
      if (!winner) return undefined
      const rest = winner.pattern.slice(buffer.length)
      // Mirrors remainingGuide's own fallthrough: when the current
      // segment's winner is already fully typed (buffer === winner.pattern
      // exactly — e.g. a pending bare "n" that could still extend to
      // "nn"), the next displayed character comes from the following
      // segment instead.
      return rest.length > 0 ? rest[0] : firstGuideCharAt(kana, position + winner.length, disabledStyles, guideStyles)
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

    currentSegmentCanonicalKey(): string | undefined {
      if (position >= kana.length) return undefined
      const winner = representativeAt(kana, position, buffer, disabledStyles, guideStyles)
      if (!winner) return undefined
      return canonicalRomaji(word.slice(position, position + winner.length))
    },
  }
}
