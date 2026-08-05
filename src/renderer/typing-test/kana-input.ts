// SPDX-License-Identifier: GPL-2.0-or-later

/** JIS かな入力 (kana direct input) mode: an alternative to romaji-input.ts
 *  for the same kana word packs (japanese_hiragana / japanese_katakana —
 *  see KANA_INPUT_LANGUAGES). Unlike romaji mode, correctness is judged
 *  from the PHYSICAL key (`KeyboardEvent.code`) plus `shiftKey`, resolved
 *  through the standard JIS かな layout table below (JIS X 6002-style
 *  physical assignments, the same かな-per-key mapping every JIS かな
 *  keyboard/IME uses) — never from `e.key` (which depends on the OS
 *  layout/IME and is meaningless for this table) and never through an
 *  OS/IME かな input mode (the whole point of this feature: no IME
 *  switching required).
 *
 *  SHIFT-TOLERANCE RULE (this is the feature's whole reason to exist): a
 *  physical key that has NO shifted かな of its own
 *  (`KANA_LAYOUT[code][1] === null`) ignores the actual shift state
 *  entirely. Only keys that DO carry a shifted かな (the ぁぃぅぇぉゃゅょっを
 *  row) require the shift state to match. This lets a user hold Shift down
 *  across a small-kana keystroke and the very next, unrelated keystroke
 *  without being penalized for not releasing it in between — real IME
 *  かな input is exactly this forgiving. See `strokeMatches`.
 *
 *  Unlike romaji-input.ts's RomajiMatcher (which must replay a keystroke
 *  history because a kana's romaji spelling is ambiguous — multiple valid
 *  spellings compete until one becomes unambiguous), kana-mode resolution
 *  is fully deterministic: a given physical code+shift either is or isn't
 *  the next required stroke, with no history-dependent branching. So
 *  TypingTestState just tracks two plain numbers/flags directly
 *  (`kanaCharIndex`/`kanaAwaitingMark`) instead of a replayed keystroke
 *  log — see run-state.ts. */

import { toHiragana } from './kana-script'
import { serialize } from '../../shared/keycodes/keycodes'
import type { TypingTestConfig } from './types'
import type { TypingTestState } from './run-state'
import { isSubmitKey, advanceAfterWord } from './run-state'
import {
  isRomajiInputEnabled, isKanaInputSelected, romajiDetail, isRomajiCapable, isLineEndEnterRequired,
} from './romaji-input'

/** One physical keystroke: a `KeyboardEvent.code` value plus whether Shift
 *  was held. */
export interface KanaStroke {
  code: string
  shift: boolean
}

/** Standard JIS かな layout: physical key position -> [plain かな, shifted
 *  かな or null]. A `null` shifted slot means that key has no shifted かな
 *  at all — see the module doc comment's shift-tolerance rule for why
 *  that fact (not the actual shift state at press time) decides whether
 *  shift is checked. Deliberately does NOT cover 、。「」 or other
 *  punctuation, which sit outside the standard かな assignment grid;
 *  `strokesForKana` falls back to verbatim matching for any character
 *  outside this table (see its own doc comment). */
export const KANA_LAYOUT: Record<string, readonly [string, string | null]> = {
  Digit1: ['ぬ', null], Digit2: ['ふ', null], Digit3: ['あ', 'ぁ'], Digit4: ['う', 'ぅ'], Digit5: ['え', 'ぇ'],
  Digit6: ['お', 'ぉ'], Digit7: ['や', 'ゃ'], Digit8: ['ゆ', 'ゅ'], Digit9: ['よ', 'ょ'], Digit0: ['わ', 'を'],
  Minus: ['ほ', null], Equal: ['へ', null], IntlYen: ['ー', null],
  KeyQ: ['た', null], KeyW: ['て', null], KeyE: ['い', 'ぃ'], KeyR: ['す', null], KeyT: ['か', null],
  KeyY: ['ん', null], KeyU: ['な', null], KeyI: ['に', null], KeyO: ['ら', null], KeyP: ['せ', null],
  BracketLeft: ['゛', null], BracketRight: ['゜', null],
  KeyA: ['ち', null], KeyS: ['と', null], KeyD: ['し', null], KeyF: ['は', null], KeyG: ['き', null],
  KeyH: ['く', null], KeyJ: ['ま', null], KeyK: ['の', null], KeyL: ['り', null],
  Semicolon: ['れ', null], Quote: ['け', null], Backslash: ['む', null],
  KeyZ: ['つ', 'っ'], KeyX: ['さ', null], KeyC: ['そ', null], KeyV: ['ひ', null], KeyB: ['こ', null],
  KeyN: ['み', null], KeyM: ['も', null], Comma: ['ね', null], Period: ['る', null], Slash: ['め', null],
  IntlRo: ['ろ', null],
}

