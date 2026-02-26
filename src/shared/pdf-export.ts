// SPDX-License-Identifier: GPL-2.0-or-later
// Generate keymap PDF from current keymap state

import { jsPDF } from 'jspdf'
import type { KleKey } from './kle/types'
import type { AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry } from './types/protocol'
import { filterVisibleKeys, hasSecondaryRect, repositionLayoutKeys } from './kle/filter-keys'
import { computeUnionPolygon, insetAxisAlignedPolygon } from './kle/rect-union'
import {
  arrayBufferToBase64,
  computeBounds,
  applyKeyRotation,
  drawRoundedPolygon,
  formatTimestamp,
  buildFooterText,
  sanitizeLabel,
  SPACING_FRACTION,
  FACE_INSET_FRACTION,
  ROUNDNESS,
  PAGE_WIDTH,
  MARGIN,
  USABLE_WIDTH,
  FOOTER_HEIGHT,
  BORDER_PAD,
} from './pdf-key-draw'

export interface PdfExportInput {
  deviceName: string
  layers: number
  keys: KleKey[]
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  layoutOptions: Map<number, number>
  serializeKeycode: (code: number) => string
  keycodeLabel: (qmkId: string) => string
  isMask: (qmkId: string) => boolean
  findOuterKeycode: (qmkId: string) => { label: string } | undefined
  findInnerKeycode: (qmkId: string) => { label: string } | undefined
  tapDance?: TapDanceEntry[]
  combo?: ComboEntry[]
  keyOverride?: KeyOverrideEntry[]
  altRepeatKey?: AltRepeatKeyEntry[]
  macros?: PdfMacroAction[][]
}

// Structurally compatible with MacroAction from preload/macro.ts
export type PdfMacroAction =
  | { type: 'text'; text: string }
  | { type: 'tap'; keycodes: number[] }
  | { type: 'down'; keycodes: number[] }
  | { type: 'up'; keycodes: number[] }
  | { type: 'delay'; delay: number }

const LAYER_HEADER_HEIGHT = 7

// Font size caps: Math.min(absolute max pt, scale-relative max pt)
const MASKED_LABEL_MAX = 18
const MASKED_LABEL_SCALE = 0.55
const NORMAL_LABEL_MAX = 20
const NORMAL_LABEL_SCALE = 0.65
const ENCODER_DIR_MAX = 14
const ENCODER_DIR_SCALE = 0.45
const ENCODER_LABEL_MAX = 16
const ENCODER_LABEL_SCALE = 0.5

// Latin fallback labels for keycodes whose visual labels contain only non-Latin1 chars
const QMK_ALIAS_FALLBACK: Record<string, string> = {
  KC_LANG1: 'HAEN',
  KC_LANG2: 'HANJ',
}

function pdfKeyLabel(rawLabel: string, qmkId: string): string {
  const sanitized = sanitizeLabel(rawLabel)
  if (sanitized.trim()) return sanitized
  if (!rawLabel) return ''
  return QMK_ALIAS_FALLBACK[qmkId] ?? qmkId.replace(/^KC_/, '')
}

function fitText(doc: jsPDF, text: string, maxWidth: number, maxSize: number): number {
  let size = maxSize
  while (size > 4) {
    doc.setFontSize(size)
    if (doc.getTextWidth(text) <= maxWidth) return size
    size -= 0.5
  }
  return 4
}

