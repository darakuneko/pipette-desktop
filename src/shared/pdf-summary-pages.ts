// SPDX-License-Identifier: GPL-2.0-or-later
// Summary-page drawing for keymap PDF export (combos, tap dance, key overrides, alt repeat keys, macros)

import { jsPDF } from 'jspdf'
import type { AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry } from './types/protocol'
import { sanitizeLabel, PAGE_WIDTH, MARGIN, USABLE_WIDTH, FOOTER_HEIGHT } from './pdf-key-draw'
import type { PdfExportInput, PdfMacroAction } from './pdf-export'

// ── Constants ────────────────────────────────────────────────────────

/** Summary page height: A4 landscape height */
export const SUMMARY_PAGE_HEIGHT = 210
const CARD_GAP = 3
const CARD_PADDING = 2.5
const CARD_CORNER = 1.5
const BADGE_CORNER = 0.8
const BADGE_PADDING_X = 1.5
const BADGE_PADDING_Y = 0.8
const BADGE_FONT_SIZE = 7
const BADGE_HEIGHT = BADGE_FONT_SIZE * 0.353 + BADGE_PADDING_Y * 2 // pt to mm
const COMBO_COLUMNS = 2
const TD_COLUMNS = 3
const TD_ROW_HEIGHT = 5
const KO_COLUMNS = 3
const KO_ROW_HEIGHT = 5
const AR_COLUMNS = 2
const MACRO_COLUMNS = 2
const SINGLE_ROW_CARD_HEIGHT = 10
const SECTION_HEADER_SIZE = 12
const SECTION_HEADER_HEIGHT = 8

// ── Card grid ────────────────────────────────────────────────────────

/**
 * Manages paginated card-grid layout for summary pages.
 * Handles page creation, column wrapping, and overflow pagination.
 */
interface CardGrid {
  /** Current Y offset for the active row */
  curY: number
  /** Computed card width based on columns and usable width */
  cardWidth: number
  /** Per-page heights for footer positioning */
  pageHeights: number[]
  /** Advance to the next card slot, paginating if needed. Returns the card X position. */
  nextCard(): number
}

function createCardGrid(
  doc: jsPDF,
  title: string,
  columns: number,
  cardHeight: number,
): CardGrid {
  const cardWidth = (USABLE_WIDTH - CARD_GAP * (columns - 1)) / columns
  const pageHeights: number[] = []
  let curY = 0
  let col = 0

  function startPage(continued: boolean): void {
    doc.addPage([PAGE_WIDTH, SUMMARY_PAGE_HEIGHT])
    pageHeights.push(SUMMARY_PAGE_HEIGHT)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(SECTION_HEADER_SIZE)
    doc.setTextColor(0)
    doc.text(continued ? `${title} (cont.)` : title, MARGIN, MARGIN + 5)
    curY = MARGIN + SECTION_HEADER_HEIGHT
    col = 0
  }

  startPage(false)

  return {
    get curY() { return curY },
    cardWidth,
    pageHeights,
    nextCard(): number {
      if (col >= columns) {
        curY += cardHeight + CARD_GAP
        col = 0
      }
      if (curY + cardHeight > SUMMARY_PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT) {
        startPage(true)
      }
      const cardX = MARGIN + col * (cardWidth + CARD_GAP)
      col++
      return cardX
    },
  }
}

// ── Shared drawing helpers ───────────────────────────────────────────

/**
 * Draw a card background rectangle with optional enabled/disabled fill.
 */
function drawCardRect(
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  height: number,
  enabled = true,
): void {
  const fill = enabled ? 255 : 245
  doc.setFillColor(fill, fill, fill)
  doc.setDrawColor(200)
  doc.setLineWidth(0.2)
  doc.roundedRect(x, y, width, height, CARD_CORNER, CARD_CORNER, 'FD')
}

const MOD_NAMES: [number, string][] = [
  [1 << 0, 'LCtrl'],
  [1 << 1, 'LShift'],
  [1 << 2, 'LAlt'],
  [1 << 3, 'LGUI'],
  [1 << 4, 'RCtrl'],
  [1 << 5, 'RShift'],
  [1 << 6, 'RAlt'],
  [1 << 7, 'RGUI'],
]