/** QMK keycodes for the JIS-specific physical positions KANA_LAYOUT
 *  resolves a かな from (IntlRo -> KC_RO, IntlYen -> KC_JYEN) plus the two
 *  ISO-layout keycodes that can occupy the Backslash/む position on some
 *  physical layouts (KC_NONUS_BSLASH) or an adjacent JIS row
 *  (KC_NONUS_HASH) — none of these declare a `printable` legend in
 *  keycodes.ts (see KEYCODES_ISO/KEYCODES_JIS), so keycode-char-map.ts's
 *  mode-agnostic `producesChar` never recognizes them as char-producing
 *  on its own, correctly, since verbatim/romaji runs never type かな
 *  through them. Kana mode judges correctness from `KeyboardEvent.code` +
 *  `shiftKey`, entirely independent of which QMK keycode the firmware
 *  happens to bind at that physical position — so while kana mode IS
 *  typing through one of these, it DOES produce a かな char, and
 *  run-log-recorder.ts must not silently exclude it from its press<->char
 *  pairing queues (excluding it would permanently desync every keystroke
 *  after it — see that module's own doc comment). */
const KANA_UNPRINTED_JIS_QMKIDS = new Set(['KC_RO', 'KC_JYEN', 'KC_NONUS_HASH', 'KC_NONUS_BSLASH'])

/** True when `code` is one of `KANA_UNPRINTED_JIS_QMKIDS` — used by
 *  run-log-recorder.ts (via `context.kanaInput`) to recognize a physical
 *  JIS-position keystroke as char-producing ONLY while kana mode is
 *  actually the one typing through it, alongside the mode-agnostic
 *  `producesChar` check (keycode-char-map.ts) it never replaces. */
export function isKanaPhysicalPositionKeycode(code: number): boolean {
  const qmkId = serialize(code)
  return qmkId !== null && KANA_UNPRINTED_JIS_QMKIDS.has(qmkId)
}

/** Word-language packs the kana matcher supports — the exact same set as
 *  romaji-input.ts's ROMAJI_INPUT_LANGUAGES, since kana mode is a sibling
 *  input METHOD for the same kana word packs, not a different capability
 *  domain. Re-exported under its own name so call sites reading
 *  kana-input.ts don't need to know it's an alias. */
export { ROMAJI_INPUT_LANGUAGES as KANA_INPUT_LANGUAGES } from './types'

/** Dakuten (゛) かな -> base かな. Typed as the base stroke followed by the
 *  BracketLeft stroke (always unshifted — see KANA_LAYOUT.BracketLeft). */
export const DAKUTEN_BASE_KANA: Record<string, string> = {
  が: 'か', ぎ: 'き', ぐ: 'く', げ: 'け', ご: 'こ',
  ざ: 'さ', じ: 'し', ず: 'す', ぜ: 'せ', ぞ: 'そ',
  だ: 'た', ぢ: 'ち', づ: 'つ', で: 'て', ど: 'と',
  ば: 'は', び: 'ひ', ぶ: 'ふ', べ: 'へ', ぼ: 'ほ',
  ゔ: 'う',
}

/** Handakuten (゜) かな -> base かな. Typed as the base stroke followed by
 *  the BracketRight stroke (always unshifted). */
export const HANDAKUTEN_BASE_KANA: Record<string, string> = {
  ぱ: 'は', ぴ: 'ひ', ぷ: 'ふ', ぺ: 'へ', ぽ: 'ほ',
}

/** Reverse lookup: かな character -> its single direct stroke, built once
 *  from KANA_LAYOUT. Only かな with their own physical key land here — 濁音
 *  /半濁音 かな (が, ぱ, ...) resolve through DAKUTEN_BASE_KANA/
 *  HANDAKUTEN_BASE_KANA + this map on their BASE かな instead (see
 *  `strokesForKana`). */
const DIRECT_STROKE_FOR_KANA: Record<string, KanaStroke> = (() => {
  const table: Record<string, KanaStroke> = {}
  for (const [code, [plain, shifted]] of Object.entries(KANA_LAYOUT)) {
    table[plain] = { code, shift: false }
    if (shifted !== null) table[shifted] = { code, shift: true }
  }
  return table
})()