function drawKey(
  doc: jsPDF,
  key: KleKey,
  layer: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  input: PdfExportInput,
): void {
  const hasRotation = key.rotation !== 0
  if (hasRotation) {
    doc.saveGraphicsState()
    applyKeyRotation(doc, key, offsetX, offsetY, scale)
  }

  const spacing = scale * SPACING_FRACTION
  const inset = scale * FACE_INSET_FRACTION
  const corner = scale * ROUNDNESS

  // Grid-cell rect (before face inset)
  const gx = offsetX + key.x * scale
  const gy = offsetY + key.y * scale
  const gw = key.width * scale - spacing
  const gh = key.height * scale - spacing

  // Visual face rect (inset from grid cell)
  const x = gx + inset
  const y = gy + inset
  const w = gw - 2 * inset
  const h = gh - 2 * inset

  const code = input.keymap.get(`${layer},${key.row},${key.col}`) ?? 0
  const qmkId = input.serializeKeycode(code)
  const label = input.keycodeLabel(qmkId)
  const masked = input.isMask(qmkId)

  doc.setDrawColor(0)
  doc.setFillColor(255, 255, 255)

  if (hasSecondaryRect(key)) {
    // Union polygon for ISO/stepped keys
    const gx2 = gx + key.x2 * scale
    const gy2 = gy + key.y2 * scale
    const gw2 = key.width2 * scale - spacing
    const gh2 = key.height2 * scale - spacing
    const verts = computeUnionPolygon(gx, gy, gw, gh, gx2, gy2, gw2, gh2)
    if (verts.length > 0) {
      drawRoundedPolygon(doc, insetAxisAlignedPolygon(verts, inset), corner, 'FD')
    } else {
      // Fallback: non-overlapping secondary rect, draw primary rect only
      doc.roundedRect(x, y, w, h, corner, corner, 'FD')
    }
  } else {
    doc.roundedRect(x, y, w, h, corner, corner, 'FD')
  }

  if (masked) {
    // Inner rect for masked keys (modifier + base key)
    const innerPad = scale * 0.05
    const innerX = x + innerPad
    const innerY = y + h * 0.4 + innerPad
    const innerW = Math.max(0, w - innerPad * 2)
    const innerH = Math.max(0, h * 0.6 - innerPad * 2)
    const innerCorner = corner * 0.8

    doc.setFillColor(240, 240, 240)
    doc.roundedRect(innerX, innerY, innerW, innerH, innerCorner, innerCorner, 'FD')

    // Outer label (modifier) in top portion
    const outerLabel = sanitizeLabel(
      input.findOuterKeycode(qmkId)?.label.replace(/\n?\(kc\)$/, '') ?? label,
    )
    const outerSize = fitText(doc, outerLabel, w * 0.9, Math.min(MASKED_LABEL_MAX, scale * MASKED_LABEL_SCALE))
    doc.setFontSize(outerSize)
    doc.setTextColor(0)
    doc.text(outerLabel, x + w / 2, y + h * 0.22, {
      align: 'center',
      baseline: 'middle',
    })

    // Inner label (base key) in inner rect
    const innerLabel = sanitizeLabel(input.findInnerKeycode(qmkId)?.label ?? '')
    if (innerLabel) {
      const innerSize = fitText(doc, innerLabel, innerW * 0.9, Math.min(MASKED_LABEL_MAX, scale * MASKED_LABEL_SCALE))
      doc.setFontSize(innerSize)
      doc.text(innerLabel, x + w / 2, innerY + innerH / 2, {
        align: 'center',
        baseline: 'middle',
      })
    }
  } else {
    // Normal key label (may have \n for multi-line like "!\n1")
    // When sanitization empties all lines (CJK-only labels), fall back to qmkId
    const sanitizedLines = label.split('\n').map(sanitizeLabel)
    const lines = sanitizedLines.some((l) => l.trim())
      ? sanitizedLines
      : [pdfKeyLabel(label, qmkId)]
    doc.setTextColor(0)
    for (let i = 0; i < lines.length; i++) {
      const fontSize = fitText(doc, lines[i], w * 0.9, Math.min(NORMAL_LABEL_MAX, scale * NORMAL_LABEL_SCALE))
      doc.setFontSize(fontSize)
      const lineY = y + (h / (lines.length + 1)) * (i + 1)
      doc.text(lines[i], x + w / 2, lineY, {
        align: 'center',
        baseline: 'middle',
      })
    }
  }

  if (hasRotation) {
    doc.restoreGraphicsState()
  }
}