function formatMods(mods: number): string {
  if (mods === 0) return ''
  return MOD_NAMES
    .filter(([bit]) => (mods & bit) !== 0)
    .map(([, name]) => name)
    .join('+')
}

function pdfKeycodeLabel(code: number, input: PdfExportInput): string {
  const qmkId = input.serializeKeycode(code)
  const label = input.keycodeLabel(qmkId)
  const sanitized = sanitizeLabel(label.split('\n')[0])
  if (sanitized.trim()) return sanitized
  return sanitizeLabel(qmkId.replace(/^KC_/, ''))
}

/**
 * Keycode-name-based label for macro badges. Shows full QMK name (e.g. LCTL_T(KC_3))
 * instead of the visual key cap label, matching pipette-hub's macro card format.
 */
function pdfMacroLabel(code: number, input: PdfExportInput): string {
  const qmkId = input.serializeKeycode(code)
  return sanitizeLabel(qmkId.startsWith('KC_') ? qmkId.slice(3) : qmkId)
}

/**
 * Draw a key badge (rounded rect + centered label). Returns badge width.
 */
function drawKeyBadge(
  doc: jsPDF,
  label: string,
  x: number,
  y: number,
  fillColor: [number, number, number] = [0xF1, 0xF5, 0xF9],
  textColor: [number, number, number] = [0, 0, 0],
): number {
  doc.setFontSize(BADGE_FONT_SIZE)
  const textW = doc.getTextWidth(label)
  const badgeW = textW + BADGE_PADDING_X * 2

  doc.setFillColor(...fillColor)
  doc.setDrawColor(200)
  doc.setLineWidth(0.15)
  doc.roundedRect(x, y, badgeW, BADGE_HEIGHT, BADGE_CORNER, BADGE_CORNER, 'FD')

  doc.setTextColor(...textColor)
  doc.text(label, x + badgeW / 2, y + BADGE_HEIGHT / 2, { align: 'center', baseline: 'middle' })

  return badgeW
}

// ── Empty-entry predicates ───────────────────────────────────────────

export function isEmptyMacro(actions: PdfMacroAction[]): boolean {
  return actions.length === 0
}

export function isEmptyCombo(entry: ComboEntry): boolean {
  return entry.key1 === 0 && entry.key2 === 0 && entry.key3 === 0 && entry.key4 === 0 && entry.output === 0
}

export function isEmptyTapDance(entry: TapDanceEntry): boolean {
  return entry.onTap === 0 && entry.onHold === 0 && entry.onDoubleTap === 0 && entry.onTapHold === 0
}

export function isEmptyKeyOverride(entry: KeyOverrideEntry): boolean {
  return entry.triggerKey === 0 && entry.replacementKey === 0
}

export function isEmptyAltRepeatKey(entry: AltRepeatKeyEntry): boolean {
  return entry.lastKey === 0 && entry.altKey === 0
}

// ── Section page renderers ───────────────────────────────────────────

/**
 * Draw combo pages. Returns page heights for footer positioning.
 */
function drawComboPages(
  doc: jsPDF,
  combos: ComboEntry[],
  input: PdfExportInput,
): number[] {
  const configured = combos.filter((c) => !isEmptyCombo(c))
  if (configured.length === 0) return []

  const grid = createCardGrid(doc, 'Combos', COMBO_COLUMNS, SINGLE_ROW_CARD_HEIGHT)

  for (const combo of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, SINGLE_ROW_CARD_HEIGHT)

    // Draw key badges inside card
    doc.setFont('helvetica', 'normal')
    let badgeX = cardX + CARD_PADDING
    const badgeY = grid.curY + (SINGLE_ROW_CARD_HEIGHT - BADGE_HEIGHT) / 2
    const badgeMidY = badgeY + BADGE_HEIGHT / 2

    const keys = [combo.key1, combo.key2, combo.key3, combo.key4].filter((k) => k !== 0)
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) {
        doc.setFontSize(BADGE_FONT_SIZE)
        doc.setTextColor(150)
        doc.text('+', badgeX + 1.5, badgeMidY, { align: 'center', baseline: 'middle' })
        badgeX += 3
      }
      const label = pdfKeycodeLabel(keys[i], input)
      const w = drawKeyBadge(doc, label, badgeX, badgeY)
      badgeX += w + 1
    }

    // Arrow separator
    doc.setFontSize(BADGE_FONT_SIZE)
    doc.setTextColor(150)
    doc.text('->', badgeX + 1.5, badgeMidY, { align: 'center', baseline: 'middle' })
    badgeX += 5

    // Output key badge
    drawKeyBadge(doc, pdfKeycodeLabel(combo.output, input), badgeX, badgeY)
  }

  return grid.pageHeights
}

