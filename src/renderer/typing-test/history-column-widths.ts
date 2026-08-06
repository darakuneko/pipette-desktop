// SPDX-License-Identifier: GPL-2.0-or-later
// Runtime column sizing for the History results table.
//
// The table's non-flexible ("snug") columns must each be exactly as wide
// as their own content IN THE ACTIVE LANGUAGE — no wider. Static widths
// can't do that: any constant sized to the widest built-in pack string
// wastes the difference in every other locale (e.g. a Timeline column
// budgeted for a 7-character katakana label leaves ~60px of dead space
// when the UI shows the 8-character-but-narrower Latin "Timeline"), and
// that waste is width stolen from the only two columns that actually
// need it (Name/Mode, the flexible pair).
//
// So the widths are measured at runtime from the strings the active
// locale actually renders: each snug column takes
//   max(header incl. sort indicator, widest realistic cell value)
//   + cell padding + a small tolerance,
// re-measured when the language changes. Name/Mode carry no width at all
// — under `table-fixed` the columns without a specified width split all
// remaining table width equally between them (the 1:1 flexible pair).
//
// Measurement is DOM-based (a hidden probe span with the table's own
// font classes) so it inherits the real theme font stack. In
// environments without layout (jsdom tests), every probe measures 0 —
// the hook then returns null and the table falls back to static widths,
// keeping component tests meaningful without canvas/layout stubs.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface HistoryColumnWidths {
  date: number
  wpm: number
  kpm: number
  accuracy: number
  akh: number
  duration: number
  pb: number
  timeline: number
  delete: number
}

// px-3 on every td/th → 12px per side.
const CELL_PAD = 24
// Hinting/DPI-scaling variance allowance on top of the measured text.
const TOLERANCE = 6
// Timeline/Delete cells render row buttons with px-2 → 16px of their own.
const BTN_PAD = 16
// The PB row content is a size-3.5 (14px) trophy icon, no text.
const PB_ICON = 14
// Sortable headers append " ▲"/" ▼" to the active column — measured with
// the label so activating a sort never changes the column's width.
const SORT_INDICATOR = ' ▼'
// Width probes for numeric/mono values: the widest realistic rendering of
// each field ('8' is the widest digit in most fonts).
const DATE_SAMPLE = '8888-88-88 88:88:88'
const NUMBER_SAMPLE = '888'
const ACCURACY_SAMPLE = '100%'
const AKH_SAMPLE = '888 ms'
const DURATION_SAMPLE = '88:88'

type Probe = (text: string, mono?: boolean) => number

function measureAll(probe: Probe, t: (key: string) => string): HistoryColumnWidths {
  const sortable = (labelKey: string, sample: number): number =>
    Math.max(probe(t(labelKey) + SORT_INDICATOR), sample) + CELL_PAD + TOLERANCE
  return {
    date: sortable('editor.typingTest.history.date', probe(DATE_SAMPLE)),
    wpm: sortable('editor.typingTest.wpm', probe(NUMBER_SAMPLE, true)),
    kpm: sortable('editor.typingTest.kpm', probe(NUMBER_SAMPLE, true)),
    accuracy: sortable('editor.typingTest.accuracy', probe(ACCURACY_SAMPLE, true)),
    akh: sortable('editor.typingTest.history.avgHoldAbbr', probe(AKH_SAMPLE, true)),
    duration: sortable('editor.typingTest.time', probe(DURATION_SAMPLE, true)),
    pb: Math.max(probe(t('editor.typingTest.history.pb')), PB_ICON) + CELL_PAD + TOLERANCE,
    timeline:
      probe(t('editor.typingTest.history.timeline.linkLabel')) + BTN_PAD + CELL_PAD + TOLERANCE,
    delete: probe(t('common.delete')) + BTN_PAD + CELL_PAD + TOLERANCE,
  }
}

/** Measured per-locale widths for the History table's snug columns, or
 *  `null` when layout measurement is unavailable (jsdom) — callers fall
 *  back to static widths then. Re-measures on language change and once
 *  more when the document's fonts finish loading (a probe measured
 *  against a fallback font before the webfont arrives would under- or
 *  over-shoot). */
export function useHistoryColumnWidths(): HistoryColumnWidths | null {
  const { t, i18n } = useTranslation()
  const [widths, setWidths] = useState<HistoryColumnWidths | null>(null)
  // Bumped once when document.fonts resolves so the effect re-measures
  // against the final font; harmless no-op where the API is missing.
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    document.fonts?.ready.then(() => { if (!cancelled) setFontsReady(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const host = document.createElement('div')
    // Probe container: table font (text-xs), out of flow and invisible.
    host.className = 'fixed top-0 -left-[9999px] whitespace-nowrap text-xs'
    host.setAttribute('aria-hidden', 'true')
    document.body.appendChild(host)
    const probe: Probe = (text, mono) => {
      host.className = `fixed top-0 -left-[9999px] whitespace-nowrap text-xs${mono ? ' font-mono' : ''}`
      host.textContent = text
      return host.getBoundingClientRect().width
    }
    try {
      // jsdom (no layout) measures every string as 0 → fall back.
      if (probe(DATE_SAMPLE) === 0) {
        setWidths(null)
        return
      }
      setWidths(measureAll(probe, t))
    } finally {
      host.remove()
    }
  }, [t, i18n.language, fontsReady])

  return useMemo(() => widths, [widths])
}
