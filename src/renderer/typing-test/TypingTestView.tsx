// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestState } from './useTypingTest'
import type { RomajiGuide, TypingTestConfig } from './types'
import type { KanaGuide } from './kana-input'
import type { ComparisonStats } from './comparison'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from './types'
import { romajiDetail } from './romaji-input'
import { WordDisplay } from './WordDisplay'
import { TypingTestControlsRow } from './TypingTestControlsRow'
import { TypingTestStatsRow } from './TypingTestStatsRow'
import { TypingTestGuideRows } from './TypingTestGuideRows'
import { KeystrokeTimelinePanel } from './KeystrokeTimelinePanel'
import { useVisualLines } from './useVisualLines'
import { useLogicalWindowHeight } from './useLogicalWindowHeight'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { TypingTestResult } from '../../shared/types/pipette-settings'


/** A tagged snapshot of this view's own realized line rows (`lines` below
 *  — real or synthetic, same `number[][]` shape either way), written by
 *  a `useLayoutEffect` (never during render) into a caller-owned ref.
 *  `use-typing-test-result-save.ts` reads it at finish time to derive
 *  `RunKeystrokeLog.lineBreaks` for monkeytype modes (words/time/quote),
 *  which have no real `state.lineBreaks` of their own — see that file's
 *  own doc comment for the runId/wordCount match it requires before
 *  trusting a stale snapshot. `runId`/`wordCount` are the tag: a
 *  consumer must check both against its own current state before using
 *  `lines`, since this ref can otherwise still hold the PREVIOUS run's
 *  last-measured value for one render (the effect that clears it runs
 *  after the consumer's own effect in the same commit is not guaranteed
 *  to have fired first). `lines: null` means unmeasured (jsdom, or
 *  before the first paint) — distinct from an absent snapshot
 *  altogether (`lineSnapshotRef.current === null`, i.e. the effect has
 *  never run at all). */
export interface LineSnapshot {
  runId: string
  wordCount: number
  lines: number[][] | null
}

interface Props {
  state: TypingTestState
  wpm: number
  /** Keystrokes per minute — shown instead of WPM in fileImport mode. */
  kpm?: number
  accuracy: number
  /** Keystrokes per confirmed character (see `useTypingTest`'s `kspc`).
   *  `null`/`undefined` shows '-', same as before measuring starts. */
  kspc?: number | null
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  paused: boolean
  /** Hide the stats / results (WPM) row. Persisted per keyboard. */
  hideStatsRow?: boolean
  /** Baseline metrics for the Measurement-row comparison delta, or null when
   *  comparison is off / no matching history. */
  comparison?: ComparisonStats | null
  onCompositionStart?: () => void
  onCompositionUpdate?: (data: string) => void
  onCompositionEnd?: (data: string) => void
  /** Current word's romaji-keystroke progress (romajiInput mode only), or
   *  null otherwise. Drives both the current word's kana coloring
   *  (forwarded to `WordDisplay`) and the typed/remaining romaji guide line
   *  shown below the reading window. */
  romajiGuide?: RomajiGuide | null
  /** Current word's kana-mode stroke progress (kana mode only — see
   *  kana-input.ts), or null otherwise. Mutually exclusive with
   *  `romajiGuide` by construction (isKanaInputActive/isRomajiInputActive
   *  can never both be true) — drives the same current-word kana coloring
   *  (forwarded to `WordDisplay`) plus the kana stroke guide row shown
   *  below the reading window. */
  kanaGuide?: KanaGuide | null
  /** Called when Space is input via IME (keydown swallowed by the IME layer). */
  onImeSpaceKey?: () => void
  /** Imported-text display: visible line count + font size (px). Ignored
   *  outside fileImport mode. */
  displayLines?: number
  fontSize?: number
  /** Name the just-finished result inline from the completion screen
   *  (imported fileImport text only). Keyed to the most recent saved result. */
  onNameResult?: (name: string) => void
  /** Quick-insert chips for the result-name modal (material label, timestamp,
   *  WPM / KPM / Accuracy of the just-finished result). */
  resultNameChips?: string[]
  /** Start a fresh run (Next Test / Restart — both restart the test). */
  onStart?: () => void
  /** Memory mode (imported fileImport text): pause the running run. */
  onPause?: () => void
  /** Memory mode: open the resume dialog for a paused / saved run. */
  onResume?: () => void
  /** A paused fileImport run is saved and can be resumed. */
  hasSavedMemory?: boolean
  /** Error-class raw counts (see `TypingTestResult.errorSubstitutions` et
   *  al.) from the just-finished result, or `null` when the result has
   *  none (romaji run, no finalized words, or a legacy pre-error-class
   *  result) — the completion screen's error-mix line is omitted
   *  entirely rather than showing a '-' placeholder, since (unlike WPM /
   *  KSPC) "the metric doesn't apply to this run" is common, not an
   *  in-progress state. */
  errorClasses?: { substitutions: number; omissions: number; insertions: number } | null
  /** Host-owned ref this view snapshots its own realized `lines` into —
   *  see `LineSnapshot`'s own doc comment. Optional so every existing
   *  mount (tests included) stays valid without threading it. */
  lineSnapshotRef?: RefObject<LineSnapshot | null>
  /** The just-finished run's in-memory raw keystroke log (Plan-completion-
   *  timeline-view PR-B) — null when recording consent was off, view-only,
   *  or nothing was saveable. Rendered as the shared `KeystrokeTimelinePanel`
   *  in place of the old stats row ONLY while `status === 'finished'` AND
   *  `runId` matches the current run's own (see the codex-review note in
   *  Plan-completion-timeline-view.md): a fresh run's finish effect can
   *  otherwise briefly still be carrying the PREVIOUS run's log for one
   *  render, which this guard exists to catch. */
  lastFinishedLog?: RunKeystrokeLog | null
  /** The just-finished result, reused as the panel's own `result` prop so
   *  the completion screen's unified stat block reads exactly like
   *  History's timeline modal for the same run (see
   *  `KeystrokeTimelinePanel`'s own doc comment on that prop). */
  finishedResult?: TypingTestResult | null
}