function drawEncoder(
  doc: jsPDF,
  key: KleKey,
  layer: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  input: PdfExportInput,
): void {
  const hasRotation = key.rotation !== 0
  if (hasRotation) {
    doc.saveGraphicsState()
    applyKeyRotation(doc, key, offsetX, offsetY, scale)
  }

  const spacing = scale * SPACING_FRACTION
  const cx = offsetX + key.x * scale + (key.width * scale - spacing) / 2
  const cy = offsetY + key.y * scale + (key.height * scale - spacing) / 2
  const r = Math.min(key.width, key.height) * scale / 2 - spacing / 2

  doc.setDrawColor(0)
  doc.setFillColor(255, 255, 255)
  doc.circle(cx, cy, r, 'FD')

  // encoderDir: 0=CW, 1=CCW
  const code = input.encoderLayout.get(`${layer},${key.encoderIdx},${key.encoderDir}`) ?? 0
  const qmkId = input.serializeKeycode(code)
  const label = pdfKeyLabel(input.keycodeLabel(qmkId), qmkId)
  const dirLabel = key.encoderDir === 0 ? 'CW' : 'CCW'

  doc.setTextColor(0)

  // Direction label on top
  const dirSize = fitText(doc, dirLabel, r * 1.6, Math.min(ENCODER_DIR_MAX, scale * ENCODER_DIR_SCALE))
  doc.setFontSize(dirSize)
  doc.text(dirLabel, cx, cy - r * 0.3, { align: 'center', baseline: 'middle' })

  // Key label on bottom
  const labelSize = fitText(doc, label, r * 1.6, Math.min(ENCODER_LABEL_MAX, scale * ENCODER_LABEL_SCALE))
  doc.setFontSize(labelSize)
  doc.text(label, cx, cy + r * 0.3, { align: 'center', baseline: 'middle' })

  if (hasRotation) {
    doc.restoreGraphicsState()
  }
}

// ── Summary page helpers ──────────────────────────────────────────────

