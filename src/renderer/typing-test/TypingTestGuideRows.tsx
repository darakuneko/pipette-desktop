// SPDX-License-Identifier: GPL-2.0-or-later

/** The romaji/kana keystroke-judging guide rows shown below the reading
 *  window (romajiGuide/kanaGuide are mutually exclusive by construction —
 *  see kana-input.ts's isKanaInputActive/romaji-input.ts's
 *  isRomajiInputActive — so at most one of the two rows below ever
 *  renders). Split out of TypingTestView.tsx (file-splitting.md) — this is
 *  pure, self-contained rendering, no state of its own beyond what its
 *  props already carry. */

import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RomajiGuide } from './types'
import type { KanaGuide } from './kana-input'

interface Props {
  isFinished: boolean
  romajiGuide: RomajiGuide | null
  kanaGuide: KanaGuide | null
  imeDetected: boolean
  /** Line-synchronized word-index rows from the reading window (real or
   *  synthetic — see TypingTestView's own `guideLines`), or null when
   *  unmeasured (jsdom, or before first paint) — the romaji row falls back
   *  to its old single-flow rendering in that case. */
  guideLines: number[][] | null
  currentWordIndex: number
  /** Font-size CSS var, tracking the reading window's own Font setting —
   *  see TypingTestView's `romajiGuideStyle`. */
  style: CSSProperties
}

/** Shared wrapper for both guide rows: same outer container (left-edge
 *  pinned to the reading window via `--container-4xl`, see the call
 *  sites' own comments), same showRow/imeDetected gating, and an
 *  identically-shaped IME hint line — only the inner guide content (a
 *  romaji spelling string vs a list of KanaUnit) and the IME hint's i18n
 *  key actually differ between the two engines. */
function GuideRow({ testid, showRow, imeDetected, imeHintTestId, imeHintKey, style, children }: {
  testid: string
  showRow: boolean
  imeDetected: boolean
  imeHintTestId: string
  imeHintKey: string
  style: CSSProperties
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div data-testid={testid} className="flex w-full flex-col items-start gap-1 pl-[calc((100%-min(var(--container-4xl),100%))/2)] font-mono" style={style}>
      {showRow && children}
      {imeDetected && (
        <p data-testid={imeHintTestId} className="text-xs text-warning">
          {t(imeHintKey)}
        </p>
      )}
    </div>
  )
}

/** One word's worth of the line-synchronized romaji guide row — 4-tier
 *  coloring by position relative to the current word: done (dimmed
 *  success tone), current (typed/remaining split), and upcoming (dimmed
 *  muted tone, same `typing-test-romaji-lookahead` testid the flat
 *  fallback below also uses, so both paths satisfy the same selector
 *  contract). `isFirst` suppresses the inter-word leading space for the
 *  first word on a line — words after it get one, same convention the old
 *  lookahead rendering used. */
function renderGuideWord(guide: RomajiGuide, wordIdx: number, isFirst: boolean, currentWordIndex: number) {
  const prefix = isFirst ? '' : ' '
  if (wordIdx === currentWordIndex) {
    return (
      <span key={wordIdx}>
        <span className="text-success">{prefix + guide.typed}</span>
        <span className="text-content-muted">{guide.remaining}</span>
      </span>
    )
  }
  const word = guide.words[wordIdx] ?? ''
  if (wordIdx < currentWordIndex) {
    return <span key={wordIdx} className="text-success/60">{prefix + word}</span>
  }
  return (
    <span key={wordIdx} data-testid="typing-test-romaji-lookahead" className="text-content-muted/40">
      {prefix + word}
    </span>
  )
}

