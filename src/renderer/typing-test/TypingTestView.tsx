// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestState } from './useTypingTest'
import type { RomajiGuide, TypingTestConfig } from './types'
import type { ComparisonStats } from './comparison'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from './types'
import { WordDisplay } from './WordDisplay'
import { TypingTestControlsRow } from './TypingTestControlsRow'
import { TypingTestStatsRow } from './TypingTestStatsRow'
import { useVisualLines } from './useVisualLines'
import { useLogicalWindowHeight } from './useLogicalWindowHeight'


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
  /** Hide the operation (Next Test button) controls row. Persisted per
   *  keyboard. Force-shown once a test finishes. */
  hideControls?: boolean
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
  hideControls,
  comparison,
  onCompositionStart,
  onCompositionUpdate,
  onCompositionEnd,
  romajiGuide = null,
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
}: Props) {
  const { t } = useTranslation()
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
  // Monkeytype modes (words/time/quote — lineBreaks empty) render synthetic
  // line rows too, derived from a hidden-mirror measurement (see
  // useVisualLines) instead of the flat CSS word-flow, so the reading
  // window addresses N lines the same way real line rows do. Falls back to
  // flat when unmeasured (jsdom, or before the first paint).
  const monkeytypeActive = realLines === null
  const { lines: visualLines, mirrorRef } = useVisualLines(wordsRef, state.words, fontSize, monkeytypeActive)
  const lines = realLines ?? visualLines
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
      romajiGuide={wordIdx === state.currentWordIndex ? romajiGuide : null}
    />
  )

  // One word's worth of the line-synchronized romaji guide row — 4-tier
  // coloring by position relative to the current word: done (dimmed
  // success tone), current (typed/remaining split, same as before), and
  // upcoming (dimmed muted tone, same `typing-test-romaji-lookahead` testid
  // the flat fallback below also uses, so both paths satisfy the same
  // selector contract). `isFirst` suppresses the inter-word leading space
  // for the first word on a line — words after it get one, same convention
  // the old lookahead rendering used.
  const renderGuideWord = (guide: RomajiGuide, wordIdx: number, isFirst: boolean) => {
    const prefix = isFirst ? '' : ' '
    if (wordIdx === state.currentWordIndex) {
      return (
        <span key={wordIdx}>
          <span className="text-success">{prefix + guide.typed}</span>
          <span className="text-content-muted">{guide.remaining}</span>
        </span>
      )
    }
    const word = guide.words[wordIdx] ?? ''
    if (wordIdx < state.currentWordIndex) {
      return <span key={wordIdx} className="text-success/60">{prefix + word}</span>
    }
    return (
      <span key={wordIdx} data-testid="typing-test-romaji-lookahead" className="text-content-muted/40">
        {prefix + word}
      </span>
    )
  }

  return (
    <div data-testid="typing-test-view" className="flex w-full min-w-0 flex-col items-center gap-4 px-4 py-4">
      {/* Word display — fixed window with scroll. Word-flow modes show a
          3-line window; imported fileImport text shows 4 lines (line-row layout). */}
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
            // An IME composition starting during romaji mode means the OS
            // IME is on — direct keystrokes won't reach processKeyEvent
            // (see isRomajiInputActive's composition-blocking in
            // useTypingTest). Surface the hint once detected.
            if (romajiGuide) setImeDetected(true)
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
                // (Enter, not Space, advances there) — gated on `realLines`
                // rather than lineWordIdxs' last-word membership in
                // state.lineBreaks, so it can never fire for the synthetic
                // monkeytype rows even in the (real-lines-only) edge case
                // where the very last word happens to be a recorded break.
                // line-indent-* is fileImport-only for the same "no real
                // lines" reason: state.lineIndents stays empty elsewhere.
                lines.map((lineWordIdxs, lineIdx) => (
                  <div key={lineIdx} data-line-row={lineIdx} className="flex flex-wrap gap-x-3">
                    {state.lineIndents[lineIdx] && (
                      // Code indentation, display only — not typed (Space submits
                      // a word, so leading spaces can't be keyed).
                      <span data-testid={`line-indent-${lineIdx}`} className="-mr-3 select-none whitespace-pre text-content-muted/40" aria-hidden="true">{state.lineIndents[lineIdx]}</span>
                    )}
                    {lineWordIdxs.map(renderWord)}
                    {Boolean(realLines) && lineIdx < lines.length - 1 && (
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

      {/* Romaji guide — line-synchronized with the reading window's own
          word lines (real or synthetic — see `guideLines` above): each
          guide line previews the same words that line shows in the reading
          window, anchored to start at the line the current word sits on.
          Falls back to the old single-flow rendering (current word's
          typed/remaining plus a flat lookahead slice of `words`) whenever
          `lines` itself is unmeasured (jsdom, or before first paint) — same
          fallback the reading window uses. Plus an IME-on hint once a
          composition event proves direct keystrokes aren't reaching the
          matcher. The spelling row is gated on `showRow` (lineCount === 0
          hides it), but the IME hint always shows once detected — it's a
          warning about input not landing, which stays relevant even with
          the guide row hidden. Every guide line tracks the Font setting via
          the same --tt-font var as the reading window (romajiGuideStyle —
          deliberately NOT multilineStyle, which also carries the reading
          window's own inline height); the IME hint stays a fixed small size
          since it's a hint, not reading content. The guide row is
          deliberately left un-capped in width (unlike the reading window's
          max-w-4xl above) so a whole romaji line fits on one row without
          wrapping on wide windows, but its left edge is pinned to line up
          with the centered max-w-4xl reading window via the same
          --container-4xl token (pl-[calc((100%-min(var(--container-4xl),100%))/2)]
          clamps to 0 once the pane is at or below that width). */}
      {romajiGuide && (romajiGuide.showRow || imeDetected) && (
        <div data-testid="typing-test-romaji-guide" className="flex w-full flex-col items-start gap-1 pl-[calc((100%-min(var(--container-4xl),100%))/2)] font-mono" style={romajiGuideStyle}>
          {romajiGuide.showRow && (
            guideLines ? (
              guideLines.map((lineWordIdxs, lineIdx) => (
                <p key={lineIdx} data-testid={`typing-test-romaji-guide-line-${lineIdx}`} className="typing-romaji-guide-text">
                  {lineWordIdxs.map((wordIdx, j) => renderGuideWord(romajiGuide, wordIdx, j === 0))}
                </p>
              ))
            ) : (
              <p className="typing-romaji-guide-text break-all">
                <span className="text-success">{romajiGuide.typed}</span>
                <span className="text-content-muted">{romajiGuide.remaining}</span>
                {romajiGuide.words
                  .slice(state.currentWordIndex + 1, state.currentWordIndex + romajiGuide.lineCount)
                  .map((word, i) => (
                    <span key={i} data-testid="typing-test-romaji-lookahead" className="text-content-muted/40">{' ' + word}</span>
                  ))}
              </p>
            )
          )}
          {imeDetected && (
            <p data-testid="typing-test-romaji-ime-hint" className="text-xs text-warning">
              {t('editor.typingTest.romaji.imeHint')}
            </p>
          )}
        </div>
      )}

      {/* State-based controls row, below the reading window:
          - not started (waiting / countdown): Next Test (+ Resume if a run is
            saved for imported fileImport text)
          - in progress (running / paused): Pause or Resume (fileImport) + Restart
          - finished: result name (fileImport) + Next Test
          Next Test and Restart share the same action; only the label differs.
          The "operation" toggle hides this controls row (and the Complete
          message above it), but a finished test always shows it so the
          result can be named and the next test started. */}
      {(!hideControls || state.status === 'finished') && (
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
      )}

      {/* Measurement / results row — below the reading window and the
          Unnamed / Next Test row. Live metrics during a run; before measuring
          (waiting / countdown) every value reads "-". The "measurement" toggle
          hides the LIVE metrics during a run — once finished, the results
          always show. */}
      {(!hideStatsRow || state.status === 'finished') && (
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
      )}

    </div>
  )
}