/** Group flat word indices into logical lines using the line-break set
 *  (imported fileImport text). Each entry is the global word indices of one
 *  line, in order. */
function groupIntoLines(words: string[], lineBreaks: Set<number>): number[][] {
  const lines: number[][] = []
  let current: number[] = []
  for (let i = 0; i < words.length; i++) {
    current.push(i)
    if (lineBreaks.has(i)) {
      lines.push(current)
      current = []
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/** Which row (real line, per `groupIntoLines`, or synthetic, per
 *  `useVisualLines`) a word index sits on — both shapes are the same
 *  `number[][]` of word indices, so one lookup serves both. Falls back to
 *  the last row for an out-of-range index (e.g. `currentWordIndex ===
 *  words.length` once a run finishes). */
function rowIndexForWord(lines: number[][], wordIndex: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(wordIndex)) return i
  }
  return Math.max(0, lines.length - 1)
}

export function TypingTestView({
  state,
  wpm,
  kpm = 0,
  accuracy,
  kspc = null,
  elapsedSeconds,
  remainingSeconds,
  config,
  paused,
  hideStatsRow,
  comparison,
  onCompositionStart,
  onCompositionUpdate,
  onCompositionEnd,
  romajiGuide = null,
  kanaGuide = null,
  onImeSpaceKey,
  displayLines = DEFAULT_DISPLAY_LINES,
  fontSize = DEFAULT_FONT_SIZE,
  onNameResult,
  resultNameChips = [],
  onStart,
  onPause,
  onResume,
  hasSavedMemory,
  errorClasses = null,
  lineSnapshotRef,
  lastFinishedLog = null,
  finishedResult = null,
}: Props) {
  const { t } = useTranslation()
  // Completion screen (Plan-completion-timeline-view PR-B): once a run
  // finishes, the reading window/romaji guide give way to the inline
  // keystroke timeline — see the JSX below for where each is gated.
  // `timelineLog` additionally requires the log's own `runId` to match
  // the CURRENT run (see `lastFinishedLog`'s own doc comment on the
  // stale-flash guard this exists to prevent); `isFinished` alone gates
  // the reading window regardless of whether a log ends up available.
  const isFinished = state.status === 'finished'
  const timelineLog = isFinished && lastFinishedLog && lastFinishedLog.runId === state.runId ? lastFinishedLog : null
  const wordsRef = useRef<HTMLDivElement>(null)
  const imeInputRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  // Guard: prevent duplicate space submission when both keydown and input fire
  const lastSpaceTimeRef = useRef(0)
  // Romaji mode is direct-keystroke only, so an active OS IME composition
  // means input silently isn't landing — surfaced as a one-line hint once
  // detected. Sticky for the run (not per-keystroke) so it doesn't flicker;
  // cleared on the next run via the runId-keyed effect below.
  const [imeDetected, setImeDetected] = useState(false)
  useEffect(() => {
    setImeDetected(false)
  }, [state.runId])

  // Sources with real line breaks (tatoeba/fileImport) render as explicit
  // line rows, unchanged from before. `null` = no real lines.
  const realLines = useMemo(
    () => (state.lineBreaks.size > 0 ? groupIntoLines(state.words, state.lineBreaks) : null),
    [state.words, state.lineBreaks],
  )
  // The ⏎ glyph is only truthful while Enter is actually required at a real
  // line end. Romaji/kana input mode's "Enter at line ends" toggle (default
  // on, shared between both engines — see isLineEndEnterRequired in
  // romaji-input.ts) can turn that requirement off — a line-end word then
  // auto-advances on completion like any other word, so showing ⏎ would be
  // a lie. `romajiGuide != null` / `kanaGuide != null` are the established
  // 1:1 stand-ins for "romaji/kana input is active" (both guide selectors
  // return null exactly when their own isRomajiInputActive/isKanaInputActive
  // is false); when NEITHER is active the config's `romaji` field is
  // irrelevant and the glyph renders as before.
  const showLineEndGlyph = realLines !== null && ((romajiGuide == null && kanaGuide == null) || romajiDetail(config)?.lineEndEnter !== false)
  // Monkeytype modes (words/time/quote — lineBreaks empty) render synthetic
  // line rows too, derived from a hidden-mirror measurement (see
  // useVisualLines) instead of the flat CSS word-flow, so the reading
  // window addresses N lines the same way real line rows do. Falls back to
  // flat when unmeasured (jsdom, or before the first paint).
  const monkeytypeActive = realLines === null
  const { lines: visualLines, mirrorRef } = useVisualLines(wordsRef, state.words, fontSize, monkeytypeActive)
  const lines = realLines ?? visualLines
  // Snapshot this view's own realized `lines` into the host-owned ref —
  // see `LineSnapshot`'s doc comment. A pure ref write (never setState),
  // and deliberately in a layout effect (not during render, not a plain
  // effect): render must stay a pure function of props/state, and a
  // layout effect (vs. a passive one) guarantees the snapshot is current
  // before the browser paints, matching the other layout effects in this
  // component that also read post-render measurements.
  useLayoutEffect(() => {
    if (!lineSnapshotRef) return
    lineSnapshotRef.current = { runId: state.runId, wordCount: state.words.length, lines }
  }, [lineSnapshotRef, lines, state.runId, state.words.length])
  // Romaji guide line-sync: which line rows to preview in the guide row
  // below the reading window, anchored to whichever row the current word
  // sits on (real or synthetic — same `lines` shape either way). `null`
  // when `lines` itself is unmeasured/flat (jsdom, or before first paint) —
  // the guide row falls back to its own single-flow rendering in that case
  // (see the guide row JSX below), same as the reading window does above.
  const guideLines = lines && romajiGuide ? lines.slice(
    rowIndexForWord(lines, state.currentWordIndex),
    rowIndexForWord(lines, state.currentWordIndex) + romajiGuide.lineCount,
  ) : null
  // The mirror's own content (expected word text only) never changes per
  // keystroke — only `currentInput`/`currentWordIndex` do, which re-render
  // the whole component. Memoizing the child span array on `state.words`
  // keeps those elements referentially stable across keystrokes, so React
  // bails out of reconciling the mirror's subtree entirely on every
  // keystroke instead of re-diffing every word span for no reason.
  const mirrorChildren = useMemo(
    () =>
      state.words.map((word, wordIdx) => (
        <span key={wordIdx} data-mirror-word={wordIdx} className="min-w-0 break-all">
          {word}
        </span>
      )),
    [state.words],
  )
  // Reading window: font size + line count drive the CSS min-height calc in
  // .typing-multiline-window (the fallback for unmeasured content — see
  // useLogicalWindowHeight). displayLines is meant to count LOGICAL lines
  // (one wrapped sentence = one line), not visual rows, so once line rows
  // (real or synthetic) are measured, an inline height overrides that
  // min-height to fit exactly `displayLines` of them.
  const minWindowHeight = fontSize * displayLines * 1.5
  const windowHeight = useLogicalWindowHeight(wordsRef, lines, displayLines, minWindowHeight)
  // Applied to every mode (normal word-flow and imported fileImport text
  // share the same Font/Line settings). Memoized so the style object is stable.
  const multilineStyle = useMemo(
    () => ({ '--tt-font': fontSize, '--tt-lines': displayLines, height: `${windowHeight}px` } as CSSProperties),
    [fontSize, displayLines, windowHeight],
  )
  // Romaji guide row: font size only — it must NOT inherit the reading
  // window's `height` (multilineStyle above tracks `displayLines`, which is
  // unrelated to the guide's own `lineCount`; carrying it over here would
  // stretch/clip the guide row to the reading window's height instead of
  // sizing to its own content).
  const romajiGuideStyle = useMemo(() => ({ '--tt-font': fontSize } as CSSProperties), [fontSize])
  function clearImeInput(): void {
    if (imeInputRef.current) imeInputRef.current.value = ''
  }

  // Focus the hidden IME textarea when waiting or running, and restore on window refocus
  const focusImeInput = useCallback(() => {
    if (state.status === 'waiting' || state.status === 'running') {
      imeInputRef.current?.focus()
    }
  }, [state.status])

  useEffect(() => {
    focusImeInput()
    window.addEventListener('focus', focusImeInput)
    document.addEventListener('visibilitychange', focusImeInput)
    return () => {
      window.removeEventListener('focus', focusImeInput)
      document.removeEventListener('visibilitychange', focusImeInput)
    }
  }, [focusImeInput])

  useLayoutEffect(() => {
    if (wordsRef.current) {
      wordsRef.current.scrollTop = 0
    }
  }, [state.words])

  useLayoutEffect(() => {
    const container = wordsRef.current
    if (!container) return

    // Real (tatoeba/fileImport) or synthetic (monkeytype, see useVisualLines)
    // line rows: align to the row elements (never clipped). Prefer the
    // previous line at the top for context — but if a wrapped line (one
    // logical line spanning several visual rows) would push the current
    // line out of view, snap the current line to the top so what's being
    // typed is always visible (e.g. Lines=2 with wrapping).
    if (lines) {
      const currentLine = rowIndexForWord(lines, state.currentWordIndex)
      const rows = container.querySelectorAll<HTMLElement>('[data-line-row]')
      const currentRow = rows[currentLine]
      if (!currentRow) {
        container.scrollTop = 0
        return
      }
      const containerRect = container.getBoundingClientRect()
      const prevRow = currentLine > 0 ? rows[currentLine - 1] : null
      container.scrollTop += (prevRow ?? currentRow).getBoundingClientRect().top - containerRect.top
      if (currentRow.getBoundingClientRect().bottom > containerRect.bottom) {
        container.scrollTop += currentRow.getBoundingClientRect().top - containerRect.top
      }
      return
    }

    const activeWord = container.querySelector<HTMLElement>(
      `[data-testid="word-${state.currentWordIndex}"]`,
    )
    if (!activeWord) return

    // Lines are spaced by line-height only (no extra row gap), so the window
    // height (font × 1.5 × lines) matches the content exactly — one word's
    // box height is one visible line.
    const lineHeight = activeWord.offsetHeight
    const relativeTop =
      activeWord.getBoundingClientRect().top - container.getBoundingClientRect().top
    const visibleLine = Math.floor(relativeTop / lineHeight)

    if (visibleLine >= 2) {
      container.scrollTop += (visibleLine - 1) * lineHeight
    }
    // Font/line changes resize the window, so re-snap the scroll position.
    // windowHeight also resizes it (see useLogicalWindowHeight) — its own
    // measurement runs in an earlier layout effect and may update state
    // synchronously before paint, so this effect must re-run against the
    // container's post-measurement height rather than a stale one.
  }, [state.currentWordIndex, lines, fontSize, displayLines, windowHeight])

  // Shared by the line-row and flat layouts so the word props stay in one place.
  const renderWord = (wordIdx: number) => (
    <WordDisplay
      key={wordIdx}
      word={state.words[wordIdx]}
      wordIndex={wordIdx}
      currentWordIndex={state.currentWordIndex}
      currentInput={state.currentInput}
      wordResults={state.wordResults}
      cursorBlink={state.status === 'waiting'}
      compositionText={wordIdx === state.currentWordIndex ? state.compositionText : ''}
      guideProgress={wordIdx === state.currentWordIndex ? (romajiGuide ?? kanaGuide) : null}
    />
  )

  return (
    // `min-h-0 flex-1` only once finished — see the "Completion screen"
    // comment further down for why (the flex-height chain that lets the
    // timeline panel's rows scroll internally instead of growing the
    // whole pane). The running/waiting/paused states keep their original
    // natural-content-height flow; they were never reported as
    // overflowing and don't need this.
    <div data-testid="typing-test-view" className={`flex w-full min-w-0 flex-col items-center gap-4 px-4 py-4${isFinished ? ' min-h-0 flex-1' : ''}`}>
      {/* Word display — fixed window with scroll. Word-flow modes show a
          3-line window; imported fileImport text shows 4 lines (line-row
          layout). Hidden once the run finishes (Plan-completion-timeline-view
          PR-B) — the completion screen's main content is the keystroke
          timeline (or, without a log, the stats row below), not the
          already-typed reading window. */}
      {!isFinished && (
      <div
        data-testid="typing-test-words"
        className="relative w-full max-w-4xl font-mono leading-normal typing-multiline-window"
        style={multilineStyle}
        onClick={() => imeInputRef.current?.focus()}
      >
        {/* Hidden textarea for IME composition input */}
        <textarea
          ref={imeInputRef}
          className="absolute opacity-0 w-px h-px overflow-hidden"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          tabIndex={-1}
          aria-label="IME input"
          onCompositionStart={() => {
            isComposingRef.current = true
            // An IME composition starting during romaji/kana mode means the
            // OS IME is on — direct keystrokes won't reach processKeyEvent
            // (see isRomajiInputActive/isKanaInputActive's composition-
            // blocking in useTypingTest). Surface the hint once detected.
            if (romajiGuide || kanaGuide) setImeDetected(true)
            onCompositionStart?.()
          }}
          onCompositionUpdate={(e) => onCompositionUpdate?.(e.data)}
          onCompositionEnd={(e) => {
            isComposingRef.current = false
            onCompositionEnd?.(e.data)
            clearImeInput()
          }}
          onInput={() => {
            // Only clear when not composing — clearing during IME resets the composition
            if (!isComposingRef.current) {
              // Japanese IME swallows Space keydown entirely; detect it here via textarea input.
              // Guard: if the capture-phase keydown already handled Space (via preventDefault),
              // no input event fires. But some IMEs may fire both — skip if too recent.
              const val = imeInputRef.current?.value ?? ''
              if (val === ' ' || val === '\u3000') {
                const now = Date.now()
                if (now - lastSpaceTimeRef.current > 50) {
                  lastSpaceTimeRef.current = now
                  onImeSpaceKey?.()
                }
              }
              clearImeInput()
            }
          }}
        />
        {state.status === 'countdown' && (
          <div className="flex h-full items-center justify-center">
            <p data-testid="typing-test-countdown" className="animate-pulse text-content-muted">
              {t('editor.typingTest.loading')}
            </p>
          </div>
        )}
        {state.status !== 'countdown' && state.words.length > 0 && (
          <>
            <div ref={wordsRef} className="h-full overflow-hidden">
              {lines ? (
                // Real (fileImport/tatoeba) or synthetic (monkeytype, measured
                // via useVisualLines) line rows. ⏎ marks a real line end
                // (Enter, not Space, advances there) — gated on
                // `showLineEndGlyph` (real lines AND Enter actually required
                // there — see that const's own doc comment) rather than
                // lineWordIdxs' last-word membership in state.lineBreaks, so
                // it can never fire for the synthetic monkeytype rows even
                // in the (real-lines-only) edge case where the very last
                // word happens to be a recorded break. line-indent-* is
                // fileImport-only for the same "no real lines" reason:
                // state.lineIndents stays empty elsewhere.
                lines.map((lineWordIdxs, lineIdx) => (
                  <div key={lineIdx} data-line-row={lineIdx} className="flex flex-wrap gap-x-3">
                    {state.lineIndents[lineIdx] && (
                      // Code indentation, display only — not typed (Space submits
                      // a word, so leading spaces can't be keyed).
                      <span data-testid={`line-indent-${lineIdx}`} className="-mr-3 select-none whitespace-pre text-content-muted/40" aria-hidden="true">{state.lineIndents[lineIdx]}</span>
                    )}
                    {lineWordIdxs.map(renderWord)}
                    {showLineEndGlyph && lineIdx < lines.length - 1 && (
                      <span className="select-none text-content-muted/40" aria-hidden="true">⏎</span>
                    )}
                  </div>
                ))
              ) : (
                <div className="flex flex-wrap gap-x-3">
                  {state.words.map((_, wordIdx) => renderWord(wordIdx))}
                </div>
              )}
            </div>
            {monkeytypeActive && (
              // Invisible measurement mirror (see useVisualLines) — same
              // width/font/flex-wrap/gap as the real words row above, one
              // plain span per word's expected text. Never shown; read only
              // for each span's measured offsetTop, then discarded once
              // `lines` is derived from it.
              <div
                ref={mirrorRef}
                aria-hidden="true"
                className="invisible pointer-events-none absolute inset-x-0 top-0 flex flex-wrap gap-x-3"
              >
                {mirrorChildren}
              </div>
            )}
          </>
        )}
        {paused && state.status === 'running' && (
          <div
            data-testid="typing-test-paused"
            className="absolute inset-0 flex items-center justify-center rounded-lg bg-surface/80"
          >
            <p className="text-base text-content-muted">{t('editor.typingTest.paused')}</p>
          </div>
        )}
      </div>
      )}

      {/* Romaji/kana keystroke-judging guide rows — see
          TypingTestGuideRows's own module doc comment for the full
          rendering contract (line-sync, IME hint, mutual exclusivity).
          Hidden once finished, alongside the reading window above (see
          its own comment). */}
      <TypingTestGuideRows
        isFinished={isFinished} romajiGuide={romajiGuide} kanaGuide={kanaGuide} imeDetected={imeDetected}
        guideLines={guideLines} currentWordIndex={state.currentWordIndex} style={romajiGuideStyle}
      />

      {/* Non-finished controls row (not started: Next Test / Resume; in
          progress: Pause or Resume / Restart) no longer renders here — it
          moved to TypingTestPane, BELOW the keyboard pane and its layer
          note, so the reading window sits directly above the keyboard the
          user actually types on. TypingTestPane owns the `!hideControls`
          gate for that row now (the "operation" toggle). The finished-state
          row (result name + Next Test) stays here — it renders instead at
          the BOTTOM of the completion screen, below the timeline panel (or
          the fallback stats row) — see the render below — since the
          keyboard itself is hidden once finished, so there's no "below the
          keyboard" position for it to move to. */}

      {/* Completion screen (Plan-completion-timeline-view PR-B): once a run
          finishes WITH a matching in-memory log, the shared
          KeystrokeTimelinePanel — same unified stat block, legend, zoom,
          and rows as History's timeline modal — replaces the old compact
          stats row entirely (it already contains the Missed/error-mix
          lines the old row also showed, so both would otherwise
          duplicate). Rendered above the finished-state controls row below
          (moved to the bottom of the completion screen so the
          timeline/stats content reads first).

          FLEX-HEIGHT CHAIN (codex safety review of an earlier, fixed-vh
          `rowsMaxHeightClass` cap — replaced because a fixed vh figure
          can't adapt to how much OTHER chrome a given run actually has:
          Lines=1 leaves less sidebar height claimed, an IME-composition
          warning or the Missed-chars line adds MORE panel-internal
          content, and the editor's own content pane doesn't reserve a
          fixed fraction of the window either — any single vh number is
          right for some combination of these and wrong for others). This
          wrapper (`isFinished`-only) is the top of a chain that makes the
          rows area the ONLY thing that scrolls, by making every link
          between it and the nearest real bounded ancestor stretch instead
          of taking its natural content height:
            KeymapEditor.tsx's own `overflow-auto` content-pane row (the
            true bound — pre-existing, unrelated to typing-test) → its
            `keymap-surface` child (pre-existing `min-h-0 flex-1`) →
            TypingTestPane.tsx's outer `items-stretch` row (pre-existing
            `min-h-0 flex-1`) → TypingTestPane.tsx's `items-center` column
            (now ALSO `min-h-0`, alongside its pre-existing `flex-1`) →
            this component's own root (`min-h-0 flex-1`, but ONLY once
            `isFinished` — see its own className comment above) → THIS
            wrapper (`min-h-0 flex-1 flex-col`) → the timeline panel
            (`min-h-0 flex-1`) → KeystrokeTimelinePanel's OWN root (already
            `flex min-h-0 flex-1 flex-col gap-3` — unchanged) → its stat
            grid / Missed-chars / legend / zoom (unchanged, naturally
            sized — `shrink-0` by simply never being given `flex-1`) → the
            rows scrollport (already `flex-1 min-h-0 overflow-auto` —
            unchanged, this is the only element that actually scrolls).
          The controls row below stays naturally sized (no flex-1) — it's
          the last child of a `flex-col` wrapper, so it just takes
          whatever height its own content needs and never grows, i.e. it
          is `shrink-0` in effect without needing the class name (a flex
          item's default `flex-shrink: 1` only matters when its siblings'
          combined natural height already exceeds the wrapper — since the
          rows area is the one absorbing the slack via its own `flex-1`,
          the controls row is never asked to shrink below its content). */}
      {isFinished ? (
        <div data-testid="typing-test-finished-wrapper" className="flex min-h-0 w-full flex-1 flex-col items-center gap-4">
          {timelineLog ? (
            <div className="flex min-h-0 w-full flex-1 flex-col" data-testid="typing-test-timeline-panel">
              <KeystrokeTimelinePanel log={timelineLog} result={finishedResult ?? undefined} />
            </div>
          ) : (
            <>
              <TypingTestStatsRow
                state={state}
                wpm={wpm}
                kpm={kpm}
                accuracy={accuracy}
                kspc={kspc}
                elapsedSeconds={elapsedSeconds}
                remainingSeconds={remainingSeconds}
                config={config}
                comparison={comparison}
                errorClasses={errorClasses}
              />
              {/* No log to show a timeline for (recording consent was off,
                  view-only, or nothing saveable) — hint that enabling it
                  would surface this same panel next time. Omitted for a
                  stale-runId log (present but not yet matching this run)
                  since that's a transient rendering edge, not "no
                  consent". */}
              {!lastFinishedLog && (
                <p data-testid="typing-test-timeline-consent-hint" className="text-xs text-content-muted">
                  {t('editor.typingTest.results.timelineConsentHint')}
                </p>
              )}
            </>
          )}
          {/* Finished-state controls row (result name + Next Test) —
              deliberately LAST, below the timeline panel (or the fallback
              stats row + consent hint above), not above it — the
              timeline/stats content is what the user reads first once a
              run finishes; naming the result and starting the next one is
              the closing action. */}
          <TypingTestControlsRow
            state={state}
            config={config}
            onNameResult={onNameResult}
            resultNameChips={resultNameChips}
            onStart={onStart}
            onPause={onPause}
            onResume={onResume}
            hasSavedMemory={hasSavedMemory}
          />
        </div>
      ) : (
        // Measurement / results row — below the reading window, mid-run.
        // Live metrics while running; before measuring (waiting /
        // countdown) every value reads "-". The "operation"/"measurement"
        // toggle (`hideStatsRow`) hides this row entirely while running —
        // once finished, the branch above always shows a results summary
        // regardless of that toggle, so there is nothing to gate here.
        !hideStatsRow && (
          <TypingTestStatsRow
            state={state}
            wpm={wpm}
            kpm={kpm}
            accuracy={accuracy}
            kspc={kspc}
            elapsedSeconds={elapsedSeconds}
            remainingSeconds={remainingSeconds}
            config={config}
            comparison={comparison}
            errorClasses={errorClasses}
          />
        )
      )}
    </div>
  )
}