/**
 * Draw tap dance pages. Returns page heights for footer positioning.
 */
function drawTapDancePages(
  doc: jsPDF,
  tapDances: TapDanceEntry[],
  input: PdfExportInput,
): number[] {
  const configured = tapDances
    .map((td, idx) => ({ td, idx }))
    .filter(({ td }) => !isEmptyTapDance(td))
  if (configured.length === 0) return []

  const tdCardHeight = TD_ROW_HEIGHT * 5 + CARD_PADDING * 2 // header + 4 rows + padding
  const grid = createCardGrid(doc, 'Tap-Hold / Tap Dance', TD_COLUMNS, tdCardHeight)

  for (const { td, idx } of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, tdCardHeight)

    // Header row: TD index badge + tapping term
    const headerY = grid.curY + CARD_PADDING
    drawKeyBadge(doc, `TD${idx}`, cardX + CARD_PADDING, headerY, [0x1E, 0x29, 0x3B], [255, 255, 255])

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(BADGE_FONT_SIZE)
    doc.setTextColor(120)
    doc.text(`${td.tappingTerm}ms`, cardX + CARD_PADDING + 18, headerY + BADGE_HEIGHT / 2, { baseline: 'middle' })

    // Action rows
    const actions: [string, number][] = [
      ['Tap:', td.onTap],
      ['Hold:', td.onHold],
      ['DblTap:', td.onDoubleTap],
      ['TpHold:', td.onTapHold],
    ]

    for (let i = 0; i < actions.length; i++) {
      const rowY = headerY + (i + 1) * TD_ROW_HEIGHT
      const [rowLabel, keycode] = actions[i]

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(BADGE_FONT_SIZE)
      doc.setTextColor(120)
      doc.text(rowLabel, cardX + CARD_PADDING, rowY + TD_ROW_HEIGHT / 2, { baseline: 'middle' })

      if (keycode !== 0) {
        drawKeyBadge(doc, pdfKeycodeLabel(keycode, input), cardX + CARD_PADDING + 18, rowY + (TD_ROW_HEIGHT - BADGE_HEIGHT) / 2)
      }
    }
  }

  return grid.pageHeights
}

// ── Key Override / Alt Repeat Key drawing ──────────────────────────

/**
 * Draw key override pages. Returns page heights for footer positioning.
 */