export function TypingTestGuideRows({ isFinished, romajiGuide, kanaGuide, imeDetected, guideLines, currentWordIndex, style }: Props) {
  return (
    <>
      {/* Romaji guide — line-synchronized with the reading window's own
          word lines (real or synthetic — see `guideLines`): each guide
          line previews the same words that line shows in the reading
          window, anchored to start at the line the current word sits on.
          Falls back to the old single-flow rendering (current word's
          typed/remaining plus a flat lookahead slice of `words`) whenever
          `guideLines` itself is unmeasured — same fallback the reading
          window uses. Plus an IME-on hint once a composition event proves
          direct keystrokes aren't reaching the matcher. The spelling row
          is gated on `showRow` (lineCount === 0 hides it), but the IME
          hint always shows once detected — it's a warning about input not
          landing, which stays relevant even with the guide row hidden.
          The guide row is deliberately left un-capped in width (unlike
          the reading window's max-w-4xl) so a whole romaji line fits on
          one row without wrapping on wide windows, but its left edge is
          pinned to line up with the centered max-w-4xl reading window via
          the same --container-4xl token. Hidden once finished, alongside
          the reading window. */}
      {!isFinished && romajiGuide && (romajiGuide.showRow || imeDetected) && (
        <GuideRow
          testid="typing-test-romaji-guide" showRow={romajiGuide.showRow} imeDetected={imeDetected}
          imeHintTestId="typing-test-romaji-ime-hint" imeHintKey="editor.typingTest.romaji.imeHint" style={style}
        >
          {guideLines ? (
            guideLines.map((lineWordIdxs, lineIdx) => (
              <p key={lineIdx} data-testid={`typing-test-romaji-guide-line-${lineIdx}`} className="typing-romaji-guide-text">
                {lineWordIdxs.map((wordIdx, j) => renderGuideWord(romajiGuide, wordIdx, j === 0, currentWordIndex))}
              </p>
            ))
          ) : (
            <p className="typing-romaji-guide-text break-all">
              <span className="text-success">{romajiGuide.typed}</span>
              <span className="text-content-muted">{romajiGuide.remaining}</span>
              {romajiGuide.words
                .slice(currentWordIndex + 1, currentWordIndex + romajiGuide.lineCount)
                .map((word, i) => (
                  <span key={i} data-testid="typing-test-romaji-lookahead" className="text-content-muted/40">{' ' + word}</span>
                ))}
            </p>
          )}
        </GuideRow>
      )}

      {/* Kana stroke guide row — the current word's remaining かな
          characters, muted for a plain stroke and `text-warning` (the same
          token the IME hint below already uses for "needs attention") for
          one whose physical key needs Shift held — see KanaUnit.needsShift.
          Deliberately simpler than the romaji guide row above: a single
          current+lookahead line rather than the full reading-window
          line-synced multi-line layout (`guideLines`/`renderGuideWord`) —
          kana mode's guide content (a handful of かな per word) doesn't need
          that machinery, and mutual exclusivity with romajiGuide means this
          never renders alongside it. Shares GuideRow's outer wrapper with
          the romaji row above (only the inner content differs). */}
      {!isFinished && kanaGuide && (kanaGuide.showRow || imeDetected) && (
        <GuideRow
          testid="typing-test-kana-guide" showRow={kanaGuide.showRow} imeDetected={imeDetected}
          imeHintTestId="typing-test-kana-ime-hint" imeHintKey="editor.typingTest.kana.imeHint" style={style}
        >
          <p className="typing-romaji-guide-text break-all">
            {kanaGuide.remaining.map((unit, i) => (
              <span
                key={i}
                data-testid={unit.needsShift ? 'typing-test-kana-shift-stroke' : undefined}
                className={unit.needsShift ? 'text-warning' : 'text-content-muted'}
              >
                {unit.char}
              </span>
            ))}
            {kanaGuide.words
              .slice(currentWordIndex + 1, currentWordIndex + kanaGuide.lineCount)
              .map((units, i) => (
                <span key={i} data-testid="typing-test-kana-lookahead" className="text-content-muted/40">
                  {' ' + units.map((u) => u.char).join('')}
                </span>
              ))}
          </p>
        </GuideRow>
      )}
    </>
  )
}