/** True when `code` carries a shifted かな of its own — the sole input to
 *  the shift-tolerance rule (see the module doc comment). A property of
 *  the physical key, independent of any particular stroke's own `shift`
 *  value. */
function codeHasShiftVariant(code: string): boolean {
  const entry = KANA_LAYOUT[code]
  return entry !== undefined && entry[1] !== null
}

/** THE core shift-tolerance rule (see the module doc comment), as a
 *  standalone pure predicate: does the physical keystroke (`actualCode` +
 *  `actualShift`) satisfy `want`? Keys WITHOUT a shifted かな (most of the
 *  table) accept either shift state; keys WITH one (ぁぃぅぇぉゃゅょっを's
 *  row) require the shift state to match exactly. */
export function strokeMatches(want: KanaStroke, actualCode: string, actualShift: boolean): boolean {
  if (want.code !== actualCode) return false
  return codeHasShiftVariant(want.code) ? want.shift === actualShift : true
}

/** Physical stroke(s) needed to type かな character `ch` (already
 *  hiragana-normalized by the caller — see `kanaUnitsForWord`): a direct
 *  かな resolves to its single stroke; a 濁音/半濁音 かな resolves to its
 *  base かな's stroke followed by the dakuten/handakuten mark stroke;
 *  anything else (punctuation, kanji, ascii — characters outside the
 *  standard かな assignment grid this table covers) returns null, meaning
 *  kana mode can't resolve a physical position for it at all —
 *  `kanaUnitsForWord` falls back to verbatim key matching for such a
 *  position instead (see `KanaUnit.strokes`'s own doc comment). */
export function strokesForKana(ch: string): KanaStroke[] | null {
  const direct = DIRECT_STROKE_FOR_KANA[ch]
  if (direct) return [direct]
  const dakuBase = DAKUTEN_BASE_KANA[ch]
  if (dakuBase) {
    const base = DIRECT_STROKE_FOR_KANA[dakuBase]
    if (!base) return null
    return [base, { code: 'BracketLeft', shift: false }]
  }
  const handakuBase = HANDAKUTEN_BASE_KANA[ch]
  if (handakuBase) {
    const base = DIRECT_STROKE_FOR_KANA[handakuBase]
    if (!base) return null
    return [base, { code: 'BracketRight', shift: false }]
  }
  return null
}

/** Full physical keystroke sequence to type `word` in kana mode, after
 *  katakana -> hiragana normalization. Characters kana mode can't resolve
 *  (see `strokesForKana`) contribute no strokes here — this is a
 *  best-effort flattened stroke list (e.g. for driving an E2E test's
 *  matrix taps), not a completeness guarantee; `kanaUnitsForWord`/the
 *  matcher are the authority on per-character resolvability during an
 *  actual run (see `KanaUnit.strokes`). */
export function kanaStrokes(word: string): KanaStroke[] {
  const strokes: KanaStroke[] = []
  for (const raw of word) {
    const s = strokesForKana(toHiragana(raw))
    if (s) strokes.push(...s)
  }
  return strokes
}

/** One target character's kana-mode resolution, as consumed by the
 *  matcher/guide. `char` is the hiragana-normalized かな to type when
 *  `strokes` is non-null; for a character kana mode can't resolve at all,
 *  `char` is the ORIGINAL (un-normalized) character and `strokes` is null
 *  — such a position falls back to verbatim single-character matching
 *  against the raw DOM `key` (see `tryAcceptStroke`), exactly like
 *  non-romaji verbatim mode's own per-position matching, rather than
 *  making the whole run kana-incapable over one stray punctuation mark. */
export interface KanaUnit {
  char: string
  strokes: KanaStroke[] | null
  /** True only for a single-stroke character whose own stroke needs Shift
   *  (the ぁぃぅぇぉゃゅょっを row) — used by the stroke guide to mark
   *  which upcoming characters need Shift held. Always false for a
   *  2-stroke (濁音/半濁音) or unresolved character — see the module doc
   *  comment: neither ever needs shift in this table. */
  needsShift: boolean
}

export function kanaUnitsForWord(word: string): KanaUnit[] {
  return [...word].map((raw) => {
    const hira = toHiragana(raw)
    const strokes = strokesForKana(hira)
    const needsShift = strokes !== null && strokes.length === 1 && strokes[0].shift
    return { char: strokes !== null ? hira : raw, strokes, needsShift }
  })
}