function drawKeyOverridePages(
  doc: jsPDF,
  entries: KeyOverrideEntry[],
  input: PdfExportInput,
): number[] {
  const configured = entries
    .map((ko, idx) => ({ ko, idx }))
    .filter(({ ko }) => !isEmptyKeyOverride(ko))
  if (configured.length === 0) return []

  const koCardHeight = KO_ROW_HEIGHT * 3 + CARD_PADDING * 2 // header + 2 rows + padding
  const grid = createCardGrid(doc, 'Key Overrides', KO_COLUMNS, koCardHeight)

  for (const { ko, idx } of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, koCardHeight, ko.enabled)

    // Header row: KO index badge + enabled status
    const headerY = grid.curY + CARD_PADDING
    drawKeyBadge(doc, `KO${idx}`, cardX + CARD_PADDING, headerY, [0x1E, 0x29, 0x3B], [255, 255, 255])

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(BADGE_FONT_SIZE)
    doc.setTextColor(ko.enabled ? 100 : 180)
    doc.text(ko.enabled ? 'Enabled' : 'Disabled', cardX + CARD_PADDING + 18, headerY + BADGE_HEIGHT / 2, { baseline: 'middle' })

    // Trigger row: key + mods
    const triggerY = headerY + KO_ROW_HEIGHT
    doc.setTextColor(120)
    doc.text('Trigger:', cardX + CARD_PADDING, triggerY + KO_ROW_HEIGHT / 2, { baseline: 'middle' })
    let trigBadgeX = cardX + CARD_PADDING + 18
    if (ko.triggerKey !== 0) {
      const w = drawKeyBadge(doc, pdfKeycodeLabel(ko.triggerKey, input), trigBadgeX, triggerY + (KO_ROW_HEIGHT - BADGE_HEIGHT) / 2)
      trigBadgeX += w + 1
    }
    const modsStr = formatMods(ko.triggerMods)
    if (modsStr) {
      doc.setFontSize(BADGE_FONT_SIZE)
      doc.setTextColor(150)
      doc.text(`+ ${modsStr}`, trigBadgeX + 1, triggerY + KO_ROW_HEIGHT / 2, { baseline: 'middle' })
    }

    // Replacement row
    const replaceY = triggerY + KO_ROW_HEIGHT
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(BADGE_FONT_SIZE)
    doc.setTextColor(120)
    doc.text('Output:', cardX + CARD_PADDING, replaceY + KO_ROW_HEIGHT / 2, { baseline: 'middle' })
    if (ko.replacementKey !== 0) {
      drawKeyBadge(doc, pdfKeycodeLabel(ko.replacementKey, input), cardX + CARD_PADDING + 18, replaceY + (KO_ROW_HEIGHT - BADGE_HEIGHT) / 2)
    }
  }

  return grid.pageHeights
}

/**
 * Draw alt repeat key pages. Returns page heights for footer positioning.
 */
function drawAltRepeatKeyPages(
  doc: jsPDF,
  entries: AltRepeatKeyEntry[],
  input: PdfExportInput,
): number[] {
  const configured = entries
    .map((ar, idx) => ({ ar, idx }))
    .filter(({ ar }) => !isEmptyAltRepeatKey(ar))
  if (configured.length === 0) return []

  const grid = createCardGrid(doc, 'Alt Repeat Keys', AR_COLUMNS, SINGLE_ROW_CARD_HEIGHT)

  for (const { ar, idx } of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, SINGLE_ROW_CARD_HEIGHT, ar.enabled)

    // Draw AR index badge + last key -> alt key
    doc.setFont('helvetica', 'normal')
    let badgeX = cardX + CARD_PADDING
    const badgeY = grid.curY + (SINGLE_ROW_CARD_HEIGHT - BADGE_HEIGHT) / 2
    const badgeMidY = badgeY + BADGE_HEIGHT / 2

    const w0 = drawKeyBadge(doc, `AR${idx}`, badgeX, badgeY, [0x1E, 0x29, 0x3B], [255, 255, 255])
    badgeX += w0 + 2

    if (ar.lastKey !== 0) {
      const w = drawKeyBadge(doc, pdfKeycodeLabel(ar.lastKey, input), badgeX, badgeY)
      badgeX += w + 1
    }

    const modsStr = formatMods(ar.allowedMods)
    if (modsStr) {
      const modsText = `+ ${modsStr}`
      doc.setFontSize(BADGE_FONT_SIZE)
      doc.setTextColor(150)
      doc.text(modsText, badgeX + 1, badgeMidY, { baseline: 'middle' })
      badgeX += doc.getTextWidth(modsText) + 2
    }

    // Arrow separator
    doc.setFontSize(BADGE_FONT_SIZE)
    doc.setTextColor(150)
    doc.text('->', badgeX + 1.5, badgeMidY, { align: 'center', baseline: 'middle' })
    badgeX += 5

    if (ar.altKey !== 0) {
      drawKeyBadge(doc, pdfKeycodeLabel(ar.altKey, input), badgeX, badgeY)
    }

    if (!ar.enabled) {
      doc.setFontSize(BADGE_FONT_SIZE)
      doc.setTextColor(180)
      doc.text('(off)', cardX + grid.cardWidth - CARD_PADDING, badgeMidY, { align: 'right', baseline: 'middle' })
    }
  }

  return grid.pageHeights
}

// ── Macro drawing ─────────────────────────────────────────────────

/**
 * Draw macro pages. Returns page heights for footer positioning.
 * Each macro is rendered as a single-row card with M{idx} badge and inline actions.
 */