/** Summary page height: A4 landscape height */
const SUMMARY_PAGE_HEIGHT = 210
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
const SECTION_HEADER_SIZE = 12
const SECTION_HEADER_HEIGHT = 8

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

  const comboCardHeight = 10
  const grid = createCardGrid(doc, 'Combos', COMBO_COLUMNS, comboCardHeight)

  for (const combo of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, comboCardHeight)

    // Draw key badges inside card
    doc.setFont('helvetica', 'normal')
    let badgeX = cardX + CARD_PADDING
    const badgeY = grid.curY + (comboCardHeight - BADGE_HEIGHT) / 2
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
  const grid = createCardGrid(doc, 'Tap Dance', TD_COLUMNS, tdCardHeight)

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

  const arCardHeight = 10
  const grid = createCardGrid(doc, 'Alt Repeat Keys', AR_COLUMNS, arCardHeight)

  for (const { ar, idx } of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, arCardHeight, ar.enabled)

    // Draw AR index badge + last key -> alt key
    doc.setFont('helvetica', 'normal')
    let badgeX = cardX + CARD_PADDING
    const badgeY = grid.curY + (arCardHeight - BADGE_HEIGHT) / 2
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

  const macroCardHeight = 10
  const grid = createCardGrid(doc, 'Macros', MACRO_COLUMNS, macroCardHeight)

  for (const { actions, idx } of configured) {
    const cardX = grid.nextCard()

    drawCardRect(doc, cardX, grid.curY, grid.cardWidth, macroCardHeight)

    doc.setFont('helvetica', 'normal')
    let badgeX = cardX + CARD_PADDING
    const badgeY = grid.curY + (macroCardHeight - BADGE_HEIGHT) / 2
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
          if (action.type !== 'tap') {
            const prefix = action.type === 'down' ? 'Dn:' : 'Up:'
            doc.setFontSize(BADGE_FONT_SIZE)
            doc.setTextColor(120)
            doc.text(prefix, badgeX, badgeMidY, { baseline: 'middle' })
            badgeX += doc.getTextWidth(prefix) + 0.5
          }
          for (const kc of action.keycodes) {
            if (badgeX >= maxX - 5) break
            const w = drawKeyBadge(doc, pdfKeycodeLabel(kc, input), badgeX, badgeY)
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

export function generateKeymapPdf(input: PdfExportInput): string {
  const visibleKeys = filterVisibleKeys(
    repositionLayoutKeys(input.keys, input.layoutOptions),
    input.layoutOptions,
  )
  const normalKeys = visibleKeys.filter((k) => k.encoderIdx === -1)
  const encoderKeys = visibleKeys.filter((k) => k.encoderIdx !== -1)

  const bounds = computeBounds(visibleKeys)
  if (bounds.width === 0 || bounds.height === 0) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const emptyPageHeight = 210 // A4 landscape height
    const footerText = buildFooterText(input.deviceName, formatTimestamp(new Date()))
    const emptyPageHeights: number[] = [emptyPageHeight]

    if (input.combo) {
      emptyPageHeights.push(...drawComboPages(doc, input.combo, input))
    }
    if (input.tapDance) {
      emptyPageHeights.push(...drawTapDancePages(doc, input.tapDance, input))
    }
    if (input.keyOverride) {
      emptyPageHeights.push(...drawKeyOverridePages(doc, input.keyOverride, input))
    }
    if (input.altRepeatKey) {
      emptyPageHeights.push(...drawAltRepeatKeyPages(doc, input.altRepeatKey, input))
    }
    if (input.macros) {
      emptyPageHeights.push(...drawMacroPages(doc, input.macros, input))
    }

    const totalPages = doc.getNumberOfPages()
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7)
      doc.setTextColor(150)
      const h = emptyPageHeights[p - 1] ?? emptyPageHeight
      doc.text(footerText, PAGE_WIDTH / 2, h - MARGIN, { align: 'center' })
    }
    return arrayBufferToBase64(doc.output('arraybuffer'))
  }

  // Scale keyboard to fit usable page width, capped so page height stays reasonable
  const MAX_PAGE_HEIGHT = PAGE_WIDTH // cap at square page to avoid jsPDF orientation swap
  const maxContentHeight = MAX_PAGE_HEIGHT - MARGIN * 2 - LAYER_HEADER_HEIGHT - FOOTER_HEIGHT - BORDER_PAD * 2
  const scale = Math.min(
    USABLE_WIDTH / bounds.width,
    maxContentHeight / bounds.height,
  )
  // Visual keyboard dimensions (keys are visually smaller due to inter-key spacing)
  const spacing = scale * SPACING_FRACTION
  const visualW = bounds.width * scale - spacing
  const visualH = bounds.height * scale - spacing

  const borderW = visualW + BORDER_PAD * 2
  const borderH = visualH + BORDER_PAD * 2
  const borderX = (PAGE_WIDTH - borderW) / 2
  const borderY = MARGIN + LAYER_HEADER_HEIGHT
  const keysOffsetX = borderX + BORDER_PAD - bounds.minX * scale
  const keysOffsetY = borderY + BORDER_PAD - bounds.minY * scale

  // Dynamic page height: fits exactly one layer with minimal whitespace
  const pageHeight = MARGIN + LAYER_HEADER_HEIGHT + borderH + FOOTER_HEIGHT + MARGIN

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: [PAGE_WIDTH, pageHeight],
  })

  const footerText = buildFooterText(input.deviceName, formatTimestamp(new Date()))

  for (let layer = 0; layer < input.layers; layer++) {
    if (layer > 0) {
      doc.addPage()
    }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(0)
    doc.text(`Layer ${layer}`, borderX, MARGIN + 5)

    // Outer border around keymap
    doc.setDrawColor(180)
    doc.setLineWidth(0.3)
    doc.roundedRect(borderX, borderY, borderW, borderH, 1.5, 1.5, 'S')

    doc.setFont('helvetica', 'normal')

    for (const key of normalKeys) {
      drawKey(doc, key, layer, keysOffsetX, keysOffsetY, scale, input)
    }

    for (const key of encoderKeys) {
      drawEncoder(doc, key, layer, keysOffsetX, keysOffsetY, scale, input)
    }
  }

  // Track per-page heights: layer pages use dynamic pageHeight, summary pages use SUMMARY_PAGE_HEIGHT
  const layerPageCount = doc.getNumberOfPages()
  const perPageHeights: number[] = Array(layerPageCount).fill(pageHeight) as number[]

  // Append combo pages (if any)
  if (input.combo) {
    const comboHeights = drawComboPages(doc, input.combo, input)
    perPageHeights.push(...comboHeights)
  }

  // Append tap dance pages (if any)
  if (input.tapDance) {
    const tdHeights = drawTapDancePages(doc, input.tapDance, input)
    perPageHeights.push(...tdHeights)
  }

  // Append key override pages (if any)
  if (input.keyOverride) {
    const koHeights = drawKeyOverridePages(doc, input.keyOverride, input)
    perPageHeights.push(...koHeights)
  }

  // Append alt repeat key pages (if any)
  if (input.altRepeatKey) {
    const arHeights = drawAltRepeatKeyPages(doc, input.altRepeatKey, input)
    perPageHeights.push(...arHeights)
  }

  // Append macro pages (if any)
  if (input.macros) {
    const macroHeights = drawMacroPages(doc, input.macros, input)
    perPageHeights.push(...macroHeights)
  }

  // Footer on each page (using per-page heights for correct Y positioning)
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(150)
    const h = perPageHeights[p - 1] ?? pageHeight
    doc.text(footerText, PAGE_WIDTH / 2, h - MARGIN, { align: 'center' })
  }

  return arrayBufferToBase64(doc.output('arraybuffer'))
}