interface StrokeStepResult {
  status: 'reject' | 'accept' | 'complete'
}

/** Judges one physical keystroke against `unit`, at stroke index
 *  `awaitingMark ? 1 : 0` (the dakuten/handakuten mark is always the
 *  SECOND stroke of a 2-stroke unit — see `strokesForKana`). 'accept'
 *  means the first of two strokes landed and the mark is still pending;
 *  'complete' means this was the unit's last (or only) required stroke.
 *  For an unresolved unit (`strokes === null`), falls back to verbatim
 *  matching against `key` (the raw DOM `KeyboardEvent.key`) — see
 *  `KanaUnit`'s own doc comment. */
export function tryAcceptStroke(unit: KanaUnit, awaitingMark: boolean, code: string, shift: boolean, key: string): StrokeStepResult {
  if (unit.strokes === null) {
    return { status: key === unit.char ? 'complete' : 'reject' }
  }
  const strokeIndex = awaitingMark ? 1 : 0
  const want = unit.strokes[strokeIndex]
  if (!want || !strokeMatches(want, code, shift)) return { status: 'reject' }
  return { status: strokeIndex === unit.strokes.length - 1 ? 'complete' : 'accept' }
}

// --- capability / active predicates -------------------------------------

/** Kana mode shares romaji mode's exact capability domain (see
 *  KANA_INPUT_LANGUAGES) — re-exported under its own name purely so
 *  callers reading kana-input.ts don't need to also know about
 *  romaji-input.ts's isRomajiCapable. */
export const isKanaCapable = isRomajiCapable

/** True when the config has opted into sequential keystroke judging
 *  (shared with romaji mode — see isRomajiInputEnabled), the mode/content
 *  combination is capable of it, AND the user has selected 'kana' as the
 *  input method (see RomajiDetailSettings.inputMethod, default 'romaji').
 *  Mutually exclusive with isRomajiInputActive by construction — see that
 *  function's own updated doc comment in romaji-input.ts. */
export function isKanaInputActive(config: TypingTestConfig, language: string, textRomajiCapable: boolean | undefined): boolean {
  return isRomajiInputEnabled(config) && isKanaCapable(config, language, textRomajiCapable) && isKanaInputSelected(config)
}

// --- reducer: processKanaKeyEvent ----------------------------------------

/** Kana-mode key semantics, mirroring processRomajiKeyEvent's dispatch
 *  shape (romaji-input.ts) exactly: Space/Backspace are no-ops (a
 *  rejected keystroke never entered the buffer, so Backspace has nothing
 *  to undo, and kana mode never uses Space to submit); Enter only commits
 *  a completed LINE-END word held per `isLineEndEnterRequired`; a
 *  printable char (`key.length === 1`) starts the run from 'waiting' and
 *  is fed to `handleKanaStroke`; anything else (Shift alone, other
 *  multi-char key names) passes through untouched. */
export function processKanaKeyEvent(
  state: TypingTestState, key: string, code: string | undefined, shiftKey: boolean, config: TypingTestConfig, language: string,
): TypingTestState {
  if (isSubmitKey(key)) return state
  if (key === 'Enter') {
    if (state.status !== 'running') return state
    if (state.currentWordIndex >= state.words.length) return state
    const word = state.words[state.currentWordIndex]
    const units = kanaUnitsForWord(word)
    const wordComplete = state.kanaCharIndex >= units.length
    if (wordComplete && state.lineBreaks.has(state.currentWordIndex) && isLineEndEnterRequired(config)) {
      return commitKanaWord(state, config, language)
    }
    return state
  }
  if (key === 'Backspace') return state
  if (key.length === 1 && code !== undefined) {
    const current = state.status === 'waiting' ? { ...state, status: 'running' as const, startTime: Date.now() } : state
    return handleKanaStroke(current, key, code, shiftKey, config, language)
  }
  return state
}

/** Atomic word-advance commit, mirroring commitRomajiWord: pushes the
 *  finished word (always typed verbatim — a rejected stroke never
 *  advances `kanaCharIndex`, so completion always means the exact target
 *  word) into `wordResults`, resets the word-scoped kana fields, advances
 *  `currentWordIndex`, and delegates the run-continuation decision to
 *  `advanceAfterWord`. */