function drawMacroPages(
  doc: jsPDF,
  macros: PdfMacroAction[][],
  input: PdfExportInput,
): number[] {
  const configured = macros
    .map((actions, idx) => ({ actions, idx }))
    .filter(({ actions }) => !isEmptyMacro(actions))
  if (configured.length === 0) return []

  const grid = createCardGrid(doc, 'Macros', MACRO_COLUMNS, SINGLE_ROW_CARD_HEIGHT)

  for (const { actions, idx } of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, SINGLE_ROW_CARD_HEIGHT)

    doc.setFont('helvetica', 'normal')
    let badgeX = cardX + CARD_PADDING
    const badgeY = grid.curY + (SINGLE_ROW_CARD_HEIGHT - BADGE_HEIGHT) / 2
    const badgeMidY = badgeY + BADGE_HEIGHT / 2
    const maxX = cardX + grid.cardWidth - CARD_PADDING

    // M{idx} badge
    const w0 = drawKeyBadge(doc, `M${idx}`, badgeX, badgeY, [0x1E, 0x29, 0x3B], [255, 255, 255])
    badgeX += w0 + 2

    // Render actions inline with truncation
    for (const action of actions) {
      if (badgeX >= maxX - 5) {
        doc.setFontSize(BADGE_FONT_SIZE)
        doc.setTextColor(150)
        doc.text('...', badgeX, badgeMidY, { baseline: 'middle' })
        break
      }

      switch (action.type) {
        case 'text': {
          const quoted = `"${sanitizeLabel(action.text)}"`
          doc.setFontSize(BADGE_FONT_SIZE)
          doc.setFont('helvetica', 'italic')
          doc.setTextColor(80)
          doc.text(quoted, badgeX, badgeMidY, { baseline: 'middle' })
          badgeX += doc.getTextWidth(quoted) + 2
          doc.setFont('helvetica', 'normal')
          break
        }
        case 'tap':
        case 'down':
        case 'up': {
          const prefixMap = { tap: 'Tap:', down: 'Dn:', up: 'Up:' } as const
          const prefix = prefixMap[action.type]
          doc.setFontSize(BADGE_FONT_SIZE)
          doc.setTextColor(120)
          doc.text(prefix, badgeX, badgeMidY, { baseline: 'middle' })
          badgeX += doc.getTextWidth(prefix) + 0.5
          for (const kc of action.keycodes) {
            if (badgeX >= maxX - 5) break
            const w = drawKeyBadge(doc, pdfMacroLabel(kc, input), badgeX, badgeY)
            badgeX += w + 1
          }
          break
        }
        case 'delay': {
          const delayText = `${action.delay}ms`
          doc.setFontSize(BADGE_FONT_SIZE)
          doc.setTextColor(120)
          doc.text(delayText, badgeX, badgeMidY, { baseline: 'middle' })
          badgeX += doc.getTextWidth(delayText) + 2
          break
        }
      }
    }
  }

  return grid.pageHeights
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Append summary section pages (combos, tap dance, key overrides, alt repeat keys, macros).
 * Each draw function adds pages to the doc and returns per-page heights.
 */
export function appendSummaryPages(
  doc: jsPDF,
  input: PdfExportInput,
  pageHeights: number[],
): void {
  if (input.tapDance) {
    pageHeights.push(...drawTapDancePages(doc, input.tapDance, input))
  }
  if (input.macros) {
    pageHeights.push(...drawMacroPages(doc, input.macros, input))
  }
  if (input.combo) {
    pageHeights.push(...drawComboPages(doc, input.combo, input))
  }
  if (input.altRepeatKey) {
    pageHeights.push(...drawAltRepeatKeyPages(doc, input.altRepeatKey, input))
  }
  if (input.keyOverride) {
    pageHeights.push(...drawKeyOverridePages(doc, input.keyOverride, input))
  }
}

/**
 * Render footer text on every page, using per-page heights for correct Y positioning.
 */
export function renderFooters(
  doc: jsPDF,
  footerText: string,
  pageHeights: number[],
  fallbackHeight: number,
): void {
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(150)
    const h = pageHeights[p - 1] ?? fallbackHeight
    doc.text(footerText, PAGE_WIDTH / 2, h - MARGIN, { align: 'center' })
  }
}