function commitKanaWord(state: TypingTestState, config: TypingTestConfig, language: string): TypingTestState {
  const word = state.words[state.currentWordIndex]
  const base: TypingTestState = {
    ...state,
    wordResults: [...state.wordResults, { word, typed: word, correct: true }],
    currentInput: '',
    kanaCharIndex: 0,
    kanaAwaitingMark: false,
    kanaSegmentErred: false,
    missedPositions: [],
    currentWordIndex: state.currentWordIndex + 1,
  }
  return advanceAfterWord(base, config, language)
}

/** Sequential kana-stroke judging. Correctness is counted per PHYSICAL
 *  STROKE, same as romaji mode counts per keystroke (see
 *  handleRomajiChar's own doc comment: "one accepted keystroke confirms
 *  exactly one character in this mode") — a 濁音 かな's two strokes each
 *  confirm one correctChars/confirmedChars increment, matching how a
 *  multi-keystroke romaji spelling (e.g. "kyo") also confirms one char
 *  per keystroke rather than one per completed かな. A rejected stroke
 *  marks `kanaSegmentErred` (mirroring `romajiSegmentErred`) without
 *  touching `mistakes` directly; once the かな segment actually completes,
 *  the flag decides whether to tally one mistake keyed by the target かな
 *  character, then resets for the next segment — same shape as romaji's
 *  own mistake bookkeeping. */
function handleKanaStroke(state: TypingTestState, key: string, code: string, shift: boolean, config: TypingTestConfig, language: string): TypingTestState {
  if (state.currentWordIndex >= state.words.length) return state
  const word = state.words[state.currentWordIndex]
  const units = kanaUnitsForWord(word)
  const unit = units[state.kanaCharIndex]
  if (!unit) return state

  const result = tryAcceptStroke(unit, state.kanaAwaitingMark, code, shift, key)

  if (result.status === 'reject') {
    return { ...state, incorrectChars: state.incorrectChars + 1, kanaSegmentErred: true }
  }

  const correctChars = state.correctChars + 1
  const confirmedChars = state.confirmedChars + 1

  if (result.status === 'accept') {
    // First of a 2-stroke (濁音/半濁音) unit landed; the mark is pending.
    return { ...state, correctChars, confirmedChars, kanaAwaitingMark: true }
  }

  // 'complete': this stroke finished the current かな character.
  let mistakes = state.mistakes
  let kanaSegmentErred = state.kanaSegmentErred
  if (kanaSegmentErred) {
    mistakes = { ...mistakes, [unit.char]: (mistakes[unit.char] ?? 0) + 1 }
    kanaSegmentErred = false
  }

  const nextCharIndex = state.kanaCharIndex + 1
  const held: TypingTestState = {
    ...state,
    correctChars,
    confirmedChars,
    mistakes,
    kanaSegmentErred,
    kanaCharIndex: nextCharIndex,
    kanaAwaitingMark: false,
  }

  if (nextCharIndex >= units.length) {
    if (state.lineBreaks.has(state.currentWordIndex) && isLineEndEnterRequired(config)) return held
    return commitKanaWord(held, config, language)
  }
  return held
}

// --- guide -----------------------------------------------------------------

/** Display-only kana stroke guide for the current word plus a full-run
 *  per-word table — mirrors RomajiGuide's shape/naming (types.ts) closely
 *  enough that TypingTestView's guide row can reuse the same
 *  showRow/lineCount/words conventions, without sharing the exact
 *  romaji-only `typed`/`remaining` string fields (kana's guide is a list
 *  of KanaUnit, not a spelling string — see the module doc comment on why
 *  kana needs no keystroke-history replay). */
export interface KanaGuide {
  remaining: KanaUnit[]
  kanaCompleted: number
  words: KanaUnit[][]
  lineCount: number
  showRow: boolean
}

/** Full-run per-word kana unit table (kana mode only), unbounded and
 *  index-aligned with `state.words` — see buildRomajiWordsTable's own doc
 *  comment for why this is split out from the guide progress below (only
 *  rebuilds when `state.words` itself changes, not on every keystroke). */
export function buildKanaWordsTable(config: TypingTestConfig, language: string, state: TypingTestState): KanaUnit[][] | null {
  if (!isKanaInputActive(config, language, state.romajiCapable)) return null
  return state.words.map((w) => kanaUnitsForWord(w))
}

/** Current word's kana guide progress (kana mode only) — see
 *  buildRomajiGuideProgress's own doc comment for the `lineCount`/
 *  `showRow` contract this mirrors (same RomajiDetailSettings.guideLineCount
 *  field, shared between both input methods). Takes the already-built
 *  `wordsTable` (see `buildKanaWordsTable`) rather than re-deriving the
 *  current word's units itself — unlike romaji's guide progress (which
 *  must replay the accepted keystroke history against the word, a value
 *  the words table's own empty-keystroke entries don't carry), a kana
 *  word's units are a pure function of the word text alone, so the table
 *  already holds the exact same array this would otherwise recompute. */
export function buildKanaGuideProgress(
  config: TypingTestConfig, language: string, state: TypingTestState, wordsTable: readonly KanaUnit[][] | null,
): Omit<KanaGuide, 'words'> | null {
  if (!isKanaInputActive(config, language, state.romajiCapable)) return null
  const units = wordsTable?.[state.currentWordIndex]
  if (!units) return null
  const lineCount = romajiDetail(config)?.guideLineCount ?? 1
  return {
    remaining: units.slice(state.kanaCharIndex),
    kanaCompleted: state.kanaCharIndex,
    lineCount,
    showRow: lineCount > 0,
  }
}

// --- run-log / expected-char support ---------------------------------------

/** The next kana-mode "expected char" — the SYMBOL the pending physical
 *  stroke would produce (the base かな for a 濁音/半濁音 unit's first
 *  stroke, the ゛/゜ mark itself for its second) rather than the eventual
 *  target かな, matching romaji mode's own per-KEYSTROKE (not per-かな)
 *  expectedChar convention (romajiNextExpectedChar) — used by
 *  expected-char.ts's deriveExpectedChar. Returns the raw target char for
 *  an unresolved unit (verbatim fallback — see KanaUnit's own doc
 *  comment), and undefined once the word itself is exhausted. */
export function kanaNextExpectedChar(word: string, kanaCharIndex: number, kanaAwaitingMark: boolean): string | undefined {
  const unit = kanaUnitsForWord(word)[kanaCharIndex]
  if (!unit) return undefined
  if (unit.strokes === null) return unit.char
  const stroke = unit.strokes[kanaAwaitingMark ? 1 : 0]
  if (!stroke) return unit.char
  const variant = KANA_LAYOUT[stroke.code]
  if (!variant) return undefined
  return stroke.shift ? (variant[1] ?? variant[0]) : variant[0]
}

/** The mistake-map key for a REJECTED stroke at the current かな position
 *  — always the target かな CHARACTER itself (unlike romaji's canonical
 *  spelling string), since kana mode's mistake table is naturally keyed
 *  by かな, same as verbatim mode keys by target char. Used by
 *  expected-char.ts's deriveMistakeKey. */
export function currentKanaMistakeKey(word: string, kanaCharIndex: number): string | undefined {
  return kanaUnitsForWord(word)[kanaCharIndex]?.char
}

/** Authoritative correctness verdict for one physical keystroke against
 *  the CURRENT kana position — the exact same judgment `handleKanaStroke`
 *  makes, re-derived here (pure, side-effect-free, safe to call twice)
 *  for run-log-recorder.ts's `applyCharVerdict` to use INSTEAD of its
 *  default `key === expectedChar` string comparison. That default
 *  comparison is correct for romaji mode (whose `key`/expectedChar are
 *  both plain ASCII romaji letters) but structurally wrong for kana mode:
 *  `key` there is whatever ASCII/symbol character the OS keyboard layout
 *  happens to report for that physical position (kana mode reads `code`+
 *  `shiftKey`, never `key`, for judging — see the module doc comment), so
 *  it essentially never equals the かな glyph `kanaNextExpectedChar`
 *  reports for display. Used by expected-char.ts's
 *  deriveKanaCorrectOverride, which additionally gates this on
 *  isKanaInputActive so every other mode's run-log verdict is completely
 *  unaffected (see that function and RunLogRecordContext's own doc
 *  comments). Returns undefined (defer to the default comparison) when
 *  `code` is missing or there is no current word/unit to judge against —
 *  the same defensive shape `deriveExpectedChar` uses. */
export function kanaStrokeCorrect(state: TypingTestState, key: string, code: string | undefined, shift: boolean): boolean | undefined {
  if (code === undefined) return undefined
  const word = state.words[state.currentWordIndex]
  if (word === undefined) return undefined
  const unit = kanaUnitsForWord(word)[state.kanaCharIndex]
  if (!unit) return undefined
  return tryAcceptStroke(unit, state.kanaAwaitingMark, code, shift, key).status !== 'reject'
}
